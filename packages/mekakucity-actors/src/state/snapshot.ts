import { isDeepStrictEqual } from "node:util";
import { metadataFor } from "../action/decorators.js";
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

export const stateFields = (record: ActorStateRecord): string[] =>
  [...metadataFor(record.instance).state];

export const cloneState = (record: ActorStateRecord): StateData => {
  const data: StateData = {};
  for (const key of stateFields(record)) data[key] = (record.instance as Record<string, unknown>)[key];
  return cloneOrThrow(data, (cause) => new ActorStateSerializationError(record.id, cause));
};

export const restoreState = (
  record: ActorStateRecord,
  value: StateData,
  hydrate: (value: unknown) => unknown,
): void => {
  for (const key of stateFields(record)) {
    if (Object.hasOwn(value, key)) {
      (record.instance as Record<string, unknown>)[key] = hydrate(value[key]);
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
