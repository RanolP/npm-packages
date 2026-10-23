import type { ActorRecord } from "../ref/in-memory-store.js";
import { killActor } from "../ref/lifecycle.js";
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
    spawnedIds: new Set(),
    outbox: [],
  };
};

export const mergeFrame = (_memory: RuntimeMemory, frame: ActionFrame): void => {
  if (frame.parent) {
    for (const id of frame.spawnedIds) frame.parent.spawnedIds.add(id);
    frame.parent.outbox.push(...frame.outbox);
  } else {
    frame.root.outbox.push(...frame.outbox);
  }
};

export const discardFrameSpawns = async (frame: ActionFrame): Promise<void> => {
  for (const id of [...frame.spawnedIds].reverse()) await killActor(frame.root, id);
};
