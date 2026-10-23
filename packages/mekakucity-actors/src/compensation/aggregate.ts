import { ActorCompensationError } from "./errors.js";

export const aggregateCompensationErrors = (
  cause: unknown,
  errors: readonly unknown[],
): ActorCompensationError | undefined => {
  if (errors.length === 0) return cause instanceof ActorCompensationError ? cause : undefined;
  if (cause instanceof ActorCompensationError) {
    return new ActorCompensationError([...cause.errors, ...errors], cause.cause);
  }
  return new ActorCompensationError(errors, cause);
};
