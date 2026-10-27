export class ActorRuntimeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class NoActiveActorRuntimeError extends ActorRuntimeError {
  constructor(operation: string) {
    super(`${operation} requires an active ActorRuntime; call runtime.run(() => ...) first`);
  }
}

export class NoActiveTransactionError extends ActorRuntimeError {
  constructor(operation: string) {
    super(`${operation} requires an active ActorRuntime.run()`);
  }
}

export class ActorContextUnavailableError extends ActorRuntimeError {
  constructor(reason = "Actor.ctx is only available during an active actor action", options?: ErrorOptions) {
    super(`Actor context is unavailable: ${reason}`, options);
  }
}

export class ActorTransactionHookError extends AggregateError {
  constructor(
    readonly phase: "onRollback" | "afterCommit",
    errors: Iterable<unknown>,
    message: string,
    options?: ErrorOptions,
  ) {
    super(errors, message, options);
    this.name = new.target.name;
  }
}
