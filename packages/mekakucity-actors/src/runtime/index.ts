export { actionNameOf, metadataFor } from "../action/decorators.js";
export type { ActorMetadata } from "../action/decorators.js";
export { actorClassOf, actorClassOrThrow, actorTypeIdOf, actorTypeIdOrThrow } from "../core/actor-type.js";
export { actorRefSurfaceFor, createActorRef } from "../ref/surface.js";
export type { ActorRefSurface } from "../ref/surface.js";
export { socketJsonValue, socketValuesEqual } from "../socket/value.js";
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
  ActorReadInfo,
  ActorReadObserver,
  DueActorMessage,
  PendingActorMessage,
} from "./actor-runtime.js";
export {
  ActorContextUnavailableError,
  ActorRuntimeError,
  ActorTransactionHookError,
  NoActiveActorRuntimeError,
  NoActiveTransactionError,
} from "./errors.js";
export { ActorInvocationContext } from "./actor-context.js";
export type {
  ActorAfterCommit,
  ActorAfterCommitHook,
  ActorCommitInfo,
  ActorCommitListener,
  ActorContext,
  ActorContextProvider,
  ActorEventInfo,
  ActorEventListener,
  ActorTransactionHooks,
} from "./actor-context.js";
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
