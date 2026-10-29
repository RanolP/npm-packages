import type {
  Actor,
  ActorConstructor,
  ActorInput,
  ActorRef,
} from "@mekakucity/actors";
import {
  ActorInvocationContext,
  createSnapshot,
  recordTxHold,
  txHolder,
} from "@mekakucity/actors/runtime";
import type { RuntimeMemory } from "../runtime/memory.js";
import { commitSegment, updateStateHolders } from "../state/commit.js";
import { cacheBackendSnapshot, cacheSnapshot } from "../state/snapshot.js";
import { currentExecution, type ActionFrame } from "../transaction/context.js";
import type { ActorRecord } from "./in-memory-store.js";
import { creationHolder } from "./lifecycle.js";
import { makeRef, typeName } from "./surface.js";

export const createActor = async <T extends Actor<unknown, unknown>>(
  memory: RuntimeMemory,
  Type: ActorConstructor<T>,
  input: ActorInput<T>,
  named: boolean,
  nameKey?: string,
): Promise<ActorRef<T>> => {
  const context = currentExecution(memory, named ? "Actor.ofNamed(...).orSpawn" : "Actor.spawn");
  const type = typeName(Type);
  memory.knownTypes.set(type, Type);
  const id = `actor_${++memory.sequence.actor}`;
  const holder = creationHolder(named, context.root, context.frame, id);
  const instance = new Type(input);
  const initial: ActorRecord = {
    id,
    type,
    instance,
    mailbox: { tail: Promise.resolve() },
    holders: new Set([holder]),
    heldRefs: new Set<string>(),
    version: 0,
    snapshot: {},
    killed: false,
  };
  memory.instanceIds.set(instance, id);

  const first = createSnapshot(initial);
  initial.snapshot = structuredClone(first.data);
  await context.root.backend.register(initial);
  await context.root.backend.persist(id, initial.snapshot, 0);
  cacheSnapshot(memory, id, 0, first.data);
  if (!named && !context.frame) recordTxHold(context.root.owned, id, holder);
  if (named && nameKey !== undefined) await context.root.backend.bindNamed(type, nameKey, id);

  const initialFrameId = `frame_${++memory.sequence.frame}`;
  const initialFrame: ActionFrame = {
    id: initialFrameId,
    record: initial,
    root: context.root,
    chain: new Set(),
    invocation: new ActorInvocationContext(
      context.frame?.invocation.carried,
      memory.contextProvider,
      { type, id },
      context.frame?.invocation.origin,
    ),
    txHolder: txHolder(context.root.id, initialFrameId),
    startVersion: 0,
    initialState: first.state,
    segment: { baseline: first.state },
    spawnedIds: new Set(),
    outbox: [],
    pendingOps: [],
    changed: new Set(),
  };
  if (!named && context.frame) context.frame.spawnedIds.add(id);
  await updateStateHolders(memory, initialFrame, first.state);
  return makeRef<T>(memory, type, id);
};

export const spawnActor = async <T extends Actor<unknown, unknown>>(
  memory: RuntimeMemory,
  Type: ActorConstructor<T>,
  input: ActorInput<T>,
  key?: string,
): Promise<ActorRef<T>> => {
  const named = key !== undefined;
  const context = currentExecution(memory, named ? "Actor.ofNamed(...).orSpawn" : "Actor.spawn");
  if (context.frame) await commitSegment(memory, context.frame, false, true);
  return createActor(memory, Type, input, named, key);
};

export const resolveNamedActor = async <T extends Actor<unknown, unknown>>(
  memory: RuntimeMemory,
  Type: ActorConstructor<T>,
  key: string,
): Promise<ActorRef<T> | null> => {
  const context = currentExecution(memory, "Actor.ofNamed(...).orNull");
  if (context.frame) await commitSegment(memory, context.frame, false, true);
  const type = typeName(Type);
  memory.knownTypes.set(type, Type);
  const id = await context.root.backend.lookupNamed(type, key);
  const record = id ? await context.root.backend.route(id) : undefined;
  if (!record) return null;
  cacheBackendSnapshot(memory, record);
  return makeRef<T>(memory, type, record.id);
};
