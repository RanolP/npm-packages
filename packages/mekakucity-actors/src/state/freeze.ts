export const deepFreeze = <T>(value: T, visited = new WeakSet<object>()): T => {
  if (!value || typeof value !== "object" || visited.has(value)) return value;
  visited.add(value);
  if (value instanceof Map) {
    for (const [key, item] of value) {
      deepFreeze(key, visited);
      deepFreeze(item, visited);
    }
    Object.defineProperties(value, {
      set: { value: () => { throw new TypeError("Actor snapshots are read-only"); } },
      delete: { value: () => { throw new TypeError("Actor snapshots are read-only"); } },
      clear: { value: () => { throw new TypeError("Actor snapshots are read-only"); } },
    });
  } else if (value instanceof Set) {
    for (const item of value) deepFreeze(item, visited);
    Object.defineProperties(value, {
      add: { value: () => { throw new TypeError("Actor snapshots are read-only"); } },
      delete: { value: () => { throw new TypeError("Actor snapshots are read-only"); } },
      clear: { value: () => { throw new TypeError("Actor snapshots are read-only"); } },
    });
  } else {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key], visited);
  }
  return Object.freeze(value);
};
