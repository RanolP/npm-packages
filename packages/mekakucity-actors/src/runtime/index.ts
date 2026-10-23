export { actionNameOf, metadataFor } from "../action/decorators.js";
export type { ActorMetadata } from "../action/decorators.js";
export { aggregateCompensationErrors } from "../compensation/aggregate.js";
export { createActorRef } from "../ref/surface.js";
export type { ActorRefSurface } from "../ref/surface.js";
export { collectActorRefIds, hydrateActorRefs, isActorDescriptor } from "../ref/walk.js";
export type { ActorRefHydration } from "../ref/walk.js";
export { assertCloneableResultPrototypes, cloneOrThrow } from "../state/clone.js";
export { deepFreeze } from "../state/freeze.js";
export {
  changedStateFields,
  cloneState,
  createSnapshot,
  restoreSnapshotData,
  restoreState,
  stateFields,
} from "../state/snapshot.js";
export type { ActorSnapshot, ActorStateRecord, StateData } from "../state/snapshot.js";
export { ActorRuntime } from "./actor-runtime.js";
export type { ActorConstructor, ActorDescriptor } from "./actor-runtime.js";
export { ActorRuntimeError, NoActiveActorRuntimeError, NoActiveTransactionError } from "./errors.js";
