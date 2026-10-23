import type { ActorCompensationError } from "@mekakucity/actors";
import { runCompensations } from "../compensation/run.js";
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
  compensations: [],
  outbox: [],
  pendingHolds: [],
  ownedIds: new Set(),
});

export const finishRoot = async (
  memory: RuntimeMemory,
  root: RootTransaction,
  succeeded: boolean,
  cause?: unknown,
): Promise<ActorCompensationError | undefined> => {
  if (succeeded) {
    await flushOutbox(root);
    await releaseOwnedRefs(root);
    return undefined;
  }

  await Promise.all(root.pendingHolds);
  await rollbackOutbox(root, root.outbox.splice(0));
  const compensationError = await runCompensations(memory, root, root.compensations, cause);
  await releaseOwnedRefs(root);
  return compensationError;
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
    const compensationError = await finishRoot(memory, root, false, error);
    throw compensationError ?? error;
  }
};
