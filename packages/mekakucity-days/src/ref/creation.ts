import type {
  Actor,
  ActorConstructor,
  ActorInput,
  ActorRef,
  ActorRefInit,
} from "@mekakucity/actors";
import { createSnapshot } from "@mekakucity/actors/runtime";
import type { RuntimeMemory } from "../runtime/memory.js";
import { commitSegment, updateStateHolders } from "../state/commit.js";
import { cacheSnapshot } from "../state/snapshot.js";
import { currentExecution, type ActionFrame } from "../transaction/context.js";
import type { ActorRecord } from "./in-memory-store.js";
import { makeRef, typeName } from "./surface.js";

export const createActor = async <T extends Actor<unknown, unknown>>(
  memory: RuntimeMemory,
  Type: ActorConstructor<T>,
  input: ActorInput<T>,
  named: boolean,
  nameKey?: string,
): Promise<ActorRef<T>> => {
  const context = currentExecution(memory, named ? "Actor.ofNamed(...).orSpawn" : "Actor.spawn");
  const type = typeName(memory, Type);
  memory.knownTypes.set(type, Type);
  const id = `actor_${++memory.sequence.actor}`;
  const instance = new Type(input);
  const initial: ActorRecord = {
    id,
    type,
    instance,
    named,
    mailbox: { tail: Promise.resolve() },
    holders: new Set<string>(named ? ["named-root"] : [`tx:${context.root.id}`]),
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
  context.root.ownedIds.add(id);
  if (named && nameKey !== undefined) await context.root.backend.bindNamed(type, nameKey, id);

  const initialFrame: ActionFrame = {
    record: initial,
    root: context.root,
    chain: new Set(),
    startVersion: 0,
    initialState: first.state,
    baseline: first.state,
    spawnedIds: new Set(),
    outbox: [],
  };
  const parent = memory.execution.getStore()?.frame;
  if (!named && parent) parent.spawnedIds.add(id);
  await updateStateHolders(memory, initialFrame, first.state);
  return makeRef<T>(memory, type, id);
};

export const spawnActor = async <T extends Actor<unknown, unknown>>(
  memory: RuntimeMemory,
  Type: ActorConstructor<T>,
  input: ActorInput<T>,
): Promise<ActorRef<T>> => {
  const context = currentExecution(memory, "Actor.spawn");
  if (context.frame) await commitSegment(memory, context.frame, false, true);
  return createActor(memory, Type, input, false);
};

export const namedActor = <T extends Actor<unknown, unknown>>(
  memory: RuntimeMemory,
  Type: ActorConstructor<T>,
  key: string,
): ActorRefInit<T> => {
  currentExecution(memory, "Actor.ofNamed");
  const type = typeName(memory, Type);
  memory.knownTypes.set(type, Type);
  return {
    orSpawn: async (factory) => {
      const context = currentExecution(memory, "Actor.ofNamed(...).orSpawn");
      if (context.frame) await commitSegment(memory, context.frame, false, true);
      const namedKey = `${type}\0${key}`;
      const pending = memory.namedCreations.get(namedKey);
      if (pending) return await pending as ActorRef<T>;
      const creation: Promise<ActorRef<T>> = (async () => {
        const existingId = await context.root.backend.lookupNamed(type, key);
        if (existingId) {
          const existing = await context.root.backend.route(existingId);
          if (existing) return makeRef<T>(memory, type, existingId);
        }
        return createActor(memory, Type, await factory(), true, key);
      })();
      memory.namedCreations.set(namedKey, creation);
      try {
        return await creation;
      } finally {
        if (memory.namedCreations.get(namedKey) === creation) memory.namedCreations.delete(namedKey);
      }
    },
    orNull: async () => {
      const context = currentExecution(memory, "Actor.ofNamed(...).orNull");
      if (context.frame) await commitSegment(memory, context.frame, false, true);
      const id = await context.root.backend.lookupNamed(type, key);
      const record = id ? await context.root.backend.route(id) : undefined;
      return record ? makeRef<T>(memory, type, record.id) : null;
    },
  };
};
