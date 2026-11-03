import { isDeepStrictEqual } from "node:util";
import { metadataFor, privateStateAccessorsFor } from "../action/decorators.js";
import { ActorStateSerializationError } from "./errors.js";
import { cloneOrThrow } from "./clone.js";

export type StateData = Record<string, unknown>;

export interface ActorStateRecord {
  readonly id: string;
  readonly instance: object;
  readonly snapshot: Readonly<StateData>;
}

export interface ActorSnapshot {
  readonly state: StateData;
  readonly data: Readonly<StateData>;
}

interface BoundStateAccessor {
  readonly get: () => unknown;
  readonly set: (value: unknown) => void;
}

const stateAccessors = (record: ActorStateRecord): Map<string, BoundStateAccessor> => {
  const metadata = metadataFor(record.instance);
  const instance = record.instance as Record<string, unknown>;
  const accessors = new Map<string, BoundStateAccessor>();
  for (const key of metadata.state) {
    accessors.set(key, {
      get: () => instance[key],
      set: (value) => { instance[key] = value; },
    });
  }
  for (const [key, accessor] of privateStateAccessorsFor(record.instance)) {
    accessors.set(key, {
      get: () => accessor.get(record.instance),
      set: (value) => accessor.set(record.instance, value),
    });
  }
  return accessors;
};

export const stateFields = (record: ActorStateRecord): string[] =>
  [...stateAccessors(record).keys()];

export const cloneState = (record: ActorStateRecord): StateData => {
  const data: StateData = {};
  for (const [key, accessor] of stateAccessors(record)) data[key] = accessor.get();
  return cloneOrThrow(data, (cause) => new ActorStateSerializationError(record.id, cause));
};

export const restoreState = (
  record: ActorStateRecord,
  value: StateData,
  hydrate: (value: unknown) => unknown,
): void => {
  for (const [key, accessor] of stateAccessors(record)) {
    if (Object.hasOwn(value, key)) {
      accessor.set(hydrate(value[key]));
    }
  }
};

export const createSnapshot = (record: ActorStateRecord): ActorSnapshot => {
  const state = cloneState(record);
  const data = cloneOrThrow(state, (cause) => new ActorStateSerializationError(record.id, cause));
  return { state, data };
};

export const changedStateFields = (
  before: StateData,
  after: StateData,
  record: ActorStateRecord,
): StateData => {
  const diff: StateData = {};
  for (const key of stateFields(record)) {
    if (!isDeepStrictEqual(before[key], after[key])) diff[key] = after[key];
  }
  return diff;
};

export const restoreSnapshotData = (record: ActorStateRecord): StateData => {
  const data: StateData = {};
  for (const key of stateFields(record)) data[key] = record.snapshot[key];
  return structuredClone(data);
};
