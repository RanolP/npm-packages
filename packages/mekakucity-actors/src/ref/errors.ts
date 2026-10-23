import { ActorRuntimeError } from "../runtime/errors.js";

export class ActorKilledError extends ActorRuntimeError {
  constructor(actorId: string) {
    super(`Actor ${actorId} has been killed`);
  }
}
