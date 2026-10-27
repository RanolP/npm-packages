import {
  ActorKilledError,
  ActorReentrancyError,
  ActorRuntimeError,
  type ActorDescriptor,
} from "@mekakucity/actors";
import {
  changedStateFields,
  cloneOrThrow,
  cloneState,
  metadataFor,
  restoreSnapshotData,
} from "@mekakucity/actors/runtime";
import { rollbackOutbox } from "../outbox/delivery.js";
import { discardFrameSpawns, drainHolderOps, holdForTx, settleFrameSpawns } from "../ref/lifecycle.js";
import { collectRefs, hydrateRefs } from "../ref/surface.js";
import type { RuntimeMemory } from "../runtime/memory.js";
import { commitSegment, rollbackAction } from "../state/commit.js";
import {
  cacheBackendSnapshot,
  cloneActionResult,
  cacheSnapshot,
  snapshotVersion,
} from "../state/snapshot.js";
import { currentExecution, type ActionFrame, type RootTransaction } from "../transaction/context.js";
import { makeFrame, mergeFrame } from "./frame.js";
import { invokeNested } from "./nested.js";
import type { ActionReply } from "./reply.js";
import { withMailbox } from "./mailbox.js";

export const invokeActorAction = async (
  memory: RuntimeMemory,
  root: RootTransaction,
  actorId: string,
  actionName: string,
  args: unknown[],
  parent: ActionFrame | undefined,
  inheritedChain: Set<string>,
  baseVersion = -1,
  carried?: unknown,
  origin?: ActorDescriptor,
): Promise<ActionReply> => {
  const record = await root.backend.route(actorId);
  if (!record) throw new ActorKilledError(actorId);

  if (parent?.record.id === actorId) {
    const method = metadataFor(record.instance).actions.get(actionName);
    if (!method) throw new ActorRuntimeError(`Unknown actor action ${actionName}`);
    const hydratedArgs = hydrateRefs(memory, args);
    const value = await invokeNested(
      memory,
      parent,
      actionName,
      hydratedArgs,
      () => method.apply(record.instance, hydratedArgs),
    );
    const state = cloneState(record);
    return {
      value,
      baseVersion,
      startVersion: record.version,
      version: record.version,
      isDiff: true,
      snapshot: changedStateFields(parent.initialState, state, record),
    };
  }

  if (inheritedChain.has(actorId)) throw new ActorReentrancyError(actorId);
  if (parent) await commitSegment(memory, parent, false, true);
  const chain = new Set(inheritedChain);
  chain.add(actorId);

  return withMailbox(record, async () => {
    const method = metadataFor(record.instance).actions.get(actionName);
    if (!method) throw new ActorRuntimeError(`Unknown actor action ${actionName}`);
    const frame = makeFrame(memory, record, root, parent, chain, carried, origin);
    return memory.execution.run({ root, frame, chain }, async () => {
      let reply: ActionReply;
      try {
        const callArgs = hydrateRefs(memory, structuredClone(args));
        const value = cloneActionResult(memory, record, actionName, await method.apply(record.instance, callArgs));
        // Queued before commitSegment so hold(tx) lands before a same-action release(actor) of the returned ref.
        for (const id of collectRefs(memory, value)) {
          holdForTx(frame, id);
        }
        await commitSegment(memory, frame, true);
        mergeFrame(memory, frame);
        settleFrameSpawns(frame);
        await drainHolderOps(root);
        const snapshot = frame.startVersion === baseVersion
          ? changedStateFields(frame.initialState, restoreSnapshotData(record), record)
          : structuredClone(record.snapshot);
        reply = {
          value: hydrateRefs(memory, value),
          baseVersion,
          startVersion: frame.startVersion,
          version: record.version,
          isDiff: frame.startVersion === baseVersion,
          snapshot,
        };
      } catch (error) {
        await rollbackAction(memory, frame);
        discardFrameSpawns(frame);
        rollbackOutbox(root, frame.outbox);
        await drainHolderOps(root);
        await frame.invocation.afterRollback(error);
        throw error;
      }
      const changed = Object.keys(changedStateFields(
        frame.initialState,
        restoreSnapshotData(record),
        record,
      ));
      await frame.invocation.afterCommit(record.version, changed);
      return reply;
    });
  });
};

export const applyReply = async (memory: RuntimeMemory, reply: ActionReply, id: string): Promise<void> => {
  const entry = memory.snapshotCache.get(id);
  if (!reply.isDiff || !entry?.data || entry.version !== reply.baseVersion) {
    const record = await memory.backend.route(id);
    if (record) cacheBackendSnapshot(memory, record);
    else if (!reply.isDiff && reply.snapshot) cacheSnapshot(memory, id, reply.version, reply.snapshot);
    return;
  }
  cacheSnapshot(memory, id, reply.version, { ...entry.data, ...reply.snapshot });
};

export const invokeRefAction = async (
  memory: RuntimeMemory,
  ref: ActorDescriptor,
  actionName: string,
  args: unknown[],
): Promise<unknown> => {
  const context = currentExecution(memory, `Call actor action ${actionName}`);
  const sameActor = context.frame?.record.id === ref.id;
  const carried = context.frame
    ? context.frame.invocation.carried
    : memory.contextProvider
      ? cloneOrThrow(
        memory.contextProvider.carry(),
        (cause) => new ActorRuntimeError("Actor context carried value must be structuredClone-serializable", { cause }),
      )
      : undefined;
  const origin = context.frame?.invocation.origin;
  const reply = await invokeActorAction(
    memory,
    context.root,
    ref.id,
    actionName,
    args,
    context.frame,
    context.chain,
    snapshotVersion(memory, ref.id),
    carried,
    origin,
  );
  memory.lastReplyForTest = reply;
  if (!sameActor) await applyReply(memory, reply, ref.id);
  return reply.value;
};
