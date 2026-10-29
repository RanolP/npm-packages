import { ActorRuntimeError } from "../runtime/errors.js";

export class ActorNotFoundError extends ActorRuntimeError {
  constructor(
    readonly type: string,
    readonly key: string,
  ) {
    super(`Actor ${type} "${key}" does not exist`);
  }
}

export class ActorKilledError extends ActorRuntimeError {
  constructor(actorId: string) {
    super(`Actor ${actorId} has been killed`);
  }
}

export class ActorSelfRefUnavailableError extends ActorRuntimeError {
  constructor(options?: ErrorOptions) {
    super("Actor.asRef is available only after actor construction and during an active actor action", options);
  }
}

export class ActorScheduleError extends ActorRuntimeError {
  constructor(message: string) {
    super(`Invalid actor schedule: ${message}`);
  }
}
