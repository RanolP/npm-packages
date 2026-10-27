import type { ActorDescriptor } from "@mekakucity/actors";
import type { ActorRecord } from "../ref/in-memory-store.js";
import type { RuntimeMemory } from "../runtime/memory.js";
import type { ActionFrame, RootTransaction } from "../transaction/context.js";
import { ActorInvocationContext, cloneState, resolveActorMessage, txHolder } from "@mekakucity/actors/runtime";

export const makeFrame = (
  memory: RuntimeMemory,
  record: ActorRecord,
  root: RootTransaction,
  parent: ActionFrame | undefined,
  chain: Set<string>,
  carried: unknown,
  origin?: ActorDescriptor,
): ActionFrame => {
  const state = cloneState(record);
  const id = `frame_${++memory.sequence.frame}`;
  return {
    id,
    record,
    root,
    parent,
    chain,
    invocation: new ActorInvocationContext(
      carried,
      memory.contextProvider,
      { type: record.type, id: record.id },
      origin,
    ),
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
  else {
    const committedAt = Date.now();
    frame.root.outbox.push(...frame.outbox.map((message) => resolveActorMessage(message, committedAt)));
  }
};
