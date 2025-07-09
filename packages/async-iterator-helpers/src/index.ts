import { readSync } from "fs";

const DEFAULT_PARALLEL_LIMIT = (() => {
  const envLimit = 'process' in globalThis ? Number(globalThis.process.env.ASYNC_ITERATOR_HELPERS_PARALLEL_LIMIT) : NaN;
  const hardLimit = 100;
  return Math.min(Number.isFinite(envLimit) ? envLimit : 16, hardLimit);
})();

export class AsyncIterator<T> {
  private constructor(private readonly handle: AsyncIteratorHandle<any, T>) { }

  static from<T>(handle: AsyncGenerator<T> | ArrayLike<MaybePromise<T>>): AsyncIterator<T> {
    return new AsyncIterator(new AsyncIteratorHandle(handle, (value) => [1, value], 0, Infinity, DEFAULT_PARALLEL_LIMIT));
  }

  map<U>(f: (value: T) => MaybePromise<U>): AsyncIterator<U> {
    return new AsyncIterator(this.handle.map(f));
  }

  filter(f: (value: T) => MaybePromise<boolean>): AsyncIterator<T> {
    return new AsyncIterator(this.handle.filter(f));
  }

  take(n: number): AsyncIterator<T> {
    return new AsyncIterator(this.handle.take(n));
  }

  drop(n: number): AsyncIterator<T> {
    return new AsyncIterator(this.handle.drop(n));
  }

  parallel(limit: number): AsyncIterator<T> {
    return new AsyncIterator(this.handle.parallel(Math.max(1, limit)));
  }

  flatMap<U>(f: (value: T) => AsyncGenerator<MaybePromise<U>> | MaybePromise<U>[]): AsyncIterator<U> {
    const handle = parGen(this.handle.parallelLimit, this.handle[Symbol.asyncIterator]());
    return AsyncIterator.from(async function* () {
      for await (const value of handle) {
        yield* f(value);
      }
    }());
  }

  async toArray(): Promise<T[]> {
    const result: T[] = [];
    for await (const value of this.handle) {
      result.push(value);
    }
    return result;
  }

  async find(f: (value: T) => MaybePromise<boolean>): Promise<T | undefined> {
    for await (const value of this.handle) {
      if (await f(value)) return value;
    }
    return undefined;
  }

  async forEach(f: (value: T) => void): Promise<void> {
    for await (const value of this.handle) {
      f(value);
    }
  }

  async reduce<R>(f: (acc: R, value: T) => R, initial: R): Promise<R> {
    let acc = initial;
    for await (const value of this.handle) {
      acc = f(acc, value);
    }
    return acc;
  }

  async some(f: (value: T) => MaybePromise<boolean>): Promise<boolean> {
    for await (const value of this.handle) {
      if (await f(value)) return true;
    }
    return false;
  }

  async every(f: (value: T) => MaybePromise<boolean>): Promise<boolean> {
    for await (const value of this.handle) {
      if (!(await f(value))) return false;
    }
    return true;
  }

  [Symbol.asyncIterator](): AsyncGenerator<T> {
    return this.handle[Symbol.asyncIterator]();
  }
}

class AsyncIteratorHandle<T, U> {
  constructor(
    private readonly handle: AsyncGenerator<T> | ArrayLike<MaybePromise<T>>,
    private readonly fn: (value: T) => MaybePromise<Option<U>>,
    private readonly begin: number,
    private readonly length: number,
    readonly parallelLimit: number,
  ) { }

  async *[Symbol.asyncIterator](): AsyncGenerator<U> {
    let toSkip = this.begin;
    let toTake = this.length;
    for await (const value of parGen(this.parallelLimit, this.handle)) {
      if (toSkip > 0) {
        toSkip -= 1;
        continue;
      }
      const [id, val] = await this.fn(value);
      if (id === 0) continue;
      if (toTake <= 0) break;
      yield val;
      toTake -= 1;
    }
  }

  map<V>(f: (value: U) => MaybePromise<V>): AsyncIteratorHandle<T, V> {
    return new AsyncIteratorHandle(this.handle, async t => {
      const [id, val] = await this.fn(t);
      if (id === 0) return [0, null];
      return [1, await f(val)];
    }, this.begin, this.length, this.parallelLimit);
  }

  filter(f: (value: U) => MaybePromise<boolean>): AsyncIteratorHandle<T, U> {
    return new AsyncIteratorHandle(this.handle, async t => {
      const [id, val] = await this.fn(t);
      if (id !== 0 && (await f(val))) return [1, val];
      return [0, null];
    }, this.begin, this.length, this.parallelLimit);
  }

  take(n: number): AsyncIteratorHandle<T, U> {
    return new AsyncIteratorHandle(this.handle, this.fn, this.begin, Math.min(n, this.length), this.parallelLimit);
  }

  drop(n: number): AsyncIteratorHandle<T, U> {
    const amountToDrop = Math.min(n, this.length);
    return new AsyncIteratorHandle(this.handle, this.fn, this.begin + amountToDrop, this.length - amountToDrop, this.parallelLimit);
  }

  parallel(limit: number): AsyncIteratorHandle<T, U> {
    return new AsyncIteratorHandle(this.handle, this.fn, this.begin, this.length, limit);
  }
}

type MaybePromise<T> = T | Promise<T>;
type Option<T> = [0, null] | [1, T];

async function* parGen<T>(limit: number, generatorLike: AsyncGenerator<T> | ArrayLike<MaybePromise<T>>): AsyncGenerator<T> {
  const generator = ((): AsyncGenerator<T> => {
    if ('length' in generatorLike) {
      return (async function* () {
        for (const value of Array.from(generatorLike)) {
          yield Promise.resolve(await value);
        }
      })();
    }
    return generatorLike
  })();

  const queue: Promise<Option<T>>[] = [];
  while (queue.length < limit) {
    queue.push(generator.next().then((r): Option<T> => r.done ? [0, null] : [1, r.value]));
  }

  while (queue.length > 0) {
    const [id, value] = await queue.shift()!;
    if (id === 0) continue;
    yield value;
    queue.push(generator.next().then((r): Option<T> => r.done ? [0, null] : [1, r.value]));
  }
}
