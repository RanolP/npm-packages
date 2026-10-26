import {
  ActorKilledError,
  type Actor,
  type ActorDescriptor,
  type ActorRef,
} from "@mekakucity/actors";
import {
  collectActorRefIds,
  actorRefSurfaceFor,
  createActorRef,
  hydrateActorRefs,
  isActorDescriptor,
} from "@mekakucity/actors/runtime";
import type { RuntimeMemory } from "../runtime/memory.js";
import { commitSegment } from "../state/commit.js";
import { cacheBackendSnapshot } from "../state/snapshot.js";
import { currentExecution } from "../transaction/context.js";

export const typeName = (memory: RuntimeMemory, ctor: Function): string => {
  let id = memory.typeIds.get(ctor);
  if (!id) {
    id = ctor.name || `ActorType${memory.knownTypes.size + 1}`;
    memory.typeIds.set(ctor, id);
  }
  return id;
};

export const isKnownRef = <T extends Actor<unknown, unknown>>(
  memory: RuntimeMemory,
  value: object,
): value is ActorRef<T> => memory.refs.has(value);

const isKnownActorDescriptor = (
  memory: RuntimeMemory,
  value: unknown,
): value is ActorDescriptor => isActorDescriptor(value, (type) => memory.knownTypes.has(type));

export const makeRef = <T extends Actor<unknown, unknown>>(
  memory: RuntimeMemory,
  type: string,
  id: string,
): ActorRef<T> => {
  const ctor = memory.knownTypes.get(type);
  const ref = createActorRef<T>(
    { type, id },
    ctor ? actorRefSurfaceFor(ctor) : { values: [], actions: [], getters: [] },
  );
  memory.refs.add(ref);
  memory.snapshotCache.track(ref, id);
  return ref;
};

export const ensureRef = <T extends Actor<unknown, unknown>>(
  memory: RuntimeMemory,
  value: ActorDescriptor,
): ActorRef<T> => isKnownRef<T>(memory, value) ? value : makeRef<T>(memory, value.type, value.id);

export const hydrateRefs = <T>(memory: RuntimeMemory, value: T): T => hydrateActorRefs(value, {
  isKnownRef: (candidate) => isKnownRef(memory, candidate),
  isDescriptor: (candidate) => isKnownActorDescriptor(memory, candidate),
  toRef: (descriptor) => makeRef(memory, descriptor.type, descriptor.id),
});

export const collectRefs = (
  memory: RuntimeMemory,
  value: unknown,
  ids?: Set<string>,
): Set<string> => collectActorRefIds(value, (candidate) => isKnownActorDescriptor(memory, candidate), ids);

export const refreshActorValues = async <T extends Actor<unknown, unknown>>(
  memory: RuntimeMemory,
  ref: ActorRef<T> | ActorDescriptor,
): Promise<ActorRef<T>> => {
  const context = currentExecution(memory, "Actor.refreshValues");
  if (context.frame) await commitSegment(memory, context.frame, false, true);
  const normalized = ensureRef<T>(memory, ref);
  const record = await context.root.backend.route(normalized.id);
  if (!record) throw new ActorKilledError(normalized.id);
  cacheBackendSnapshot(memory, record);
  return normalized;
};
