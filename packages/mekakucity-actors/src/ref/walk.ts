import type { ActorDescriptor } from "../runtime/actor-runtime.js";

export interface ActorRefHydration {
  isKnownRef(value: object): boolean;
  isDescriptor(value: unknown): value is ActorDescriptor;
  toRef(descriptor: ActorDescriptor): object;
}

export const isActorDescriptor = (
  value: unknown,
  isKnownType: (type: string) => boolean = () => true,
): value is ActorDescriptor => {
  if (!value || typeof value !== "object") return false;
  try {
    const type = Object.getOwnPropertyDescriptor(value, "type");
    const id = Object.getOwnPropertyDescriptor(value, "id");
    return !!type && !!id && "value" in type && "value" in id
      && typeof type.value === "string"
      && typeof id.value === "string"
      && isKnownType(type.value);
  } catch {
    return false;
  }
};

export const hydrateActorRefs = <T>(value: T, hydration: ActorRefHydration): T => {
  const visited = new WeakMap<object, unknown>();
  const visit = <Value>(current: Value): Value => {
    if (!current || typeof current !== "object") return current;
    if (hydration.isKnownRef(current)) return current;
    if (hydration.isDescriptor(current)) return hydration.toRef(current) as Value;
    if (visited.has(current)) return visited.get(current) as Value;
    if (current instanceof Date || current instanceof RegExp || current instanceof ArrayBuffer || ArrayBuffer.isView(current)) return current;
    if (current instanceof Map) {
      visited.set(current, current);
      for (const [key, item] of current) {
        const nextKey = visit(key);
        const nextItem = visit(item);
        if (nextKey !== key || nextItem !== item) { current.delete(key); current.set(nextKey, nextItem); }
      }
      return current;
    }
    if (current instanceof Set) {
      visited.set(current, current);
      for (const item of [...current]) {
        const next = visit(item);
        if (next !== item) { current.delete(item); current.add(next); }
      }
      return current;
    }
    visited.set(current, current);
    for (const key of Object.keys(current)) {
      const previous = (current as Record<string, unknown>)[key];
      const hydrated = visit(previous);
      if (hydrated !== previous) (current as Record<string, unknown>)[key] = hydrated;
    }
    return current;
  };
  return visit(value);
};

export const collectActorRefIds = (
  value: unknown,
  isDescriptor: (candidate: unknown) => candidate is ActorDescriptor,
  ids = new Set<string>(),
): Set<string> => {
  const visited = new WeakSet<object>();
  const visit = (current: unknown): void => {
    if (!current || typeof current !== "object" || visited.has(current)) return;
    if (isDescriptor(current)) { ids.add(current.id); return; }
    visited.add(current);
    if (current instanceof Map) for (const [key, item] of current) { visit(key); visit(item); }
    else if (current instanceof Set) for (const item of current) visit(item);
    else for (const key of Object.keys(current)) visit((current as Record<string, unknown>)[key]);
  };
  visit(value);
  return ids;
};
