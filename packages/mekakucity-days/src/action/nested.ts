import { NoActiveTransactionError } from "@mekakucity/actors";
import { rollbackOutbox } from "../outbox/delivery.js";
import { hold } from "../ref/lifecycle.js";
import { collectRefs, hydrateRefs } from "../ref/surface.js";
import type { RuntimeMemory } from "../runtime/memory.js";
import { rollbackAction } from "../state/commit.js";
import { cloneActionResult } from "../state/snapshot.js";
import { currentExecution, type ActionFrame } from "../transaction/context.js";
import { discardFrameSpawns, makeFrame, mergeFrame } from "./frame.js";

export const invokeNested = async (
  memory: RuntimeMemory,
  parent: ActionFrame,
  actionName: string,
  _args: unknown[],
  run: () => unknown,
): Promise<unknown> => {
  const frame = makeFrame(memory, parent.record, parent.root, parent, new Set(parent.chain));
  return memory.execution.run(
    { root: frame.root, frame, chain: frame.chain },
    async () => {
      try {
        const value = cloneActionResult(memory, frame.record, actionName, await run());
        for (const id of collectRefs(memory, value)) {
          frame.root.ownedIds.add(id);
          await hold(frame.root, id, `tx:${frame.root.id}`);
        }
        mergeFrame(memory, frame);
        return hydrateRefs(memory, value);
      } catch (error) {
        await rollbackAction(memory, frame);
        await discardFrameSpawns(frame);
        await Promise.all(frame.root.pendingHolds);
        await rollbackOutbox(frame.root, frame.outbox);
        throw error;
      }
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
