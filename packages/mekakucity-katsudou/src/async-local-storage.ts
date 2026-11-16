interface DenoCore {
  readonly AsyncVariable: new <Value>() => {
    enter(value: Value): unknown;
    get(): Value | undefined;
  };
  setAsyncContext(context: unknown): void;
}

declare const Deno: { readonly core: DenoCore };

class AsyncLocalStorageImpl<Value> {
  readonly #variable = new Deno.core.AsyncVariable<Value | undefined>();

  run<Result, Args extends unknown[]>(store: Value, callback: (...args: Args) => Result, ...args: Args): Result {
    const previous = this.#variable.enter(store);
    try {
      return callback(...args);
    } finally {
      Deno.core.setAsyncContext(previous);
    }
  }

  getStore(): Value | undefined {
    return this.#variable.get();
  }

  exit<Result, Args extends unknown[]>(callback: (...args: Args) => Result, ...args: Args): Result {
    const previous = this.#variable.enter(undefined);
    try {
      return callback(...args);
    } finally {
      Deno.core.setAsyncContext(previous);
    }
  }
}

export const AsyncLocalStorage = AsyncLocalStorageImpl;
