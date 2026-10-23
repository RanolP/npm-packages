import { ActorRuntime } from "../runtime/actor-runtime.js";
import type { Cloneable, StructuredCloneable } from "../ref/types.js";

export type MemberKind = "state" | "derived" | "action";

export interface ActorMetadata {
  readonly state: Set<string>;
  readonly derived: Set<string>;
  readonly actions: Map<string, (...args: unknown[]) => unknown>;
}

const ownMetadata = new WeakMap<Function, ActorMetadata>();
const actionNames = new WeakMap<Function, string>();

const metadataForConstructor = (ctor: Function): ActorMetadata => {
  const current = ownMetadata.get(ctor);
  if (current) return current;
  const created: ActorMetadata = { state: new Set(), derived: new Set(), actions: new Map() };
  ownMetadata.set(ctor, created);
  return created;
};

export const metadataFor = (instanceOrConstructor: object | Function): ActorMetadata => {
  const ctor = typeof instanceOrConstructor === "function"
    ? instanceOrConstructor
    : instanceOrConstructor.constructor;
  const result: ActorMetadata = { state: new Set(), derived: new Set(), actions: new Map() };
  const chain: Function[] = [];
  for (let current: Function | null = ctor; current && current !== Function.prototype; current = Object.getPrototypeOf(current)) {
    chain.unshift(current);
  }
  for (const current of chain) {
    const own = ownMetadata.get(current);
    if (!own) continue;
    for (const key of own.state) result.state.add(key);
    for (const key of own.derived) result.derived.add(key);
    for (const [key, method] of own.actions) result.actions.set(key, method);
  }
  return result;
};

const register = (kind: MemberKind, name: string, ctor: Function, method?: (...args: unknown[]) => unknown): void => {
  const metadata = metadataForConstructor(ctor);
  if (kind === "state") metadata.state.add(name);
  else if (kind === "derived") metadata.derived.add(name);
  else if (method) metadata.actions.set(name, method);
};

export const state = <This extends object, Value>(
  _value: ClassAccessorDecoratorTarget<This, Value>,
  context: ClassAccessorDecoratorContext<This, Value>,
): ClassAccessorDecoratorResult<This, Value> => {
  context.addInitializer(function (this: This) {
    register("state", String(context.name), this.constructor);
  });
  return {};
};

export const derived = <This extends object, Value>(
  _value: (this: This) => Value,
  context: ClassGetterDecoratorContext<This, Value>,
): void => {
  context.addInitializer(function (this: This) {
    register("derived", String(context.name), this.constructor);
  });
};

export interface ActionDecorator {
  <
    This extends object,
    Args extends unknown[],
    Result extends Cloneable,
    Method extends (this: This, ...args: Args) => Promise<Result>,
  >(
    value: Method
      & ((this: This, ...args: Args) => Promise<StructuredCloneable<NoInfer<Result>>>),
    context: ClassMethodDecoratorContext<This, Method>,
  ): Method;
  <This extends object, Args extends unknown[], Result extends Promise<unknown>>(
    value: ((this: This, ...args: Args) => Result & Promise<0 extends (1 & Awaited<NoInfer<Result>>) ? never : StructuredCloneable<Awaited<NoInfer<Result>>>>)
      & (unknown extends Awaited<NoInfer<Result>> ? never : unknown),
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
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
  context.addInitializer(function (this: This) {
    register("action", name, this.constructor, value as (...args: unknown[]) => unknown);
  });
  return wrapped;
};

export const actionNameOf = (method: Function): string | undefined => actionNames.get(method);
