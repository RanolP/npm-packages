import type { ActorRecord } from "../ref/in-memory-store.js";
import type { RuntimeMemory } from "../runtime/memory.js";
import type { ActionFrame, RootTransaction } from "../transaction/context.js";
import { cloneState, txHolder } from "@mekakucity/actors/runtime";

export const makeFrame = (
  memory: RuntimeMemory,
  record: ActorRecord,
  root: RootTransaction,
  parent: ActionFrame | undefined,
  chain: Set<string>,
): ActionFrame => {
  const state = cloneState(record);
  const id = `frame_${++memory.sequence.frame}`;
  return {
    id,
    record,
    root,
    parent,
    chain,
    // Same-actor nested calls never release their tx holds on their own (only the root does), so one key is safe.
    txHolder: parent?.record === record ? parent.txHolder : txHolder(root.id, id),
    startVersion: record.version,
    initialState: structuredClone(state),
    baseline: state,
    spawnedIds: new Set(),
    outbox: [],
    pendingOps: [],
  };
};

export const mergeFrame = (_memory: RuntimeMemory, frame: ActionFrame): void => {
  if (frame.parent) frame.parent.pendingOps.push(...frame.pendingOps);
  // Only a same-actor nested frame shares its parent's segment; a cross-actor callee's segment already committed,
  // so its messages are durable and must not be rolled back with the caller.
  if (frame.parent?.record === frame.record) frame.parent.outbox.push(...frame.outbox);
  else frame.root.outbox.push(...frame.outbox);
};
