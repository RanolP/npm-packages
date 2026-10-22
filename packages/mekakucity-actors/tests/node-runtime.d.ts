declare module "node:async_hooks" {
  export class AsyncLocalStorage<Store> {
    getStore(): Store | undefined;
    run<Result>(store: Store, callback: () => Result): Result;
  }
}

declare module "node:util" {
  export function isDeepStrictEqual(left: unknown, right: unknown): boolean;
}

declare function setImmediate(callback: () => void): unknown;
