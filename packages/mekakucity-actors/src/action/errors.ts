import { ActorRuntimeError } from "../runtime/errors.js";

export class ActorResultSerializationError extends ActorRuntimeError {
  constructor(actorId: string, actionName: string, cause: unknown) {
    super(`Result from actor ${actorId}.${actionName} must be structured-clone-safe; non-plain prototypes are not preserved`, { cause });
  }
}

export class ActorReentrancyError extends ActorRuntimeError {
  constructor(actorId: string) {
    super(`Actor ${actorId} was re-entered by a suspended call chain`);
  }
}
