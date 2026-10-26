import { flushOutbox, rollbackOutbox } from "../outbox/delivery.js";
import { drainHolderOps, releaseOwnedRefs } from "../ref/lifecycle.js";
import type { RuntimeMemory } from "../runtime/memory.js";
import type { RootTransaction } from "./context.js";

export const newRoot = (memory: RuntimeMemory): RootTransaction => ({
  id: `transaction_${++memory.sequence.transaction}`,
  backend: memory.backend,
  outbox: [],
  holderQueue: [],
  owned: new Map(),
});

export const finishRoot = async (
  memory: RuntimeMemory,
  root: RootTransaction,
  succeeded: boolean,
): Promise<void> => {
  if (succeeded) {
    await flushOutbox(root);
    releaseOwnedRefs(root);
    await drainHolderOps(root);
    return;
  }

  // Messages from committed top-frame segments survive root failure; root-context sends die with the root.
  const all = root.outbox.splice(0);
  rollbackOutbox(root, all.filter((m) => m.rootContext));
  root.outbox.push(...all.filter((m) => !m.rootContext));
  await flushOutbox(root);
  releaseOwnedRefs(root);
  await drainHolderOps(root);
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
