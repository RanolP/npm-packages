import {
  NAMED_ROOT,
  diffHeldRefs,
  discardSpawnOps,
  frameHolder,
  messageHolder,
  messageReleaseOps,
  recordTxHold,
  settleSpawnOps,
  txHolder,
  txReleaseOps,
  type HolderOp,
} from "@mekakucity/actors/runtime";
import type { ActionFrame, RootTransaction } from "../transaction/context.js";

// Every op below is only queued; the target applies it on its own side
// (InMemoryStore.applyHolderOp), the same way a remote actor would receive it.

/** The creator's holder for a new actor; a root-context create gets its own tx holder (`txHolder(root, id)`). */
export const creationHolder = (named: boolean, root: RootTransaction, frame: ActionFrame | undefined, id: string): string =>
  named ? NAMED_ROOT : frame ? frameHolder(frame.id) : txHolder(root.id, id);

/** Resolves once every queued op and the releases a collection cascades into have been applied. */
export const drainHolderOps = async (root: RootTransaction): Promise<void> => {
  while (root.holderQueue.length > 0 || root.draining) {
    if (root.draining) {
      await root.draining;
      continue;
    }
    const pass = (async () => {
      for (let op = root.holderQueue.shift(); op; op = root.holderQueue.shift()) {
        root.holderQueue.push(...await root.backend.applyHolderOp(op));
      }
    })();
    root.draining = pass;
    try {
      await pass;
    } finally {
      root.draining = undefined;
    }
  }
};

const queue = (root: RootTransaction, ops: HolderOp[]): void => {
  root.holderQueue.push(...ops);
};

/** Holds a ref a call hands to its root under that call's tx holder, and records it for release at root end. */
export const holdForTx = (frame: ActionFrame, id: string): void => {
  recordTxHold(frame.root.owned, id, frame.txHolder);
  queue(frame.root, [{ kind: "hold", target: id, holder: frame.txHolder }]);
};

export const releaseOwnedRefs = (root: RootTransaction): void =>
  queue(root, txReleaseOps(root.owned.values()));

/** Message holds ride with the sender's next segment commit, so a rolled-back segment never sends them. */
export const holdForMessage = (root: RootTransaction, frame: ActionFrame | undefined, ids: readonly string[], messageId: string): void => {
  const ops = ids.map((target): HolderOp => ({ kind: "hold", target, holder: messageHolder(messageId) }));
  if (frame) frame.pendingOps.push(...ops);
  else queue(root, ops);
};

/** Releases are idempotent, so releasing a hold that was never sent (rolled-back segment) is harmless. */
export const releaseForMessage = (root: RootTransaction, ids: readonly string[], messageId: string): void =>
  queue(root, messageReleaseOps({ id: messageId, heldIds: ids }));

/** Sends the segment's pending ops, then the diff of held refs; hold(tx) precedes release(actor) for preserved drops. */
export const commitHolderOps = (
  frame: ActionFrame,
  next: ReadonlySet<string>,
  preserveDroppedRefs: boolean,
): void => {
  const { root, record } = frame;
  const diff = diffHeldRefs(record.id, record.heldRefs, next, preserveDroppedRefs ? frame.txHolder : undefined);
  for (const op of diff) if (op.holder === frame.txHolder) recordTxHold(root.owned, op.target, frame.txHolder);
  queue(root, [...frame.pendingOps.splice(0), ...diff]);
};

export const dropPendingOps = (frame: ActionFrame): void => {
  frame.pendingOps.length = 0;
};

/** Spawns stay held by their frame until the frame commits (handed up or released) or rolls back (released). */
export const settleFrameSpawns = (frame: ActionFrame): void => {
  queue(frame.root, settleSpawnOps(frame.spawnedIds, frame.id, frame.parent?.id));
  if (frame.parent) for (const id of frame.spawnedIds) frame.parent.spawnedIds.add(id);
};

export const discardFrameSpawns = (frame: ActionFrame): void =>
  queue(frame.root, discardSpawnOps(frame.spawnedIds, frame.id));
