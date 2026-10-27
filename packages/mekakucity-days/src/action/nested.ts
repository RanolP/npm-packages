import { NoActiveTransactionError } from "@mekakucity/actors";
import { rollbackOutbox } from "../outbox/delivery.js";
import { discardFrameSpawns, drainHolderOps, holdForTx, settleFrameSpawns } from "../ref/lifecycle.js";
import { collectRefs, hydrateRefs } from "../ref/surface.js";
import type { RuntimeMemory } from "../runtime/memory.js";
import { rollbackAction } from "../state/commit.js";
import { cloneActionResult } from "../state/snapshot.js";
import { currentExecution, type ActionFrame } from "../transaction/context.js";
import { makeFrame, mergeFrame } from "./frame.js";

export const invokeNested = async (
  memory: RuntimeMemory,
  parent: ActionFrame,
  actionName: string,
  _args: unknown[],
  run: () => unknown,
): Promise<unknown> => {
  const frame = makeFrame(
    memory,
    parent.record,
    parent.root,
    parent,
    new Set(parent.chain),
    parent.invocation.carried,
    parent.invocation.origin,
  );
  return memory.execution.run(
    { root: frame.root, frame, chain: frame.chain },
    async () => {
      let value: unknown;
      try {
        value = cloneActionResult(memory, frame.record, actionName, await run());
        for (const id of collectRefs(memory, value)) {
          holdForTx(frame, id);
        }
        mergeFrame(memory, frame);
        settleFrameSpawns(frame);
        await drainHolderOps(frame.root);
      } catch (error) {
        await rollbackAction(memory, frame);
        discardFrameSpawns(frame);
        rollbackOutbox(frame.root, frame.outbox);
        await drainHolderOps(frame.root);
        await frame.invocation.afterRollback(error);
        throw error;
      }
      frame.invocation.mergeHooksInto(parent.invocation);
      return hydrateRefs(memory, value);
    },
  );
};

export const invokeLocal = async (
  memory: RuntimeMemory,
  instance: object,
  actionName: string,
  args: unknown[],
  run: () => unknown,
): Promise<unknown> => {
  const context = currentExecution(memory, `Call action ${actionName}`);
  const actorId = memory.instanceIds.get(instance);
  if (!actorId || !context.frame || context.frame.record.id !== actorId) {
    throw new NoActiveTransactionError(`Call action ${actionName} outside its owning actor`);
  }
  return invokeNested(memory, context.frame, actionName, args, run);
};
