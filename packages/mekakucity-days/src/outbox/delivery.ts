import { drainHolderOps, releaseForMessage } from "../ref/lifecycle.js";
import { resolveActorMessage } from "@mekakucity/actors/runtime";
import type { RootTransaction } from "../transaction/context.js";
import { isDueOutboxMessage, type DueOutboxMessage, type OutboxMessage } from "./message.js";

export const rollbackOutbox = (root: RootTransaction, messages: OutboxMessage[]): void => {
  for (const message of messages) releaseForMessage(root, message.heldIds, message.id);
};

export const flushOutbox = async (root: RootTransaction, outbox = root.outbox): Promise<void> => {
  await drainHolderOps(root);
  const committedAt = Date.now();
  for (const message of outbox.splice(0)) {
    const due: DueOutboxMessage = isDueOutboxMessage(message)
      ? message
      : resolveActorMessage(message, committedAt);
    await root.backend.deliver(due);
  }
};
