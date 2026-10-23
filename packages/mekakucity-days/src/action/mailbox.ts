import { ActorKilledError } from "@mekakucity/actors";
import type { ActorRecord } from "../ref/in-memory-store.js";

export const withMailbox = async <T>(record: ActorRecord, work: () => Promise<T>): Promise<T> => {
  const previous = record.mailbox.tail;
  const { promise: lock, resolve: unlock } = Promise.withResolvers<void>();
  record.mailbox.tail = previous.then(() => lock, () => lock);
  await previous;
  try {
    if (record.killed) throw new ActorKilledError(record.id);
    return await work();
  } finally {
    unlock();
  }
};
