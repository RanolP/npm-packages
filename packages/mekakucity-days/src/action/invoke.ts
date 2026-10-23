import {
  ActorKilledError,
  ActorReentrancyError,
  ActorRuntimeError,
  type ActorDescriptor,
} from "@mekakucity/actors";
import {
  changedStateFields,
  cloneState,
  metadataFor,
  restoreSnapshotData,
} from "@mekakucity/actors/runtime";
import { rollbackOutbox } from "../outbox/delivery.js";
import { hold } from "../ref/lifecycle.js";
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
import { discardFrameSpawns, makeFrame, mergeFrame } from "./frame.js";
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
    const frame = makeFrame(memory, record, root, parent, chain);
    return memory.execution.run({ root, frame, chain }, async () => {
      try {
        const callArgs = hydrateRefs(memory, structuredClone(args));
        const value = cloneActionResult(memory, record, actionName, await method.apply(record.instance, callArgs));
        await commitSegment(memory, frame, true);
        mergeFrame(memory, frame);
        for (const id of collectRefs(memory, value)) {
          root.ownedIds.add(id);
          await hold(root, id, `tx:${root.id}`);
        }
        const snapshot = frame.startVersion === baseVersion
          ? changedStateFields(frame.initialState, restoreSnapshotData(record), record)
          : structuredClone(record.snapshot);
        return {
          value: hydrateRefs(memory, value),
          baseVersion,
          startVersion: frame.startVersion,
          version: record.version,
          isDiff: frame.startVersion === baseVersion,
          snapshot,
        };
      } catch (error) {
        await rollbackAction(memory, frame);
        await discardFrameSpawns(frame);
        await Promise.all(root.pendingHolds);
        await rollbackOutbox(root, frame.outbox);
        throw error;
      }
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
  const reply = await invokeActorAction(
    memory,
    context.root,
    ref.id,
    actionName,
    args,
    context.frame,
    context.chain,
    snapshotVersion(memory, ref.id),
  );
  memory.lastReplyForTest = reply;
  if (!sameActor) await applyReply(memory, reply, ref.id);
  return reply.value;
};
