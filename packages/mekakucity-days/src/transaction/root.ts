import { flushOutbox, rollbackOutbox } from "../outbox/delivery.js";
import { release } from "../ref/lifecycle.js";
import type { RuntimeMemory } from "../runtime/memory.js";
import type { RootTransaction } from "./context.js";

const releaseOwnedRefs = async (root: RootTransaction): Promise<void> => {
  for (const id of root.ownedIds) {
    const record = await root.backend.route(id);
    if (!record || record.named) continue;
    await release(root, id, `tx:${root.id}`);
  }
};

export const newRoot = (memory: RuntimeMemory): RootTransaction => ({
  id: `transaction_${++memory.sequence.transaction}`,
  backend: memory.backend,
  outbox: [],
  pendingHolds: [],
  ownedIds: new Set(),
});

export const finishRoot = async (
  memory: RuntimeMemory,
  root: RootTransaction,
  succeeded: boolean,
): Promise<void> => {
  if (succeeded) {
    await flushOutbox(root);
    await releaseOwnedRefs(root);
    return;
  }

  await Promise.all(root.pendingHolds);
  await rollbackOutbox(root, root.outbox.splice(0));
  await releaseOwnedRefs(root);
};

export const runTransaction = async <Result>(
  memory: RuntimeMemory,
  work: () => Result | Promise<Result>,
): Promise<Awaited<Result>> => {
  const existing = memory.execution.getStore();
  if (existing) return await work();
  const root = newRoot(memory);
  try {
    const result = await memory.execution.run({ root, chain: new Set() }, work);
    await finishRoot(memory, root, true);
    return await result;
  } catch (error) {
    await finishRoot(memory, root, false);
    throw error;
  }
};
