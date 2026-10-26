import type { Actor, ActorConstructor, ActorInput } from "@mekakucity/actors";

/** A registered actor class with its input type erased, as a host sees it after resolving a wire type name. */
export interface RegisteredType {
  readonly Type: Function;
  construct(input: unknown): Actor<unknown, unknown>;
}

interface ScopeTypes {
  readonly byName: Map<string, RegisteredType>;
  readonly names: WeakMap<Function, string>;
}

// Hosts resolve actor classes by (scope, type name). Under vitest-plugin the
// caller and every host share one isolate, so the caller's registrations are
// visible to the host; a deployed worker must register its classes at module load.
const scopes = new Map<string, ScopeTypes>();

const scopeTypes = (scope: string): ScopeTypes => {
  let types = scopes.get(scope);
  if (!types) {
    types = { byName: new Map(), names: new WeakMap() };
    scopes.set(scope, types);
  }
  return types;
};

/** Returns the wire name of `Type`, suffixing it when another class already took the bare name in this scope. */
export const registerType = <T extends Actor<unknown, unknown>>(scope: string, Type: ActorConstructor<T>): string => {
  const types = scopeTypes(scope);
  const known = types.names.get(Type);
  if (known) return known;
  const base = Type.name || "ActorType";
  let name = base;
  for (let n = 2; types.byName.has(name); n += 1) name = `${base}#${n}`;
  // The wire input reaching construct() is the structured clone of an
  // ActorInput<T> the caller passed to spawn/orSpawn for this same type name.
  types.byName.set(name, { Type, construct: (input) => new Type(input as ActorInput<T>) });
  types.names.set(Type, name);
  return name;
};

export const lookupType = (scope: string, name: string): RegisteredType | undefined =>
  scopes.get(scope)?.byName.get(name);

export const isKnownType = (scope: string, name: string): boolean => scopes.get(scope)?.byName.has(name) ?? false;
