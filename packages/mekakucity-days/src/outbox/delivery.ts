import { drainHolderOps, releaseForMessage } from "../ref/lifecycle.js";
import type { RootTransaction } from "../transaction/context.js";
import type { OutboxMessage } from "./message.js";

export const rollbackOutbox = (root: RootTransaction, messages: OutboxMessage[]): void => {
  for (const message of messages) releaseForMessage(root, message.heldIds, message.id);
};

export const flushOutbox = async (root: RootTransaction, outbox = root.outbox): Promise<void> => {
  await drainHolderOps(root);
  for (const message of outbox.splice(0)) await root.backend.deliver(message);
};
