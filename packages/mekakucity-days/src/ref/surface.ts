import {
  ActorKilledError,
  type Actor,
  type ActorDescriptor,
  type ActorRef,
} from "@mekakucity/actors";
import {
  collectActorRefIds,
  actorClassOrThrow,
  actorRefSurfaceFor,
  actorTypeIdOrThrow,
  createActorRef,
  hydrateActorRefs,
  isActorDescriptor,
} from "@mekakucity/actors/runtime";
import type { RuntimeMemory } from "../runtime/memory.js";
import { commitSegment } from "../state/commit.js";
import { cacheBackendSnapshot } from "../state/snapshot.js";
import { currentExecution } from "../transaction/context.js";

/** The @actor id of `ctor`; throws, naming the class, when it lacks the decorator. */
export const typeName = (ctor: Function): string => actorTypeIdOrThrow(ctor);

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
  // The registry, not memory.knownTypes, so a class re-defined under the same id (HMR) gives the newer surface.
  const ref = createActorRef<T>({ type, id }, actorRefSurfaceFor(actorClassOrThrow(type)));
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
): Promise<{ ref: ActorRef<T>; version: number }> => {
  const context = currentExecution(memory, "Actor.refreshValues");
  if (context.frame) await commitSegment(memory, context.frame, false, true);
  const normalized = ensureRef<T>(memory, ref);
  const record = await context.root.backend.route(normalized.id);
  if (!record) throw new ActorKilledError(normalized.id);
  cacheBackendSnapshot(memory, record);
  return { ref: normalized, version: record.version };
};
