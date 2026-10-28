import { ActorStateSerializationError } from "@mekakucity/actors";
import {
  changedStateFields,
  cloneOrThrow,
  createSnapshot,
  restoreState,
  stateFields,
} from "@mekakucity/actors/runtime";
import { collectRefs, hydrateRefs } from "../ref/surface.js";
import { commitHolderOps, drainHolderOps, dropPendingOps } from "../ref/lifecycle.js";
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
  commitHolderOps(frame, currentIds, preserveDroppedRefs);
  frame.record.heldRefs.clear();
  for (const id of currentIds) frame.record.heldRefs.add(id);
  await drainHolderOps(frame.root);
};

export const commitSegment = async (
  memory: RuntimeMemory,
  frame: ActionFrame,
  force = false,
  preserveDroppedRefs = false,
): Promise<void> => {
  const next = createSnapshot(frame.record);
  const changed = Object.keys(changedStateFields(frame.segment.baseline, next.state, frame.record));
  if (!force && changed.length === 0) return;
  // A forced commit with no state change still settles holder ops, but keeps the version:
  // read observers compare versions, so a read-only action must not look like a write.
  if (changed.length > 0) {
    const nextVersion = frame.record.version + 1;
    const persisted = structuredClone(next.data);
    await frame.root.backend.persist(frame.record.id, persisted, nextVersion);
    for (const key of changed) frame.changed.add(key);
    cacheSnapshot(memory, frame.record.id, nextVersion, next.data);
    memory.emitCommit({
      actor: { type: frame.record.type, id: frame.record.id },
      version: nextVersion,
      changed,
    });
  }
  frame.segment.baseline = next.state;
  await updateStateHolders(memory, frame, next.state, preserveDroppedRefs);
};

export const rollbackAction = async (memory: RuntimeMemory, frame: ActionFrame): Promise<void> => {
  dropPendingOps(frame);
  restoreState(frame.record, frame.initialState, (value) => hydrateRefs(memory, value));
  if (frame.record.version <= frame.startVersion) return;
  const restored = createSnapshot(frame.record);
  const changed = Object.keys(changedStateFields(frame.segment.baseline, restored.state, frame.record));
  const rollbackVersion = frame.record.version + 1;
  const persisted = cloneOrThrow(
    restored.data,
    (cause) => new ActorStateSerializationError(frame.record.id, cause),
  );
  await frame.root.backend.persist(frame.record.id, persisted, rollbackVersion);
  cacheSnapshot(memory, frame.record.id, rollbackVersion, restored.data);
  memory.emitCommit({
    actor: { type: frame.record.type, id: frame.record.id },
    version: rollbackVersion,
    changed,
  });
  await updateStateHolders(memory, frame, restored.state);
  frame.segment.baseline = restored.state;
};
