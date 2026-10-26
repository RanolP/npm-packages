import { AsyncLocalStorage } from "node:async_hooks";
import {
  ActorKilledError,
  ActorReentrancyError,
  ActorResultSerializationError,
  ActorRuntime,
  ActorRuntimeError,
  ActorSelfRefUnavailableError,
  ActorSnapshotUnavailableError,
  NoActiveTransactionError,
  type Actor,
  type ActorConstructor,
  type ActorDescriptor,
  type ActorInput,
  type ActorRef,
  type ActorRefInit,
} from "@mekakucity/actors";
import {
  NAMED_ROOT,
  actorRefSurfaceFor,
  assertCloneableResultPrototypes,
  cloneOrThrow,
  collectActorRefIds,
  createActorRef,
  deepFreeze,
  frameHolder,
  hydrateActorRefs,
  isActorDescriptor,
  messageHolder,
  messageReleaseOps,
  metadataFor,
  recordTxHold,
  txHolder,
  txReleaseOps,
  type TxHold,
  type HolderOp,
} from "@mekakucity/actors/runtime";
import { unwrap } from "./errors.js";
import type { ActorHost } from "./host.js";
import { groupOps } from "./outbox.js";
import { stubOf, type ActorHostRpc, type ActorView, type CallContext, type OutboxMessage } from "./protocol.js";
import { isKnownType, lookupType, typeNameOf } from "./registry.js";
import { snapshots } from "./snapshots.js";

export type StateData = Record<string, unknown>;

/** A root transaction as seen by one runtime: the caller's own root (`local`) or a proxy for a remote caller's root. */
export interface RootTransaction {
  readonly id: string;
  readonly local: boolean;
  /** This runtime's tx holder for the root: one per call into the actor, so its holds are its own to release. */
  readonly holder: string;
  /** (target, holder) holds this root owns, released when it ends; a proxy root hands them back to its caller. */
  readonly owned: Map<string, TxHold>;
  /** Detached messages and their holds queued outside any action frame (client-side roots only). */
  readonly outbox: OutboxMessage[];
  readonly holds: HolderOp[];
}

/** One action segment on the actor hosted by this runtime's Durable Object. */
export interface ActionFrame {
  readonly id: string;
  readonly root: RootTransaction;
  readonly parent?: ActionFrame;
  readonly chain: Set<string>;
  readonly startVersion: number;
  readonly initialState: StateData;
  readonly spawnedIds: Set<string>;
  readonly outbox: OutboxMessage[];
  readonly pendingOps: HolderOp[];
  baseline: StateData;
}

interface Execution {
  readonly root: RootTransaction;
  readonly frame?: ActionFrame;
  readonly chain: Set<string>;
}

/** What a runtime living inside an ActorHost needs from that host. */
export interface LocalActor {
  readonly id: string;
  readonly type: string;
  readonly instance: object;
  commitSegment(frame: ActionFrame, preserveDroppedRefs: boolean): Promise<void>;
  invokeNested(parent: ActionFrame, actionName: string, run: () => unknown): Promise<unknown>;
}

export interface DurableObjectActorRuntimeOptions {
  /** Separates named-actor keys; runtimes that share a scope share named actors. Types (@actor ids) are worker-wide. */
  readonly scope?: string;
}

export class RuntimeCore {
  readonly execution = new AsyncLocalStorage<Execution>();
  readonly #refs = new WeakSet<object>();
  readonly #namedCreations = new Map<string, Promise<unknown>>();
  local: LocalActor | undefined;

  constructor(
    readonly binding: DurableObjectNamespace<ActorHost>,
    readonly scope: string,
    readonly enter: <T>(work: () => T) => T,
  ) {}

  stub(id: string): ActorHostRpc {
    return stubOf(this.binding, id);
  }

  current(operation: string): Execution {
    const context = this.execution.getStore();
    if (!context) throw new NoActiveTransactionError(operation);
    return context;
  }

  newRoot(local: boolean, id: string = `transaction_${crypto.randomUUID()}`, callId = "root"): RootTransaction {
    return { id, local, holder: txHolder(id, callId), owned: new Map(), outbox: [], holds: [] };
  }

  callContext(context: Execution, callId: string): CallContext {
    return { rootId: context.root.id, callId, chain: [...context.chain], parentFrameId: context.frame?.id };
  }

  // ---- refs and snapshots ------------------------------------------------

  isDescriptor = (candidate: unknown): candidate is ActorDescriptor =>
    isActorDescriptor(candidate, isKnownType);

  /** #refs holds only what makeRef built, so a ref passed back as ActorRef<T> | ActorDescriptor is that ActorRef<T>. */
  #isOwnRef<T extends Actor<unknown, unknown>>(ref: ActorRef<T> | ActorDescriptor): ref is ActorRef<T> {
    return this.#refs.has(ref);
  }

  makeRef<T extends Actor<unknown, unknown>>(type: string, id: string): ActorRef<T> {
    const ref = createActorRef<T>({ type, id }, actorRefSurfaceFor(lookupType(type).Type));
    this.#refs.add(ref);
    snapshots.track(ref, id);
    return ref;
  }

  hydrate<T>(value: T): T {
    return hydrateActorRefs(value, {
      isKnownRef: (candidate) => this.#refs.has(candidate),
      isDescriptor: this.isDescriptor,
      toRef: (descriptor) => this.makeRef(descriptor.type, descriptor.id),
    });
  }

  collectRefs(value: unknown, ids?: Set<string>): Set<string> {
    return collectActorRefIds(value, this.isDescriptor, ids);
  }

  cloneResult<Value>(actorId: string, actionName: string, value: Value): Value {
    try {
      assertCloneableResultPrototypes(value, (candidate) => this.#refs.has(candidate), this.isDescriptor);
    } catch (cause) {
      throw new ActorResultSerializationError(actorId, actionName, cause);
    }
    return cloneOrThrow(value, (cause) => new ActorResultSerializationError(actorId, actionName, cause));
  }

  cacheView(view: ActorView): void {
    snapshots.install(view.id, view.version, view.snapshot);
  }

  // ---- holder ops sent by a client-side root -------------------------------

  async deliverOps(ops: readonly HolderOp[]): Promise<void> {
    for (const row of groupOps(ops)) {
      if (row.kind === "ops") await this.stub(row.target).applyHolderOps([...row.ops]);
    }
  }

  async deliverMessage(message: OutboxMessage): Promise<void> {
    const ack = await this.stub(message.target.id).deliverMessage(message);
    if (ack === "dead") {
      await this.deliverOps(messageReleaseOps(message, { exceptTarget: true }));
    }
  }

  /** Resolves only once the root's own holder ops (and the collections they cascade into) were delivered. */
  async finishRoot(root: RootTransaction, succeeded: boolean): Promise<void> {
    if (succeeded) {
      await this.deliverOps(root.holds.splice(0));
      for (const message of root.outbox.splice(0)) await this.deliverMessage(message);
    } else {
      // Their holds were never sent, so there is nothing to release.
      root.holds.length = 0;
      root.outbox.length = 0;
    }
    await this.deliverOps(txReleaseOps(root.owned.values()));
  }

  // ---- ActorRuntime members --------------------------------------------------

  async run<Result>(work: () => Result | Promise<Result>): Promise<Awaited<Result>> {
    if (this.execution.getStore()) return await work();
    const root = this.newRoot(true);
    let result: Awaited<Result>;
    try {
      result = await this.execution.run({ root, chain: new Set() }, async () => await work());
    } catch (error) {
      await this.finishRoot(root, false);
      throw error;
    }
    await this.finishRoot(root, true);
    return result;
  }

  async #commitParent(context: Execution): Promise<void> {
    if (context.frame && this.local) await this.local.commitSegment(context.frame, true);
  }

  async create<T extends Actor<unknown, unknown>>(
    Type: ActorConstructor<T>,
    input: ActorInput<T>,
    nameKey?: string,
  ): Promise<ActorRef<T>> {
    const named = nameKey !== undefined;
    const context = this.current(named ? "Actor.ofNamed(...).orSpawn" : "Actor.spawn");
    const type = typeNameOf(Type);
    const id = named ? this.namedId(type, nameKey) : this.binding.newUniqueId().toString();
    const holder = named
      ? NAMED_ROOT
      : context.frame ? frameHolder(context.frame.id) : txHolder(context.root.id, crypto.randomUUID());
    const view = unwrap(await this.stub(id).create({
      scope: this.scope,
      type,
      input: cloneOrThrow(input, (cause) => new ActorRuntimeError("Actor input must be structuredClone-serializable", { cause })),
      named,
      holders: [holder],
    }));
    if (!named && context.frame) context.frame.spawnedIds.add(id);
    else if (!named) recordTxHold(context.root.owned, id, holder);
    this.cacheView(view);
    return this.makeRef<T>(type, id);
  }

  namedId(type: string, key: string): string {
    return this.binding.idFromName(`${this.scope}\0${type}\0${key}`).toString();
  }

  async spawn<T extends Actor<unknown, unknown>>(Type: ActorConstructor<T>, input: ActorInput<T>): Promise<ActorRef<T>> {
    await this.#commitParent(this.current("Actor.spawn"));
    return this.create(Type, input);
  }

  named<T extends Actor<unknown, unknown>>(Type: ActorConstructor<T>, key: string): ActorRefInit<T> {
    this.current("Actor.ofNamed");
    const type = typeNameOf(Type);
    const id = this.namedId(type, key);
    const lookup = async (): Promise<ActorRef<T> | null> => {
      const view = unwrap(await this.stub(id).view());
      if (!view) return null;
      this.cacheView(view);
      return this.makeRef<T>(type, id);
    };
    return {
      orSpawn: async (factory) => {
        await this.#commitParent(this.current("Actor.ofNamed(...).orSpawn"));
        const pending = this.#namedCreations.get(id);
        if (pending) {
          await pending;
          return this.makeRef<T>(type, id);
        }
        const creation = (async () => (await lookup()) ?? this.create(Type, await factory(), key))();
        this.#namedCreations.set(id, creation);
        try {
          return await creation;
        } finally {
          if (this.#namedCreations.get(id) === creation) this.#namedCreations.delete(id);
        }
      },
      orNull: async () => {
        await this.#commitParent(this.current("Actor.ofNamed(...).orNull"));
        return lookup();
      },
    };
  }

  async refreshValues<T extends Actor<unknown, unknown>>(ref: ActorRef<T> | ActorDescriptor): Promise<ActorRef<T>> {
    await this.#commitParent(this.current("Actor.refreshValues"));
    const normalized = this.#isOwnRef(ref) ? ref : this.makeRef<T>(ref.type, ref.id);
    const view = unwrap(await this.stub(ref.id).view());
    if (!view) throw new ActorKilledError(ref.id);
    this.cacheView(view);
    return normalized;
  }

  selfDescriptorOf(instance: object): ActorDescriptor {
    if (!this.local || this.local.instance !== instance) throw new ActorSelfRefUnavailableError();
    return { type: this.local.type, id: this.local.id };
  }

  async invokeRefAction(ref: ActorDescriptor, actionName: string, args: unknown[]): Promise<unknown> {
    const context = this.current(`Call actor action ${actionName}`);
    const { frame } = context;
    if (frame && this.local?.id === ref.id) {
      const instance = this.local.instance;
      const method = metadataFor(instance).actions.get(actionName);
      if (!method) throw new ActorRuntimeError(`Unknown actor action ${actionName}`);
      const hydratedArgs = this.hydrate(args);
      return this.local.invokeNested(frame, actionName, () => method.apply(instance, hydratedArgs));
    }
    if (context.chain.has(ref.id)) throw new ActorReentrancyError(ref.id);
    await this.#commitParent(context);
    const reply = unwrap(await this.stub(ref.id).invoke({
      action: actionName,
      args: structuredClone(args),
      context: this.callContext(context, crypto.randomUUID()),
    }));
    for (const { target, holder } of reply.owned) recordTxHold(context.root.owned, target, holder);
    if (frame) for (const id of reply.spawnedIds) frame.spawnedIds.add(id);
    this.cacheView(reply);
    return this.hydrate(reply.value);
  }

  invokeLocalAction(instance: object, actionName: string, _args: unknown[], run: () => unknown): unknown {
    const context = this.current(`Call action ${actionName}`);
    if (!context.frame || !this.local || this.local.instance !== instance) {
      throw new NoActiveTransactionError(`Call action ${actionName} outside its owning actor`);
    }
    return this.local.invokeNested(context.frame, actionName, run);
  }

  runDetached(ref: ActorDescriptor, actionName: string, args: unknown[]): void {
    const context = this.current(`Queue detached action ${actionName}`);
    const id = `message_${crypto.randomUUID()}`;
    const clonedArgs = cloneOrThrow(
      args,
      (cause) => new ActorRuntimeError("runDetached() arguments must be structuredClone-serializable", { cause }),
    );
    const heldIds = new Set<string>([ref.id, ...this.collectRefs(clonedArgs)]);
    const message: OutboxMessage = {
      id,
      target: { type: ref.type, id: ref.id },
      action: actionName,
      args: clonedArgs,
      heldIds: [...heldIds],
    };
    const holds = message.heldIds.map((target): HolderOp => ({ kind: "hold", target, holder: messageHolder(id) }));
    // Message holds ride with the sender's next segment commit, so a rolled-back segment never sends them.
    if (context.frame) {
      context.frame.outbox.push(message);
      context.frame.pendingOps.push(...holds);
    } else {
      context.root.outbox.push(message);
      context.root.holds.push(...holds);
    }
  }

  readSnapshotValue(ref: ActorDescriptor, key: string): unknown {
    this.current(`Read actor ref ${ref.id}`);
    const entry = snapshots.get(ref.id);
    if (!entry?.data) throw new ActorSnapshotUnavailableError(ref.id);
    return deepFreeze(this.hydrate(structuredClone(entry.data[key])));
  }
}

// Assigned in DurableObjectActorRuntime's static block, the only place that can read #core.
let coreOf: (runtime: DurableObjectActorRuntime) => RuntimeCore;

/**
 * ActorRuntime whose actors each live in their own ActorHost Durable Object.
 * Construct one per worker with the ActorHost namespace binding.
 */
export class DurableObjectActorRuntime extends ActorRuntime {
  readonly #core: RuntimeCore;

  constructor(binding: DurableObjectNamespace<ActorHost>, options: DurableObjectActorRuntimeOptions = {}) {
    super();
    this.#core = new RuntimeCore(binding, options.scope ?? "default", (work) => this.withActiveRuntime(work));
  }

  static {
    coreOf = (runtime) => runtime.#core;
  }

  run<Result>(work: () => Result | Promise<Result>): Promise<Awaited<Result>> {
    return this.withActiveRuntime(() => this.#core.run(work));
  }

  spawn<T extends Actor<unknown, unknown>>(Type: ActorConstructor<T>, input: ActorInput<T>): Promise<ActorRef<T>> {
    return this.#core.spawn(Type, input);
  }

  named<T extends Actor<unknown, unknown>>(Type: ActorConstructor<T>, key: string): ActorRefInit<T> {
    return this.#core.named(Type, key);
  }

  refreshValues<T extends Actor<unknown, unknown>>(ref: ActorRef<T> | ActorDescriptor): Promise<ActorRef<T>> {
    return this.#core.refreshValues(ref);
  }

  selfDescriptorOf(instance: object): ActorDescriptor {
    return this.#core.selfDescriptorOf(instance);
  }

  invokeRefAction(ref: ActorDescriptor, actionName: string, args: unknown[]): Promise<unknown> {
    return this.#core.invokeRefAction(ref, actionName, args);
  }

  invokeLocalAction(instance: object, actionName: string, args: unknown[], run: () => unknown): unknown {
    return this.#core.invokeLocalAction(instance, actionName, args, run);
  }

  runDetached(ref: ActorDescriptor, actionName: string, args: unknown[]): void {
    this.#core.runDetached(ref, actionName, args);
  }

  readSnapshotValue(ref: ActorDescriptor, key: string): unknown {
    return this.#core.readSnapshotValue(ref, key);
  }
}

/** The runtime an ActorHost runs its actor's actions under; not part of the package's public surface. */
export const createHostRuntimeCore = (binding: DurableObjectNamespace<ActorHost>, scope: string): RuntimeCore =>
  coreOf(new DurableObjectActorRuntime(binding, { scope }));
