import {
  ActorResultSerializationError,
  ActorSnapshotUnavailableError,
  type ActorDescriptor,
} from "@mekakucity/actors";
import {
  assertCloneableResultPrototypes,
  cloneOrThrow,
  deepFreeze,
  isActorDescriptor,
} from "@mekakucity/actors/runtime";
import type { ActorRecord } from "../ref/in-memory-store.js";
import { hydrateRefs } from "../ref/surface.js";
import type { RuntimeMemory } from "../runtime/memory.js";
import { currentExecution, type StateData } from "../transaction/context.js";

export const cloneActionResult = <Value>(
  memory: RuntimeMemory,
  record: ActorRecord,
  actionName: string,
  value: Value,
): Value => {
  try {
    assertCloneableResultPrototypes(
      value,
      (candidate) => memory.refs.has(candidate),
      (candidate) => isActorDescriptor(candidate, (type) => memory.knownTypes.has(type)),
    );
  } catch (cause) {
    throw new ActorResultSerializationError(record.id, actionName, cause);
  }
  return cloneOrThrow(value, (cause) => new ActorResultSerializationError(record.id, actionName, cause));
};

export const cacheSnapshot = (
  memory: RuntimeMemory,
  id: string,
  version: number,
  data: Readonly<StateData>,
): void => memory.snapshotCache.install(id, version, data);

export const cacheBackendSnapshot = (memory: RuntimeMemory, record: ActorRecord): void => cacheSnapshot(
  memory,
  record.id,
  record.version,
  structuredClone(record.snapshot),
);

export const snapshotVersion = (memory: RuntimeMemory, id: string): number =>
  memory.snapshotCache.get(id)?.version ?? -1;

export const snapshotData = (memory: RuntimeMemory, id: string): Readonly<StateData> => {
  const entry = memory.snapshotCache.get(id);
  if (!entry?.data || entry.version < 0) throw new ActorSnapshotUnavailableError(id);
  return entry.data;
};

export const readSnapshotValue = (memory: RuntimeMemory, ref: ActorDescriptor, key: string): unknown => {
  currentExecution(memory, `Read actor ref ${ref.id}`);
  return deepFreeze(hydrateRefs(memory, structuredClone(snapshotData(memory, ref.id)[key])));
};
