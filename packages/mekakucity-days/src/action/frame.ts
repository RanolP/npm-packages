import type { ActorRecord } from "../ref/in-memory-store.js";
import type { RuntimeMemory } from "../runtime/memory.js";
import type { ActionFrame, RootTransaction } from "../transaction/context.js";
import { cloneState } from "@mekakucity/actors/runtime";

export const makeFrame = (
  memory: RuntimeMemory,
  record: ActorRecord,
  root: RootTransaction,
  parent: ActionFrame | undefined,
  chain: Set<string>,
): ActionFrame => {
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
};

export const mergeFrame = (_memory: RuntimeMemory, frame: ActionFrame): void => {
  if (frame.parent) {
    frame.parent.compensations.push(...frame.compensations);
    frame.parent.outbox.push(...frame.outbox);
  } else {
    frame.root.compensations.push(...frame.compensations);
    frame.root.outbox.push(...frame.outbox);
  }
};
