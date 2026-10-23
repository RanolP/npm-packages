import { isDeepStrictEqual } from "node:util";
import { ActorStateSerializationError } from "@mekakucity/actors";
import {
  cloneOrThrow,
  createSnapshot,
  restoreState,
  stateFields,
} from "@mekakucity/actors/runtime";
import { collectRefs, hydrateRefs } from "../ref/surface.js";
import { killActor } from "../ref/lifecycle.js";
import type { RuntimeMemory } from "../runtime/memory.js";
import type { ActionFrame, StateData } from "../transaction/context.js";
import { cacheSnapshot } from "./snapshot.js";

const stateRefs = (memory: RuntimeMemory, frame: ActionFrame, value: StateData): Set<string> => {
  const refs = new Set<string>();
  for (const key of stateFields(frame.record)) collectRefs(memory, value[key], refs);
  return refs;
};

export const updateStateHolders = async (
  memory: RuntimeMemory,
  frame: ActionFrame,
  value: StateData,
  preserveDroppedRefs = false,
): Promise<void> => {
  const currentIds = stateRefs(memory, frame, value);
  const holder = `actor:${frame.record.id}`;
  for (const id of currentIds) {
    const target = await frame.root.backend.route(id);
    if (!target || target.named) continue;
    target.holders.add(holder);
  }
  for (const oldId of frame.record.heldRefs) {
    if (currentIds.has(oldId)) continue;
    const target = await frame.root.backend.route(oldId);
    if (!target || target.named) continue;
    if (preserveDroppedRefs) {
      frame.root.ownedIds.add(oldId);
      target.holders.add(`tx:${frame.root.id}`);
    }
    target.holders.delete(holder);
    if (target.holders.size === 0) await killActor(frame.root, oldId);
  }
  frame.record.heldRefs.clear();
  for (const id of currentIds) frame.record.heldRefs.add(id);
};

export const commitSegment = async (
  memory: RuntimeMemory,
  frame: ActionFrame,
  force = false,
  preserveDroppedRefs = false,
): Promise<void> => {
  const next = createSnapshot(frame.record);
  const changed = stateFields(frame.record)
    .some((key) => !isDeepStrictEqual(frame.baseline[key], next.state[key]));
  if (!force && !changed) return;
  const nextVersion = frame.record.version + 1;
  const persisted = structuredClone(next.data);
  await frame.root.backend.persist(frame.record.id, persisted, nextVersion);
  cacheSnapshot(memory, frame.record.id, nextVersion, next.data);
  await updateStateHolders(memory, frame, next.state, preserveDroppedRefs);
  frame.baseline = next.state;
};

export const rollbackAction = async (memory: RuntimeMemory, frame: ActionFrame): Promise<void> => {
  restoreState(frame.record, frame.initialState, (value) => hydrateRefs(memory, value));
  if (frame.record.version <= frame.startVersion) return;
  const restored = createSnapshot(frame.record);
  const rollbackVersion = frame.record.version + 1;
  const persisted = cloneOrThrow(
    restored.data,
    (cause) => new ActorStateSerializationError(frame.record.id, cause),
  );
  await frame.root.backend.persist(frame.record.id, persisted, rollbackVersion);
  cacheSnapshot(memory, frame.record.id, rollbackVersion, restored.data);
  await updateStateHolders(memory, frame, restored.state);
  frame.baseline = restored.state;
};
