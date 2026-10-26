import { ActorRuntimeError } from "../runtime/errors.js";

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
