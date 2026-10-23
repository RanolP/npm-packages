export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function completesBeforeTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("operation timed out")), 500);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
