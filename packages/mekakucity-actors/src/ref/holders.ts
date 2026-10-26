export const NAMED_ROOT = "named-root";
export const actorHolder = (id: string): string => `actor:${id}`;
export const messageHolder = (id: string): string => `message:${id}`;
/**
 * One call's hold on behalf of a root transaction. Keyed per call, not per root: a callee that fails after its
 * commit releases its own holds, and must not take with it a hold another call in the same root placed on the
 * same ref.
 */
export const txHolder = (rootId: string, callId: string): string => `tx:${rootId}/${callId}`;
export const frameHolder = (id: string): string => `frame:${id}`;

export type HolderOp = { kind: "hold" | "release"; target: string; holder: string };

/** Hold and release are idempotent set operations, so a redelivered op is harmless. */
export const applyHolderOp = (holders: Set<string>, op: HolderOp): { collect: boolean } => {
  if (op.kind === "hold") {
    holders.add(op.holder);
    return { collect: false };
  }
  holders.delete(op.holder);
  return { collect: holders.size === 0 };
};

/**
 * Ops that move an actor's committed held refs from `prev` to `next`.
 * A dropped ref the root transaction must keep alive gets hold(`preserveFor`, a
 * {@link txHolder}) before release(actor), so the holder set never passes through empty.
 */
export const diffHeldRefs = (
  actorId: string,
  prev: Iterable<string>,
  next: ReadonlySet<string>,
  preserveFor?: string,
): HolderOp[] => {
  const holder = actorHolder(actorId);
  const ops: HolderOp[] = [];
  for (const target of next) ops.push({ kind: "hold", target, holder });
  for (const target of prev) {
    if (next.has(target)) continue;
    if (preserveFor !== undefined) ops.push({ kind: "hold", target, holder: preserveFor });
    ops.push({ kind: "release", target, holder });
  }
  return ops;
};

/** Spawns stay held by their frame until it commits (handed to the parent frame, else just released). */
export const settleSpawnOps = (spawned: Iterable<string>, frameId: string, parentFrameId?: string): HolderOp[] => {
  const ops: HolderOp[] = [];
  for (const target of spawned) {
    if (parentFrameId !== undefined) ops.push({ kind: "hold", target, holder: frameHolder(parentFrameId) });
    ops.push({ kind: "release", target, holder: frameHolder(frameId) });
  }
  return ops;
};

/** A rolled-back frame releases its spawns, newest first. */
export const discardSpawnOps = (spawned: Iterable<string>, frameId: string): HolderOp[] =>
  [...spawned].reverse().map((target) => ({ kind: "release", target, holder: frameHolder(frameId) }));

/** Releases the message: holds of a delivered or dropped message; `exceptTarget` skips the message's own target actor. */
export const messageReleaseOps = (
  message: { id: string; heldIds: readonly string[]; target?: { id: string } },
  options: { exceptTarget?: boolean } = {},
): HolderOp[] =>
  message.heldIds
    .filter((target) => !(options.exceptTarget && target === message.target?.id))
    .map((target) => ({ kind: "release", target, holder: messageHolder(message.id) }));

/** A ref a root transaction holds through one call's {@link txHolder}; released when the root ends. */
export interface TxHold {
  readonly target: string;
  readonly holder: string;
}

/** Records a tx hold once per (holder, target) in a root's set of owned holds. */
export const recordTxHold = (owned: Map<string, TxHold>, target: string, holder: string): void => {
  owned.set(`${holder}\0${target}`, { target, holder });
};

export const txReleaseOps = (holds: Iterable<TxHold>): HolderOp[] =>
  [...holds].map(({ target, holder }) => ({ kind: "release", target, holder }));
