import type { RootTransaction } from "../transaction/context.js";

export const hold = async (root: RootTransaction, id: string, holder: string): Promise<void> => {
  const record = await root.backend.route(id);
  if (!record || record.named) return;
  record.holders.add(holder);
};

export const release = async (root: RootTransaction, id: string, holder: string): Promise<void> => {
  const record = await root.backend.route(id);
  if (!record || record.named) return;
  record.holders.delete(holder);
  if (record.holders.size === 0) await killActor(root, id);
};

export const killActor = async (root: RootTransaction, id: string): Promise<void> => {
  const record = await root.backend.route(id);
  if (!record || record.named) return;
  await root.backend.kill(id);
  // Anonymous reference cycles keep each other's actor-id holders and intentionally leak.
  for (const childId of record.heldRefs) {
    const child = await root.backend.route(childId);
    if (!child || child.named) continue;
    child.holders.delete(`actor:${id}`);
    if (child.holders.size === 0) await killActor(root, childId);
  }
};
