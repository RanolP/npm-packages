import type { ActorDescriptor } from "./actor-runtime.js";
import { ActorContextUnavailableError, ActorTransactionHookError } from "./errors.js";

/** Applications augment this interface with the values available to their actors. */
export interface ActorContext {}

export interface ActorTransactionHooks {
  /** Registers work that runs in reverse registration order after this action rolls back. */
  onRollback(fn: () => void | Promise<void>): void;
  /**
   * Registers work that runs in registration order after this action commits.
   * Durable Object runtimes execute these hooks at most once: an isolate failure after the commit can skip them.
   */
  afterCommit(fn: () => void | Promise<void>): void;
}

export interface ActorContextProvider<Carried = unknown> {
  /**
   * Caller side: pick the serializable value to ship with an action call. Runs inside the caller's
   * async context (for example, a request's AsyncLocalStorage). Must be structuredClone-safe.
   */
  carry(): Carried | undefined;
  /**
   * Callee side: rebuild the context for one action invocation. `carried` is undefined for a detached
   * (scheduled) action and for calls with no carried value. `origin` identifies the actor whose detached
   * invocation started the call chain; it is undefined for chains started outside an actor.
   */
  build(
    carried: Carried | undefined,
    hooks: ActorTransactionHooks,
    self: ActorDescriptor,
    origin?: ActorDescriptor,
  ): ActorContext;
}

type Hook = () => void | Promise<void>;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const runHooks = async (hooks: readonly Hook[]): Promise<unknown[]> => {
  const errors: unknown[] = [];
  for (const hook of hooks) {
    try {
      await hook();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
};

/** Runtime-owned, invocation-scoped context state. */
export class ActorInvocationContext {
  readonly #rollbackHooks: Hook[] = [];
  readonly #afterCommitHooks: Hook[] = [];
  #built = false;
  #context: ActorContext | undefined;
  readonly #provider: ActorContextProvider | undefined;
  readonly #self: ActorDescriptor;

  constructor(
    readonly carried: unknown,
    provider: ActorContextProvider | undefined,
    self: ActorDescriptor,
    readonly origin?: ActorDescriptor,
  ) {
    this.#provider = provider;
    this.#self = self;
  }

  get(): ActorContext {
    if (!this.#provider) throw new ActorContextUnavailableError("No ActorContextProvider is configured");
    if (!this.#built) {
      this.#context = this.#provider.build(this.carried, {
        onRollback: (fn) => this.#rollbackHooks.push(fn),
        afterCommit: (fn) => this.#afterCommitHooks.push(fn),
      }, this.#self, this.origin);
      this.#built = true;
    }
    return this.#context as ActorContext;
  }

  mergeHooksInto(parent: ActorInvocationContext): void {
    parent.#rollbackHooks.push(...this.#rollbackHooks);
    parent.#afterCommitHooks.push(...this.#afterCommitHooks);
  }

  async afterCommit(): Promise<void> {
    const errors = await runHooks([...this.#afterCommitHooks]);
    if (errors.length > 0) {
      throw new ActorTransactionHookError(
        "afterCommit",
        errors,
        `afterCommit hook failure: ${errors.map(describeError).join("; ")}`,
      );
    }
  }

  async afterRollback(actionError: unknown): Promise<void> {
    const errors = await runHooks([...this.#rollbackHooks].reverse());
    if (errors.length > 0) {
      throw new ActorTransactionHookError(
        "onRollback",
        [actionError, ...errors],
        `Actor action failed (${describeError(actionError)}); onRollback hook failure: ${errors.map(describeError).join("; ")}`,
        { cause: actionError },
      );
    }
  }
}
