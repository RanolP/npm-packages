export { actionNameOf, metadataFor } from "../action/decorators.js";
export type { ActorMetadata } from "../action/decorators.js";
export { actorClassOf, actorClassOrThrow, actorTypeIdOf, actorTypeIdOrThrow } from "../core/actor-type.js";
export { actorRefSurfaceFor, createActorRef } from "../ref/surface.js";
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
export { ActorRuntime, resolveActorMessage, resolveDueAt } from "./actor-runtime.js";
export type {
  ActorConstructor,
  ActorDescriptor,
  ActorDetachedSchedule,
  DueActorMessage,
  PendingActorMessage,
} from "./actor-runtime.js";
export { ActorRuntimeError, NoActiveActorRuntimeError, NoActiveTransactionError } from "./errors.js";
export {
  NAMED_ROOT,
  actorHolder,
  applyHolderOp,
  diffHeldRefs,
  discardSpawnOps,
  frameHolder,
  messageHolder,
  messageReleaseOps,
  recordTxHold,
  settleSpawnOps,
  txHolder,
  txReleaseOps,
} from "../ref/holders.js";
export type { HolderOp, TxHold } from "../ref/holders.js";
