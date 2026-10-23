import { ActorRuntimeError, type ActorDescriptor } from "@mekakucity/actors";
import { cloneOrThrow } from "@mekakucity/actors/runtime";
import { invokeActorAction } from "../action/invoke.js";
import { hold, release } from "../ref/lifecycle.js";
import { collectRefs } from "../ref/surface.js";
import type { RuntimeMemory } from "../runtime/memory.js";
import { currentExecution } from "../transaction/context.js";
import { finishRoot, newRoot } from "../transaction/root.js";
import type { OutboxMessage } from "./message.js";

export const enqueueDetached = (
  memory: RuntimeMemory,
  ref: ActorDescriptor,
  actionName: string,
  args: unknown[],
): void => {
  const context = currentExecution(memory, `Queue detached action ${actionName}`);
  const id = `message_${++memory.sequence.message}`;
  const clonedArgs = cloneOrThrow(
    args,
    (cause) => new ActorRuntimeError(
      "runDetached() arguments must be structuredClone-serializable",
      { cause },
    ),
  );
  const heldIds = new Set<string>([ref.id, ...collectRefs(memory, clonedArgs)]);
  for (const heldId of heldIds) context.root.ownedIds.add(heldId);
  const message: OutboxMessage = {
    id,
    target: { type: ref.type, id: ref.id },
    action: actionName,
    args: clonedArgs,
    heldIds: [...heldIds],
  };
  if (context.frame) context.frame.outbox.push(message);
  else context.root.outbox.push(message);
  context.root.pendingHolds.push(
    Promise.all([...heldIds].map((heldId) => hold(context.root, heldId, `message:${id}`)))
      .then(() => undefined),
  );
};

export const dispatchDetached = async (memory: RuntimeMemory, message: OutboxMessage): Promise<void> => {
  const root = newRoot(memory);
  try {
    await invokeActorAction(memory, root, message.target.id, message.action, [...message.args], undefined, new Set());
    await finishRoot(memory, root, true);
  } catch (error) {
    await finishRoot(memory, root, false);
  } finally {
    for (const id of message.heldIds) await release(root, id, `message:${message.id}`);
  }
};
