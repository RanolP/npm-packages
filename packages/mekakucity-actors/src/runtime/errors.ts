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
