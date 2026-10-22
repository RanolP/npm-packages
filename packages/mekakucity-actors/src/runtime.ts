import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { ActorBackend, ActorDescriptor, ActorRecord, InMemoryBackend, OutboxMessage } from "./backend.js";
import { actionNameOf, metadataFor, setActionRuntime } from "./decorators.js";
import { ActorInput, ActorRef, ActorRefInit } from "./types.js";

type Constructor<T extends Actor<unknown, unknown>> = new (input: any) => T;
type StateData = Record<string, unknown>;
type ActionMethod = (...args: unknown[]) => unknown;

export class ActorRuntimeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class NoActiveTransactionError extends ActorRuntimeError {
  constructor(operation: string) {
    super(`${operation} requires an active Actor.transaction()`);
  }
}

export class ActorStateSerializationError extends ActorRuntimeError {
  constructor(actorId: string, cause: unknown) {
    super(`Actor ${actorId} state must be structuredClone-serializable`, { cause });
  }
}

export class ActorResultSerializationError extends ActorRuntimeError {
  constructor(actorId: string, actionName: string, cause: unknown) {
    super(`Result from actor ${actorId}.${actionName} must be structured-clone-safe; non-plain prototypes are not preserved`, { cause });
  }
}

export class ActorCompensationError extends AggregateError {
  constructor(errors: readonly unknown[], cause: unknown) {
    super(errors, "One or more actor compensations failed", { cause });
    this.name = new.target.name;
  }
}

export class ActorReentrancyError extends ActorRuntimeError {
  constructor(actorId: string) {
    super(`Actor ${actorId} was re-entered by a suspended call chain`);
  }
}

export class ActorKilledError extends ActorRuntimeError {
  constructor(actorId: string) {
    super(`Actor ${actorId} has been killed`);
  }
}

export class ActorSnapshotUnavailableError extends ActorRuntimeError {
  constructor(actorId: string) {
    super(`Actor ${actorId} has no cached snapshot; call Actor.refreshValues(ref) first`);
  }
}

interface Compensation {
  readonly actorId: string;
  readonly action: string;
  readonly args: readonly unknown[];
}

interface RootTransaction {
  readonly id: string;
  readonly backend: ActorBackend;
  readonly compensations: Compensation[];
  readonly outbox: OutboxMessage[];
  readonly pendingHolds: Promise<void>[];
  readonly ownedIds: Set<string>;
}

interface ActionFrame {
  readonly record: ActorRecord;
  readonly root: RootTransaction;
  readonly parent?: ActionFrame;
  readonly chain: Set<string>;
  readonly startVersion: number;
  readonly initialState: StateData;
  readonly compensations: Compensation[];
  readonly outbox: OutboxMessage[];
  baseline: StateData;
}

interface ExecutionContext {
  readonly root: RootTransaction;
  readonly frame?: ActionFrame;
  readonly chain: Set<string>;
  readonly compensation?: { readonly outbox: OutboxMessage[] };
}

interface SnapshotEntry {
  version: number;
  data?: Readonly<StateData>;
  references: number;
}

interface ActionReply {
  readonly value: unknown;
  readonly baseVersion: number;
  readonly startVersion: number;
  readonly version: number;
  readonly isDiff: boolean;
  readonly snapshot: Readonly<StateData>;
}

interface RefObject extends ActorDescriptor {
  [key: string]: unknown;
}

const execution = new AsyncLocalStorage<ExecutionContext>();
const defaultBackend = new InMemoryBackend();
const snapshotCache = new Map<string, SnapshotEntry>();
const knownTypes = new Map<string, Constructor<Actor<unknown, unknown>>>();
const namedCreations = new Map<string, Promise<unknown>>();
const instanceIds = new WeakMap<object, string>();
const refs = new WeakSet<object>();
const typeIds = new WeakMap<Function, string>();
const refFinalizer = new FinalizationRegistry<string>((id) => {
  const entry = snapshotCache.get(id);
  if (!entry) return;
  entry.references -= 1;
  if (entry.references <= 0) snapshotCache.delete(id);
});

let actorSequence = 0;
let transactionSequence = 0;
let messageSequence = 0;
let lastReplyForTest: ActionReply | undefined;

function current(operation: string): ExecutionContext {
  const context = execution.getStore();
  if (!context) throw new NoActiveTransactionError(operation);
  return context;
}

function typeName(ctor: Function): string {
  let id = typeIds.get(ctor);
  if (!id) {
    id = ctor.name || `ActorType${knownTypes.size + 1}`;
    typeIds.set(ctor, id);
  }
  return id;
}

function stateFields(record: ActorRecord): string[] {
  return [...metadataFor(record.instance).state];
}

function cloneOrThrow<T>(value: T, errorFactory: (cause: unknown) => Error): T {
  try {
    return structuredClone(value);
  } catch (cause) {
    throw errorFactory(cause);
  }
}

function cloneState(record: ActorRecord): StateData {
  const data: StateData = {};
  for (const key of stateFields(record)) data[key] = (record.instance as Record<string, unknown>)[key];
  return cloneOrThrow(data, (cause) => new ActorStateSerializationError(record.id, cause));
}

function cloneActionResult<Value>(record: ActorRecord, actionName: string, value: Value): Value {
  try {
    assertCloneableResultPrototypes(value);
  } catch (cause) {
    throw new ActorResultSerializationError(record.id, actionName, cause);
  }
  return cloneOrThrow(value, (cause) => new ActorResultSerializationError(record.id, actionName, cause));
}

function restoreState(record: ActorRecord, state: StateData): void {
  for (const key of stateFields(record)) {
    if (Object.hasOwn(state, key)) (record.instance as Record<string, unknown>)[key] = hydrateRefs(state[key]);
  }
}

function createSnapshot(record: ActorRecord): { state: StateData; data: Readonly<StateData> } {
  const state = cloneState(record);
  const full: StateData = { ...state };
  for (const key of metadataFor(record.instance).derived) {
    full[key] = (record.instance as Record<string, unknown>)[key];
  }
  const cloned = cloneOrThrow(full, (cause) => new ActorStateSerializationError(record.id, cause));
  return { state, data: cloned };
}

function ensureEntry(id: string): SnapshotEntry {
  let entry = snapshotCache.get(id);
  if (!entry) {
    entry = { version: -1, references: 0 };
    snapshotCache.set(id, entry);
  }
  return entry;
}

function installSnapshot(id: string, version: number, data: Readonly<StateData>): void {
  const entry = ensureEntry(id);
  entry.version = version;
  entry.data = structuredClone(data) as Readonly<StateData>;
}

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || visited.has(value as object)) return value;
  visited.add(value as object);
  if (value instanceof Map) {
    for (const [key, item] of value) {
      deepFreeze(key, visited);
      deepFreeze(item, visited);
    }
    Object.defineProperties(value, {
      set: { value: () => { throw new TypeError("Actor snapshots are read-only"); } },
      delete: { value: () => { throw new TypeError("Actor snapshots are read-only"); } },
      clear: { value: () => { throw new TypeError("Actor snapshots are read-only"); } },
    });
  } else if (value instanceof Set) {
    for (const item of value) deepFreeze(item, visited);
    Object.defineProperties(value, {
      add: { value: () => { throw new TypeError("Actor snapshots are read-only"); } },
      delete: { value: () => { throw new TypeError("Actor snapshots are read-only"); } },
      clear: { value: () => { throw new TypeError("Actor snapshots are read-only"); } },
    });
  } else {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key], visited);
  }
  return Object.freeze(value);
}

function isActorDescriptor(value: unknown): value is ActorDescriptor {
  if (!value || typeof value !== "object") return false;
  try {
    const type = Object.getOwnPropertyDescriptor(value, "type");
    const id = Object.getOwnPropertyDescriptor(value, "id");
    return !!type && !!id && "value" in type && "value" in id
      && typeof type.value === "string"
      && typeof id.value === "string"
      && knownTypes.has(type.value);
  } catch {
    return false;
  }
}

const typedArrayPrototypes = new Set<object>([
  Int8Array.prototype,
  Uint8Array.prototype,
  Uint8ClampedArray.prototype,
  Int16Array.prototype,
  Uint16Array.prototype,
  Int32Array.prototype,
  Uint32Array.prototype,
  Float32Array.prototype,
  Float64Array.prototype,
  BigInt64Array.prototype,
  BigUint64Array.prototype,
]);

function assertCloneableResultPrototypes(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  if (typeof value === "function") throw new TypeError("Functions are not structured-cloneable");
  if (seen.has(value)) return;
  seen.add(value);

  if (refs.has(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if ((prototype === Object.prototype || prototype === null)
      && isActorDescriptor(value)
      && Object.keys(value).length === 2
      && Object.hasOwn(value, "type")
      && Object.hasOwn(value, "id")) return;
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw new TypeError("Array subclasses are not structured-clone-safe");
    for (const item of value) assertCloneableResultPrototypes(item, seen);
    return;
  }
  if (prototype === Map.prototype) {
    for (const [key, item] of value as Map<unknown, unknown>) {
      assertCloneableResultPrototypes(key, seen);
      assertCloneableResultPrototypes(item, seen);
    }
    return;
  }
  if (prototype === Set.prototype) {
    for (const item of value as Set<unknown>) assertCloneableResultPrototypes(item, seen);
    return;
  }
  if (prototype === Date.prototype || prototype === RegExp.prototype || prototype === ArrayBuffer.prototype
      || (typeof SharedArrayBuffer !== "undefined" && prototype === SharedArrayBuffer.prototype)) return;
  if (ArrayBuffer.isView(value)) {
    if (prototype !== DataView.prototype && !typedArrayPrototypes.has(prototype)) {
      throw new TypeError("Typed array subclasses are not structured-clone-safe");
    }
    return;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    const name = (prototype as { constructor?: { name?: string } }).constructor?.name ?? "unknown";
    throw new TypeError(`Instances with the ${name} prototype are not structured-clone-safe`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("Objects with symbol-keyed properties are not structured-clone-safe");
  }
  for (const key of Object.keys(value)) {
    assertCloneableResultPrototypes((value as Record<string, unknown>)[key], seen);
  }
}

function hydrateRefs<T>(value: T, visited = new WeakMap<object, unknown>()): T {
  if (!value || typeof value !== "object") return value;
  if (refs.has(value as object)) return value;
  if (isActorDescriptor(value)) return makeRef(value.type, value.id) as T;
  if (visited.has(value as object)) return visited.get(value as object) as T;
  if (value instanceof Date || value instanceof RegExp || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  if (value instanceof Map) {
    visited.set(value, value);
    for (const [key, item] of value) {
      const nextKey = hydrateRefs(key, visited);
      const nextItem = hydrateRefs(item, visited);
      if (nextKey !== key || nextItem !== item) {
        value.delete(key);
        value.set(nextKey, nextItem);
      }
    }
    return value;
  }
  if (value instanceof Set) {
    visited.set(value, value);
    for (const item of [...value]) {
      const next = hydrateRefs(item, visited);
      if (next !== item) {
        value.delete(item);
        value.add(next);
      }
    }
    return value;
  }
  visited.set(value as object, value);
  for (const key of Object.keys(value)) {
    const previous = (value as Record<string, unknown>)[key];
    const hydrated = hydrateRefs(previous, visited);
    if (hydrated !== previous) (value as Record<string, unknown>)[key] = hydrated;
  }
  return value;
}

function collectRefs(value: unknown, ids = new Set<string>(), visited = new WeakSet<object>()): Set<string> {
  if (!value || typeof value !== "object" || visited.has(value as object)) return ids;
  if (isActorDescriptor(value)) {
    ids.add(value.id);
    return ids;
  }
  visited.add(value as object);
  if (value instanceof Map) {
    for (const [key, item] of value) {
      collectRefs(key, ids, visited);
      collectRefs(item, ids, visited);
    }
  } else if (value instanceof Set) {
    for (const item of value) collectRefs(item, ids, visited);
  } else {
    for (const key of Object.keys(value)) collectRefs((value as Record<string, unknown>)[key], ids, visited);
  }
  return ids;
}

function stateRefs(record: ActorRecord, state: StateData): Set<string> {
  const refsFound = new Set<string>();
  for (const key of stateFields(record)) collectRefs(state[key], refsFound);
  return refsFound;
}

async function hold(root: RootTransaction, id: string, holder: string): Promise<void> {
  const record = await root.backend.route(id);
  if (!record || record.named) return;
  record.holders.add(holder);
}

async function release(root: RootTransaction, id: string, holder: string): Promise<void> {
  const record = await root.backend.route(id);
  if (!record || record.named) return;
  record.holders.delete(holder);
  if (record.holders.size === 0) await killActor(root, id);
}

async function killActor(root: RootTransaction, id: string): Promise<void> {
  const record = await root.backend.route(id);
  if (!record || record.named) return;
  await root.backend.kill(id);
  // Anonymous reference cycles keep each other's actor-id holders and intentionally leak.
  for (const childId of record.heldRefs) {
    const child = await root.backend.route(childId);
    if (!child || child.named) continue;
    child.holders.delete(`actor:${id}`);
    if (child.holders.size === 0) await killActor(root, childId);
  }
}

async function updateStateHolders(frame: ActionFrame, state: StateData, preserveDroppedRefs = false): Promise<void> {
  const currentIds = stateRefs(frame.record, state);
  const holder = `actor:${frame.record.id}`;
  for (const id of currentIds) {
    const target = await frame.root.backend.route(id);
    if (!target || target.named) continue;
    target.holders.add(holder);
  }
  for (const oldId of frame.record.heldRefs) {
    if (currentIds.has(oldId)) continue;
    const target = await frame.root.backend.route(oldId);
    if (!target || target.named) continue;
    if (preserveDroppedRefs) {
      frame.root.ownedIds.add(oldId);
      target.holders.add(`tx:${frame.root.id}`);
    }
    target.holders.delete(holder);
    if (target.holders.size === 0) await killActor(frame.root, oldId);
  }
  frame.record.heldRefs.clear();
  for (const id of currentIds) frame.record.heldRefs.add(id);
}

function snapshotVersion(id: string): number {
  return snapshotCache.get(id)?.version ?? -1;
}

function snapshotData(id: string): Readonly<StateData> {
  const entry = snapshotCache.get(id);
  if (!entry?.data || entry.version < 0) throw new ActorSnapshotUnavailableError(id);
  return entry.data;
}

function defineRefSurface(ref: RefObject): void {
  const ctor = knownTypes.get(ref.type);
  if (!ctor) return;
  const metadata = metadataFor(ctor);
  for (const key of [...metadata.state, ...metadata.derived]) {
    if (Object.hasOwn(ref, key)) continue;
    Object.defineProperty(ref, key, {
      enumerable: false,
      configurable: false,
      get() {
        current(`Read actor ref ${ref.id}`);
        return deepFreeze(hydrateRefs(structuredClone(snapshotData(ref.id)[key])));
      },
    });
  }
  for (const key of metadata.actions.keys()) {
    if (Object.hasOwn(ref, key)) continue;
    const invoke = (...args: unknown[]) => invokeRefAction(ref, key, args);
    Object.defineProperty(invoke, "runDetached", {
      value: (...args: unknown[]) => enqueueDetached(ref, key, args),
      enumerable: false,
    });
    Object.defineProperty(ref, key, { value: invoke, enumerable: false, configurable: false });
  }
}

function makeRef<T extends Actor<unknown, unknown> = Actor<unknown, unknown>>(type: string, id: string): ActorRef<T> {
  const ref = { type, id } as RefObject;
  defineRefSurface(ref);
  Object.freeze(ref);
  refs.add(ref);
  const entry = ensureEntry(id);
  entry.references += 1;
  refFinalizer.register(ref, id);
  return ref as ActorRef<T>;
}

function ensureRef(value: ActorDescriptor): RefObject {
  if (refs.has(value as object)) return value as RefObject;
  const ref = value as RefObject;
  defineRefSurface(ref);
  Object.freeze(ref);
  refs.add(ref);
  const entry = ensureEntry(ref.id);
  entry.references += 1;
  refFinalizer.register(ref, ref.id);
  return ref;
}

function cacheBackendSnapshot(record: ActorRecord): void {
  installSnapshot(record.id, record.version, structuredClone(record.snapshot) as StateData);
}

function changedStateFields(before: StateData, after: StateData, record: ActorRecord): StateData {
  const diff: StateData = {};
  for (const key of stateFields(record)) {
    if (!isDeepStrictEqual(before[key], after[key])) diff[key] = after[key];
  }
  for (const key of metadataFor(record.instance).derived) diff[key] = record.snapshot[key];
  return diff;
}

async function commitSegment(frame: ActionFrame, force = false, preserveDroppedRefs = false): Promise<void> {
  const next = createSnapshot(frame.record);
  const changed = stateFields(frame.record).some((key) => !isDeepStrictEqual(frame.baseline[key], next.state[key]));
  if (!force && !changed) return;
  const nextVersion = frame.record.version + 1;
  const persisted = structuredClone(next.data) as StateData;
  await frame.root.backend.persist(frame.record.id, persisted, nextVersion);
  installSnapshot(frame.record.id, nextVersion, next.data);
  await updateStateHolders(frame, next.state, preserveDroppedRefs);
  frame.baseline = next.state;
}

async function withMailbox<T>(record: ActorRecord, work: () => Promise<T>): Promise<T> {
  const previous = record.mailbox.tail;
  const { promise: lock, resolve: unlock } = Promise.withResolvers<void>();
  record.mailbox.tail = previous.then(() => lock, () => lock);
  await previous;
  try {
    if (record.killed) throw new ActorKilledError(record.id);
    return await work();
  } finally {
    unlock();
  }
}

function restoreSnapshotData(record: ActorRecord): StateData {
  const data: StateData = {};
  for (const key of stateFields(record)) data[key] = (record.snapshot as StateData)[key];
  return structuredClone(data);
}

function mergeFrame(frame: ActionFrame): void {
  if (frame.parent) {
    frame.parent.compensations.push(...frame.compensations);
    frame.parent.outbox.push(...frame.outbox);
  } else {
    frame.root.compensations.push(...frame.compensations);
    frame.root.outbox.push(...frame.outbox);
  }
}

async function rollbackOutbox(root: RootTransaction, messages: OutboxMessage[]): Promise<void> {
  for (const message of messages) {
    for (const id of message.heldIds) await release(root, id, `message:${message.id}`);
  }
}

async function flushCompensationOutbox(root: RootTransaction, outbox: OutboxMessage[]): Promise<void> {
  await Promise.all(root.pendingHolds);
  for (const message of outbox.splice(0)) await root.backend.deliver(message);
}

async function runCompensations(
  root: RootTransaction,
  compensations: Compensation[],
  cause: unknown,
): Promise<ActorCompensationError | undefined> {
  const outbox: OutboxMessage[] = [];
  const errors: unknown[] = [];
  const parentContext = execution.getStore();
  const context: ExecutionContext = {
    ...(parentContext ?? { chain: new Set<string>() }),
    root,
    compensation: { outbox },
  };
  await execution.run(context, async () => {
    for (const compensation of [...compensations].reverse()) {
      try {
        if (compensation.action === "$runtime.kill") {
          await killActor(root, compensation.actorId);
          continue;
        }
        const activeFrame = execution.getStore()?.frame;
        if (activeFrame?.record.id === compensation.actorId) {
          const method = metadataFor(activeFrame.record.instance).actions.get(compensation.action);
          if (!method) throw new ActorRuntimeError(`Unknown actor action ${compensation.action}`);
          await invokeNested(activeFrame, compensation.action, [...compensation.args], () =>
            method.apply(activeFrame.record.instance, hydrateRefs([...compensation.args]) as unknown[]));
          await commitSegment(activeFrame, true, true);
        } else {
          await invokeActorAction(
            root,
            compensation.actorId,
            compensation.action,
            [...compensation.args],
            undefined,
            new Set(execution.getStore()?.chain ?? []),
          );
        }
      } catch (error) {
        errors.push(error);
      }
    }
  });
  try {
    await flushCompensationOutbox(root, outbox);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 0) return cause instanceof ActorCompensationError ? cause : undefined;
  if (cause instanceof ActorCompensationError) {
    return new ActorCompensationError([...cause.errors, ...errors], cause.cause);
  }
  return new ActorCompensationError(errors, cause);
}

function makeFrame(record: ActorRecord, root: RootTransaction, parent: ActionFrame | undefined, chain: Set<string>): ActionFrame {
  const state = cloneState(record);
  return {
    record,
    root,
    parent,
    chain,
    startVersion: record.version,
    initialState: structuredClone(state),
    baseline: state,
    compensations: [],
    outbox: [],
  };
}

async function invokeNested(
  parent: ActionFrame,
  actionName: string,
  args: unknown[],
  run: () => unknown,
): Promise<unknown> {
  const frame = makeFrame(parent.record, parent.root, parent, new Set(parent.chain));
  const context = execution.getStore();
  return execution.run({ root: frame.root, frame, chain: frame.chain, compensation: context?.compensation }, async () => {
    try {
      const value = cloneActionResult(frame.record, actionName, await run());
      for (const id of collectRefs(value)) {
        frame.root.ownedIds.add(id);
        await hold(frame.root, id, `tx:${frame.root.id}`);
      }
      mergeFrame(frame);
      return hydrateRefs(value);
    } catch (error) {
      const compensationError = await runCompensations(frame.root, frame.compensations, error);
      await rollbackAction(frame);
      await Promise.all(frame.root.pendingHolds);
      await rollbackOutbox(frame.root, frame.outbox);
      throw compensationError ?? error;
    }
  });
}

async function rollbackAction(frame: ActionFrame): Promise<void> {
  restoreState(frame.record, frame.initialState);
  if (frame.record.version <= frame.startVersion) return;
  const restored = createSnapshot(frame.record);
  const rollbackVersion = frame.record.version + 1;
  const persisted = cloneOrThrow(restored.data, (cause) => new ActorStateSerializationError(frame.record.id, cause));
  await frame.root.backend.persist(frame.record.id, persisted, rollbackVersion);
  installSnapshot(frame.record.id, rollbackVersion, restored.data);
  await updateStateHolders(frame, restored.state);
  frame.baseline = restored.state;
}

async function invokeLocal(instance: object, actionName: string, args: unknown[], run: () => unknown): Promise<unknown> {
  const context = current(`Call action ${actionName}`);
  const actorId = instanceIds.get(instance);
  if (!actorId || !context.frame || context.frame.record.id !== actorId) {
    throw new NoActiveTransactionError(`Call action ${actionName} outside its owning actor`);
  }
  return invokeNested(context.frame, actionName, args, run);
}

async function invokeActorAction(
  root: RootTransaction,
  actorId: string,
  actionName: string,
  args: unknown[],
  parent: ActionFrame | undefined,
  inheritedChain: Set<string>,
  baseVersion = -1,
): Promise<ActionReply> {
  const record = await root.backend.route(actorId);
  if (!record) throw new ActorKilledError(actorId);

  if (parent?.record.id === actorId) {
    const method = metadataFor(record.instance).actions.get(actionName);
    if (!method) throw new ActorRuntimeError(`Unknown actor action ${actionName}`);
    const value = await invokeNested(parent, actionName, hydrateRefs(args) as unknown[], () => method.apply(record.instance, hydrateRefs(args) as unknown[]));
    const state = cloneState(record);
    const snapshot = record.snapshot as StateData;
    return { value, baseVersion, startVersion: record.version, version: record.version, isDiff: true, snapshot: changedStateFields(parent.initialState, state, record) };
  }

  if (inheritedChain.has(actorId)) throw new ActorReentrancyError(actorId);
  if (parent) await commitSegment(parent, false, true);
  const chain = new Set(inheritedChain);
  chain.add(actorId);

  return withMailbox(record, async () => {
    const method = metadataFor(record.instance).actions.get(actionName);
    if (!method) throw new ActorRuntimeError(`Unknown actor action ${actionName}`);
    const frame = makeFrame(record, root, parent, chain);
    const context = execution.getStore();
    return execution.run({ root, frame, chain, compensation: context?.compensation }, async () => {
      try {
        const callArgs = hydrateRefs(structuredClone(args)) as unknown[];
        const value = cloneActionResult(record, actionName, await method.apply(record.instance, callArgs));
        await commitSegment(frame, true);
        mergeFrame(frame);
        const returnedIds = collectRefs(value);
        for (const id of returnedIds) {
          root.ownedIds.add(id);
          await hold(root, id, `tx:${root.id}`);
        }
        const snapshot = frame.startVersion === baseVersion
          ? changedStateFields(frame.initialState, restoreSnapshotData(record), record)
          : structuredClone(record.snapshot) as StateData;
        return {
          value: hydrateRefs(value),
          baseVersion,
          startVersion: frame.startVersion,
          version: record.version,
          isDiff: frame.startVersion === baseVersion,
          snapshot,
        };
      } catch (error) {
        const compensationError = await runCompensations(root, frame.compensations, error);
        await rollbackAction(frame);
        await Promise.all(root.pendingHolds);
        await rollbackOutbox(root, frame.outbox);
        throw compensationError ?? error;
      }
    });
  });
}

async function applyReply(reply: ActionReply, id: string): Promise<void> {
  const entry = snapshotCache.get(id);
  if (!reply.isDiff || !entry?.data || entry.version !== reply.baseVersion) {
    const record = await defaultBackend.route(id);
    if (record) cacheBackendSnapshot(record);
    else if (!reply.isDiff && reply.snapshot) installSnapshot(id, reply.version, reply.snapshot);
    return;
  }
  const merged = { ...entry.data, ...reply.snapshot };
  installSnapshot(id, reply.version, merged);
}

async function invokeRefAction(ref: ActorDescriptor, actionName: string, args: unknown[]): Promise<unknown> {
  const context = current(`Call actor action ${actionName}`);
  const sameActor = context.frame?.record.id === ref.id;
  const baseVersion = snapshotVersion(ref.id);
  const reply = await invokeActorAction(
    context.root,
    ref.id,
    actionName,
    args,
    context.frame,
    context.chain,
    baseVersion,
  );
  lastReplyForTest = reply;
  if (!sameActor) await applyReply(reply, ref.id);
  return reply.value;
}

function enqueueDetached(ref: ActorDescriptor, actionName: string, args: unknown[]): void {
  const context = current(`Queue detached action ${actionName}`);
  const id = `message_${++messageSequence}`;
  const clonedArgs = cloneOrThrow(args, (cause) => new ActorRuntimeError("runDetached() arguments must be structuredClone-serializable", { cause }));
  const heldIds = new Set<string>([ref.id, ...collectRefs(clonedArgs)]);
  for (const heldId of heldIds) context.root.ownedIds.add(heldId);
  const message: OutboxMessage = {
    id,
    target: { type: ref.type, id: ref.id },
    action: actionName,
    args: clonedArgs,
    heldIds: [...heldIds],
  };
  if (context.compensation) context.compensation.outbox.push(message);
  else if (context.frame) context.frame.outbox.push(message);
  else context.root.outbox.push(message);
  context.root.pendingHolds.push(Promise.all([...heldIds].map((heldId) => hold(context.root, heldId, `message:${id}`))).then(() => undefined));
}

async function dispatchDetached(message: OutboxMessage): Promise<void> {
  const root = newRoot(defaultBackend);
  try {
    await invokeActorAction(root, message.target.id, message.action, [...message.args], undefined, new Set());
    await finishRoot(root, true);
  } catch (error) {
    await finishRoot(root, false, error);
  } finally {
    for (const id of message.heldIds) await release(root, id, `message:${message.id}`);
  }
}

defaultBackend.setDeliveryHandler(async (message) => {
  void dispatchDetached(message);
});

function newRoot(backend: ActorBackend): RootTransaction {
  return {
    id: `transaction_${++transactionSequence}`,
    backend,
    compensations: [],
    outbox: [],
    pendingHolds: [],
    ownedIds: new Set(),
  };
}

async function flushOutbox(root: RootTransaction): Promise<void> {
  await Promise.all(root.pendingHolds);
  for (const message of root.outbox.splice(0)) await root.backend.deliver(message);
}

async function finishRoot(
  root: RootTransaction,
  succeeded: boolean,
  cause?: unknown,
): Promise<ActorCompensationError | undefined> {
  if (succeeded) await flushOutbox(root);
  else {
    await Promise.all(root.pendingHolds);
    await rollbackOutbox(root, root.outbox.splice(0));
    const compensationError = await runCompensations(root, root.compensations, cause);
    for (const id of root.ownedIds) {
      const record = await root.backend.route(id);
      if (!record || record.named) continue;
      await release(root, id, `tx:${root.id}`);
    }
    return compensationError;
  }

  for (const id of root.ownedIds) {
    const record = await root.backend.route(id);
    if (!record || record.named) continue;
    await release(root, id, `tx:${root.id}`);
  }
  return undefined;
}

async function createActor<T extends Actor<unknown, unknown>>(
  root: RootTransaction,
  Type: Constructor<T>,
  input: ActorInput<T>,
  named: boolean,
  nameKey?: string,
): Promise<ActorRef<T>> {
  const type = typeName(Type);
  knownTypes.set(type, Type);
  const id = `actor_${++actorSequence}`;
  const instance = new Type(input);
  const initial = {} as ActorRecord;
  Object.assign(initial, {
    id,
    type,
    instance,
    named,
    mailbox: { tail: Promise.resolve() },
    holders: new Set<string>(named ? ["named-root"] : [`tx:${root.id}`]),
    heldRefs: new Set<string>(),
    version: 0,
    snapshot: {},
    killed: false,
  });
  instanceIds.set(instance, id);

  const first = createSnapshot(initial);
  initial.snapshot = structuredClone(first.data);
  await root.backend.register(initial);
  await root.backend.persist(id, initial.snapshot, 0);
  installSnapshot(id, 0, first.data);
  root.ownedIds.add(id);
  if (named && nameKey !== undefined) await root.backend.bindNamed(type, nameKey, id);

  const initialFrame: ActionFrame = {
    record: initial,
    root,
    chain: new Set(),
    startVersion: 0,
    initialState: first.state,
    baseline: first.state,
    compensations: [],
    outbox: [],
  };
  if (!named) {
    const parent = execution.getStore()?.frame;
    const compensation: Compensation = { actorId: id, action: "$runtime.kill", args: [] };
    if (parent) parent.compensations.push(compensation);
    else root.compensations.push(compensation);
  }
  await updateStateHolders(initialFrame, first.state);
  return makeRef<T>(type, id);
}

export abstract class Actor<Self, Input> {
  protected readonly input: Input;
  declare protected readonly __actorInput: Input;

  constructor(input: Input) {
    this.input = input;
  }

  static async transaction<Result>(work: () => Result | Promise<Result>): Promise<Awaited<Result>> {
    const existing = execution.getStore();
    if (existing) return await work() as Awaited<Result>;
    const root = newRoot(defaultBackend);
    try {
      const result = await execution.run({ root, chain: new Set() }, work);
      await finishRoot(root, true);
      return result as Awaited<Result>;
    } catch (error) {
      const compensationError = await finishRoot(root, false, error);
      throw compensationError ?? error;
    }
  }

  static async spawn<T extends Actor<unknown, unknown>>(
    Type: Constructor<T>,
    init: ActorInput<T>,
  ): Promise<ActorRef<T>> {
    const context = current("Actor.spawn");
    if (context.frame) await commitSegment(context.frame, false, true);
    return createActor(context.root, Type, init, false);
  }

  static ofNamed<T extends Actor<unknown, unknown>>(
    Type: Constructor<T>,
    key: string,
  ): ActorRefInit<T> {
    current("Actor.ofNamed");
    const type = typeName(Type);
    knownTypes.set(type, Type);
    return {
      orSpawn: async (factory) => {
        const context = current("Actor.ofNamed(...).orSpawn");
        if (context.frame) await commitSegment(context.frame, false, true);
        const namedKey = `${type}\0${key}`;
        const pending = namedCreations.get(namedKey);
        if (pending) return await pending as ActorRef<T>;
        const creation: Promise<ActorRef<T>> = (async () => {
          const existingId = await context.root.backend.lookupNamed(type, key);
          if (existingId) {
            const existing = await context.root.backend.route(existingId);
            if (existing) return makeRef<T>(type, existingId);
          }
          const input = await factory();
          return createActor(context.root, Type, input, true, key);
        })();
        namedCreations.set(namedKey, creation);
        try {
          return await creation;
        } finally {
          if (namedCreations.get(namedKey) === creation) namedCreations.delete(namedKey);
        }
      },
      orNull: async () => {
        const context = current("Actor.ofNamed(...).orNull");
        if (context.frame) await commitSegment(context.frame, false, true);
        const id = await context.root.backend.lookupNamed(type, key);
        const record = id ? await context.root.backend.route(id) : undefined;
        return record ? makeRef<T>(type, record.id) : null;
      },
    };
  }

  static async refreshValues<T extends Actor<unknown, unknown>>(ref: ActorRef<T> | ActorDescriptor): Promise<ActorRef<T>> {
    const context = current("Actor.refreshValues");
    if (context.frame) await commitSegment(context.frame, false, true);
    const normalized = ensureRef(ref as ActorDescriptor);
    const record = await context.root.backend.route(normalized.id);
    if (!record) throw new ActorKilledError(normalized.id);
    cacheBackendSnapshot(record);
    return normalized as ActorRef<T>;
  }
}

export function defer(method: Function, ...args: unknown[]): void {
  const context = current("defer");
  const frame = context.frame;
  const action = actionNameOf(method);
  if (!frame || !action) throw new ActorRuntimeError("defer() expects this.<@action method> inside an actor action");
  const serializableArgs = cloneOrThrow(args, (cause) => new ActorRuntimeError("defer() arguments must be structuredClone-serializable", { cause }));
  if (context.compensation) return;
  frame.compensations.push({ actorId: frame.record.id, action, args: serializableArgs });
}

export function __invokeLocal(
  instance: object,
  actionName: string,
  args: unknown[],
  run: () => unknown,
): unknown {
  return invokeLocal(instance, actionName, args, run);
}

setActionRuntime(__invokeLocal);

// Lets the runtime suite model a restored reference after its cache entry was finalized.
export function __evictSnapshotCacheForTest(ref: ActorDescriptor): void {
  snapshotCache.delete(ref.id);
}

export function __lastActionReplyForTest(): ActionReply | undefined {
  return lastReplyForTest;
}
