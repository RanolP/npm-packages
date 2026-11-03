import { ActorRuntime } from "../runtime/actor-runtime.js";
import { ActorRuntimeError } from "../runtime/errors.js";
import type { Cloneable, StructuredCloneable } from "../ref/types.js";

export interface ActorMetadata {
  readonly state: Set<string>;
  readonly actions: Map<string, (...args: unknown[]) => unknown>;
}

interface ActorPrivateStateAccessor {
  readonly get: (instance: object) => unknown;
  readonly set: (instance: object, value: unknown) => void;
}

interface InternalActorMetadata extends ActorMetadata {
  readonly privateState: Map<string, ActorPrivateStateAccessor>;
}

// Decorator transforms fall back to this key when Symbol.metadata is absent. tsc users must import
// @mekakucity/actors/polyfill before defining actor classes so tsc passes context.metadata.
const metadataKey: symbol = (Symbol as { metadata?: symbol }).metadata ?? Symbol.for("Symbol.metadata");

// Keyed by the class's own metadata object, which member decorators receive at class definition time, so a
// class's members are known before (and without) constructing it: a ref built in an isolate that never hosts
// the actor still gets every action.
const ownMetadata = new WeakMap<object, InternalActorMetadata>();
const actionNames = new WeakMap<Function, string>();

const metadataObjectOf = (context: { readonly name: string | symbol; readonly metadata?: object }): object => {
  if (context.metadata) return context.metadata;
  throw new ActorRuntimeError(
    `Decorator on ${String(context.name)} received no context.metadata; compile actor classes with a TC39 decorator transform that supports decorator metadata (TypeScript 5.2+, esbuild, Babel)`,
  );
};

const metadataForObject = (metadata: object): InternalActorMetadata => {
  const current = ownMetadata.get(metadata);
  if (current) return current;
  const created: InternalActorMetadata = { state: new Set(), privateState: new Map(), actions: new Map() };
  ownMetadata.set(metadata, created);
  return created;
};

const ownMetadataChain = (instanceOrConstructor: object | Function): InternalActorMetadata[] => {
  const ctor = typeof instanceOrConstructor === "function"
    ? instanceOrConstructor
    : instanceOrConstructor.constructor;
  const chain: Function[] = [];
  for (let current: Function | null = ctor; current && current !== Function.prototype; current = Object.getPrototypeOf(current)) {
    chain.unshift(current);
  }
  const result: InternalActorMetadata[] = [];
  for (const current of chain) {
    // A subclass without decorators of its own inherits Symbol.metadata, so only an own property counts.
    const metadata = Object.getOwnPropertyDescriptor(current, metadataKey)?.value;
    const own = metadata ? ownMetadata.get(metadata) : undefined;
    if (own) result.push(own);
  }
  return result;
};

export const metadataFor = (instanceOrConstructor: object | Function): ActorMetadata => {
  const result: ActorMetadata = { state: new Set(), actions: new Map() };
  for (const own of ownMetadataChain(instanceOrConstructor)) {
    for (const key of own.state) result.state.add(key);
    for (const [key, method] of own.actions) result.actions.set(key, method);
  }
  return result;
};

export const privateStateAccessorsFor = (
  instanceOrConstructor: object | Function,
): ReadonlyMap<string, ActorPrivateStateAccessor> => {
  const result = new Map<string, ActorPrivateStateAccessor>();
  for (const own of ownMetadataChain(instanceOrConstructor)) {
    for (const [key, accessor] of own.privateState) result.set(key, accessor);
  }
  return result;
};

export const state = <This extends object, Value>(
  _value: ClassAccessorDecoratorTarget<This, Value>,
  context: ClassAccessorDecoratorContext<This, Value>,
): ClassAccessorDecoratorResult<This, Value> => {
  const metadataObject = metadataObjectOf(context);
  const key = String(context.name);
  if (context.private) {
    for (
      let parent = Object.getPrototypeOf(metadataObject);
      parent;
      parent = Object.getPrototypeOf(parent)
    ) {
      if (ownMetadata.get(parent)?.privateState.has(key)) {
        throw new ActorRuntimeError(
          `Private state key ${key} conflicts with an inherited key; private state keys must be unique across the class chain`,
        );
      }
    }
    metadataForObject(metadataObject).privateState.set(key, {
      get: (instance) => context.access.get(instance as This),
      set: (instance, value) => context.access.set(instance as This, value as Value),
    });
  } else {
    metadataForObject(metadataObject).state.add(key);
  }
  return {};
};

// ActorRef calls an action with the ref, not the actor, as `this`, so an explicit `this` parameter is rejected here.
// The decorator sees only the implementation signature; `this` declared on overload signatures alone surfaces as TS2684 at the ref call site.
type NoExplicitThis<Method> = unknown extends ThisParameterType<Method>
  ? unknown
  : "@action methods must not declare an explicit `this` parameter";

export interface ActionDecorator {
  <
    This extends object,
    Args extends unknown[],
    Result extends Cloneable,
    Method extends (this: This, ...args: Args) => Promise<Result>,
  >(
    value: Method
      & ((this: This, ...args: Args) => Promise<StructuredCloneable<NoInfer<Result>>>)
      & NoExplicitThis<NoInfer<Method>>,
    context: ClassMethodDecoratorContext<This, Method>,
  ): Method;
  <This extends object, Args extends unknown[], Result extends Promise<unknown>, Method>(
    value: ((this: This, ...args: Args) => Result & Promise<0 extends (1 & Awaited<NoInfer<Result>>) ? never : StructuredCloneable<Awaited<NoInfer<Result>>>>)
      & (unknown extends Awaited<NoInfer<Result>> ? never : unknown)
      & NoExplicitThis<NoInfer<Method>>,
    context: ClassMethodDecoratorContext<This, Method & ((this: This, ...args: Args) => Result)>,
  ): (this: This, ...args: Args) => Result;
}

export const action: ActionDecorator = <This extends object, Args extends unknown[], Result extends Promise<unknown>>(
  value: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
): (this: This, ...args: Args) => Result => {
  const name = String(context.name);
  const wrapped = function (this: This, ...args: Args): Result {
    return ActorRuntime.current(`Call action ${name}`).invokeLocalAction(
      this,
      name,
      args,
      () => value.apply(this, args),
    ) as Result;
  };
  actionNames.set(wrapped, name);
  metadataForObject(metadataObjectOf(context)).actions.set(name, value as (...args: unknown[]) => unknown);
  return wrapped;
};

export const actionNameOf = (method: Function): string | undefined => actionNames.get(method);
