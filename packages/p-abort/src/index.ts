/**
 * Error thrown when an operation is aborted.
 */
export class AbortedError extends Error {
  name = 'AbortedError';
}

/**
 * Utility type to exclude functions from a type.
 */
type NotFunction<T> = T extends (...params: readonly any[]) => any ? never : T;

/**
 * Creates an abortable asynchronous operation.
 *
 * @template TParams - The parameters of the operation
 * @template TReturn - The return type of the operation
 * @param fn - A function that receives an abort-aware utility and returns an async operation
 * @returns A function that returns a promise with an additional `abort()` method
 *
 * @example
 * ```typescript
 * const operation = abortable($ => async (id: string) => {
 *   const user = await $(fetchUser(id));
 *   const posts = await $(fetchPosts(user.id));
 *   return posts;
 * });
 *
 * const promise = operation('user123');
 * promise.abort(); // Cancel the operation
 *
 * const result = await promise;
 * if (result.ok) {
 *   console.log('Success:', result.data);
 * } else {
 *   console.log('Operation was aborted');
 * }
 * ```
 */
export function abortable<TParams extends readonly unknown[], TReturn>(
  fn: (
    $: AbortableUtility,
  ) => (...params: TParams) => TReturn | PromiseLike<TReturn>,
): AbortableOperation<TParams, TReturn> {
  return (...params) => {
    const control = new AbortController();
    const cleanupFunctions: (() => void)[] = [];

    /**
     * Abort-aware utility for wrapping promises and functions.
     */
    function $<const UReturn>(
      value: NotFunction<UReturn>,
    ): Promise<Awaited<UReturn>>;
    function $<const UReturn, UParams extends readonly unknown[]>(
      g: (...params: UParams) => UReturn | PromiseLike<UReturn>,
    ): (...params: UParams) => Promise<UReturn>;
    function $<UReturn, UParams extends readonly unknown[]>(
      g:
        | PromiseLike<UReturn>
        | UReturn
        | ((...params: UParams) => UReturn | PromiseLike<UReturn>),
    ): Promise<UReturn> | ((...params: UParams) => Promise<UReturn>) {
      if (typeof g === 'function') {
        return async (...params: UParams): Promise<UReturn> => {
          if (control.signal.aborted) throw new AbortedError();
          const result = await (
            g as unknown as (
              ...params: UParams
            ) => UReturn | PromiseLike<UReturn>
          )(...params);
          if (control.signal.aborted) throw new AbortedError();
          return result;
        };
      }
      return $<UReturn, []>(() => g)();
    }

    /**
     * Registers a cleanup function to be called when the operation completes or is aborted.
     * Cleanup functions are executed in reverse order of registration (LIFO).
     *
     * @param fn - The cleanup function to register
     *
     * @example
     * ```typescript
     * abortable($ => async (file: File) => {
     *   const handle = await openFile(file);
     *   $.cleanup(() => handle.close());
     *   return processFile(handle);
     * });
     * ```
     */
    $.cleanup = (fn: () => void) => {
      if (control.signal.aborted) {
        fn();
        return;
      }
      cleanupFunctions.push(fn);
    };

    $.abort = () => {
      control.abort();
    };

    $.all = <T extends readonly unknown[] | []>(params: T) =>
      Promise.all<T>(params.map((p) => $(p))) as Promise<{
        -readonly [P in keyof T]: Awaited<T[P]>;
      }>;

    const runCleanup = () => {
      for (const fn of cleanupFunctions.reverse()) {
        try {
          fn();
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    };

    return Object.assign(
      (async () => {
        try {
          const result = { ok: true, data: await fn($)(...params) } as const;
          runCleanup();
          return result;
        } catch (e) {
          runCleanup();
          if (e instanceof AbortedError) {
            return { ok: false } as const;
          }
          throw e;
        }
      })(),
      {
        abort: () => control.abort(),
      },
    );
  };
}

export function runAbortable<TReturn>(
  fn: ($: AbortableUtility) => TReturn | PromiseLike<TReturn>,
): AbortableTask<TReturn> {
  return abortable(($) => () => fn($))();
}

/**
 * Utility interface for abort-aware operations.
 */
interface AbortableUtility {
  /**
   * Wraps a promise or value to be abort-aware.
   * @param value - The promise or value to wrap
   * @returns A promise that can be aborted
   */
  <UReturn>(value: NotFunction<UReturn>): Promise<Awaited<UReturn>>;

  /**
   * Wraps a function to make it abort-aware.
   * @param g - The function to wrap
   * @returns A wrapped function that checks for abortion
   */
  <UReturn, UParams extends readonly unknown[]>(
    g: (...params: UParams) => UReturn | PromiseLike<UReturn>,
  ): (...params: UParams) => Promise<UReturn>;

  /**
   * Registers a cleanup function to be called when the operation completes or is aborted.
   * Cleanup functions are executed in reverse order of registration (LIFO).
   * @param fn - The cleanup function to register
   */
  cleanup: (fn: () => void) => void;

  abort: () => void;

  all: <T extends readonly unknown[] | []>(
    array: T,
  ) => Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }>;
}

/**
 * Type for an abortable operation.
 */
type AbortableOperation<TParams extends readonly unknown[], TReturn> = (
  ...params: TParams
) => AbortableTask<TReturn>;

export type AbortableTask<TReturn> = Promise<
  { ok: true; data: TReturn } | { ok: false }
> & {
  abort: () => void;
};
