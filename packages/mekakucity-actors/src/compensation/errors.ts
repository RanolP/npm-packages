export class ActorCompensationError extends AggregateError {
  constructor(errors: readonly unknown[], cause: unknown) {
    super(errors, "One or more actor compensations failed", { cause });
    this.name = new.target.name;
  }
}
