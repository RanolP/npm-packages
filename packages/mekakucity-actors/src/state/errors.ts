import { ActorRuntimeError } from "../runtime/errors.js";

export class ActorStateSerializationError extends ActorRuntimeError {
  constructor(actorId: string, cause: unknown) {
    super(`Actor ${actorId} state must be structuredClone-serializable`, { cause });
  }
}

export class ActorSnapshotUnavailableError extends ActorRuntimeError {
  constructor(actorId: string) {
    super(`Actor ${actorId} has no cached snapshot; call Actor.refreshValues(ref) first`);
  }
}
