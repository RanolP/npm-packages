import { release } from "../ref/lifecycle.js";
import type { RootTransaction } from "../transaction/context.js";
import type { OutboxMessage } from "./message.js";

export const rollbackOutbox = async (root: RootTransaction, messages: OutboxMessage[]): Promise<void> => {
  for (const message of messages) {
    for (const id of message.heldIds) await release(root, id, `message:${message.id}`);
  }
};

export const flushOutbox = async (root: RootTransaction, outbox = root.outbox): Promise<void> => {
  await Promise.all(root.pendingHolds);
  for (const message of outbox.splice(0)) await root.backend.deliver(message);
};
