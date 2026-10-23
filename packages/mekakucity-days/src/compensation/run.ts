import { ActorRuntimeError, type ActorCompensationError } from "@mekakucity/actors";
import {
  actionNameOf,
  aggregateCompensationErrors,
  cloneOrThrow,
  metadataFor,
} from "@mekakucity/actors/runtime";
import { invokeActorAction } from "../action/invoke.js";
import { invokeNested } from "../action/nested.js";
import { flushOutbox } from "../outbox/delivery.js";
import type { OutboxMessage } from "../outbox/message.js";
import { killActor } from "../ref/lifecycle.js";
import { hydrateRefs } from "../ref/surface.js";
import type { RuntimeMemory } from "../runtime/memory.js";
import { commitSegment } from "../state/commit.js";
import { currentExecution, type ExecutionContext, type RootTransaction } from "../transaction/context.js";
import type { Compensation } from "./model.js";

export const runCompensations = async (
  memory: RuntimeMemory,
  root: RootTransaction,
  compensations: Compensation[],
  cause: unknown,
): Promise<ActorCompensationError | undefined> => {
  const outbox: OutboxMessage[] = [];
  const errors: unknown[] = [];
  const parentContext = memory.execution.getStore();
  const context: ExecutionContext = {
    ...(parentContext ?? { chain: new Set<string>() }),
    root,
    compensation: { outbox },
  };
  await memory.execution.run(context, async () => {
    for (const compensation of [...compensations].reverse()) {
      try {
        if (compensation.action === "$runtime.kill") {
          await killActor(root, compensation.actorId);
          continue;
        }
        const activeFrame = memory.execution.getStore()?.frame;
        if (activeFrame?.record.id === compensation.actorId) {
          const method = metadataFor(activeFrame.record.instance).actions.get(compensation.action);
          if (!method) throw new ActorRuntimeError(`Unknown actor action ${compensation.action}`);
          const args = hydrateRefs(memory, [...compensation.args]);
          await invokeNested(
            memory,
            activeFrame,
            compensation.action,
            [...compensation.args],
            () => method.apply(activeFrame.record.instance, args),
          );
          await commitSegment(memory, activeFrame, true, true);
        } else {
          await invokeActorAction(
            memory,
            root,
            compensation.actorId,
            compensation.action,
            [...compensation.args],
            undefined,
            new Set(memory.execution.getStore()?.chain ?? []),
          );
        }
      } catch (error) {
        errors.push(error);
      }
    }
  });
  try {
    await flushOutbox(root, outbox);
  } catch (error) {
    errors.push(error);
  }
  return aggregateCompensationErrors(cause, errors);
};

export const registerDefer = (memory: RuntimeMemory, method: Function, args: unknown[]): void => {
  const context = currentExecution(memory, "defer");
  const frame = context.frame;
  const action = actionNameOf(method);
  if (!frame || !action) {
    throw new ActorRuntimeError("defer() expects this.<@action method> inside an actor action");
  }
  const serializableArgs = cloneOrThrow(
    args,
    (cause) => new ActorRuntimeError("defer() arguments must be structuredClone-serializable", { cause }),
  );
  if (context.compensation) return;
  frame.compensations.push({ actorId: frame.record.id, action, args: serializableArgs });
};
