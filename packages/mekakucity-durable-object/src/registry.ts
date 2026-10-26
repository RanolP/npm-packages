import type { Actor } from "@mekakucity/actors";
import { ActorRuntimeError } from "@mekakucity/actors";

/** A registered actor class with its input type erased, as a host sees it after resolving a wire type name. */
export interface RegisteredType {
  readonly Type: Function;
  construct(input: unknown): Actor<unknown, unknown>;
}

// Worker-wide: filled at module load by defineActorHost, so every isolate of the worker resolves the same names,
// whichever caller (if any) ran in it before. The name is persisted in each actor's meta.
const byName = new Map<string, RegisteredType>();
const names = new WeakMap<Function, string>();

// Test-only (src/testing.ts): per-scope tables for classes a test defines after the worker module loaded. Named
// by class name (suffixed `#n` on a clash) so suites can assert ref types; consulted only after the worker table.
interface OnDemandTypes {
  readonly byName: Map<string, RegisteredType>;
  readonly names: WeakMap<Function, string>;
}
const onDemandScopes = new Map<string, OnDemandTypes>();

/** Any actor class, input type erased: the shape defineActorHost accepts. */
export type AnyActorConstructor = new (input: never) => Actor<unknown, unknown>;

/**
 * Binds each name to its class, checking the whole batch before binding any. Re-binding a pair that is already
 * bound is a no-op; a name bound to another class, or a class bound under another name, throws.
 */
export const registerTypes = (types: Readonly<Record<string, AnyActorConstructor>>): void => {
  const batchNames = new Map<AnyActorConstructor, string>();
  for (const [name, Type] of Object.entries(types)) {
    const label = Type.name || "(anonymous)";
    if (typeof Type !== "function") throw new ActorRuntimeError(`Actor type "${name}" must be an actor class`);
    if (name === "" || name.includes("\0")) {
      throw new ActorRuntimeError(`Actor type name ${JSON.stringify(name)} must be non-empty and contain no NUL`);
    }
    const bound = byName.get(name)?.Type;
    if (bound !== undefined && bound !== Type) {
      throw new ActorRuntimeError(`Actor type name "${name}" is already bound to class ${bound.name || "(anonymous)"}`);
    }
    const known = names.get(Type) ?? batchNames.get(Type);
    if (known !== undefined && known !== name) {
      throw new ActorRuntimeError(`Actor class ${label} is already registered as "${known}", not "${name}"`);
    }
    batchNames.set(Type, name);
  }
  for (const [Type, name] of batchNames) {
    if (byName.has(name)) continue;
    byName.set(name, registered(Type));
    names.set(Type, name);
  }
};

const registered = (Type: AnyActorConstructor): RegisteredType =>
  // The wire input reaching construct() is the structured clone of the ActorInput a caller passed to
  // spawn/orSpawn for this same type name, which is the input this class's constructor declares.
  ({ Type, construct: (input) => new Type(input as never) });

/** The wire name of `Type`; throws for a class the worker never passed to defineActorHost. */
export const typeNameOf = (scope: string, Type: AnyActorConstructor): string => {
  const known = names.get(Type);
  if (known !== undefined) return known;
  const onDemand = onDemandScopes.get(scope);
  if (onDemand) {
    const existing = onDemand.names.get(Type);
    if (existing !== undefined) return existing;
    const base = Type.name || "ActorType";
    let name = base;
    for (let n = 2; byName.has(name) || onDemand.byName.has(name); n += 1) name = `${base}#${n}`;
    onDemand.byName.set(name, registered(Type));
    onDemand.names.set(Type, name);
    return name;
  }
  throw new ActorRuntimeError(
    `Actor class ${Type.name || "(anonymous)"} is not registered; pass it to defineActorHost({ ... }) in the worker entry`,
  );
};

/** `scope` matters only for the test-only on-demand tables; a deployed worker resolves from defineActorHost alone. */
export const lookupType = (name: string, scope: string): RegisteredType | undefined =>
  byName.get(name) ?? onDemandScopes.get(scope)?.byName.get(name);

export const isKnownType = (name: string, scope: string): boolean => lookupType(name, scope) !== undefined;

export const allowOnDemandTypes = (scope: string): void => {
  if (!onDemandScopes.has(scope)) onDemandScopes.set(scope, { byName: new Map(), names: new WeakMap() });
};
