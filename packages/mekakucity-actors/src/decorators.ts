import type { Cloneable, StructuredCloneable } from "./types.js";

export type MemberKind = "state" | "derived" | "action";

export interface ActorMetadata {
  readonly state: Set<string>;
  readonly derived: Set<string>;
  readonly actions: Map<string, (...args: unknown[]) => unknown>;
}

const metadataKey = Symbol("actor metadata");
const actionNames = new WeakMap<Function, string>();

function metadataForConstructor(ctor: Function): ActorMetadata {
  const target = ctor as Function & { [metadataKey]?: ActorMetadata };
  const current = target[metadataKey];
  if (current) return current;
  const created: ActorMetadata = { state: new Set(), derived: new Set(), actions: new Map() };
  Object.defineProperty(target, metadataKey, { value: created });
  return created;
}

export function metadataFor(instanceOrConstructor: object | Function): ActorMetadata {
  const ctor = typeof instanceOrConstructor === "function"
    ? instanceOrConstructor
    : instanceOrConstructor.constructor;
  const result: ActorMetadata = { state: new Set(), derived: new Set(), actions: new Map() };
  const chain: Function[] = [];
  for (let current: Function | null = ctor; current && current !== Function.prototype; current = Object.getPrototypeOf(current)) {
    chain.unshift(current);
  }
  for (const current of chain) {
    const own = (current as Function & { [metadataKey]?: ActorMetadata })[metadataKey];
    if (!own) continue;
    for (const key of own.state) result.state.add(key);
    for (const key of own.derived) result.derived.add(key);
    for (const [key, method] of own.actions) result.actions.set(key, method);
  }
  return result;
}

function register(kind: MemberKind, name: string, ctor: Function, method?: (...args: unknown[]) => unknown): void {
  const metadata = metadataForConstructor(ctor);
  if (kind === "state") metadata.state.add(name);
  else if (kind === "derived") metadata.derived.add(name);
  else if (method) metadata.actions.set(name, method);
}

export function state<This, Value>(
  _value: ClassAccessorDecoratorTarget<This, Value>,
  context: ClassAccessorDecoratorContext<This, Value>,
): ClassAccessorDecoratorResult<This, Value> {
  context.addInitializer(function (this: This) {
    register("state", String(context.name), (this as { constructor: Function }).constructor);
  });
  return {};
}

export function derived<This, Value>(
  _value: (this: This) => Value,
  context: ClassGetterDecoratorContext<This, Value>,
): void {
  context.addInitializer(function (this: This) {
    register("derived", String(context.name), (this as { constructor: Function }).constructor);
  });
}

export function action<
  This,
  Args extends unknown[],
  Result extends Cloneable,
  Method extends (this: This, ...args: Args) => Promise<Result>,
>(
  value: Method
    & ((this: This, ...args: Args) => Promise<StructuredCloneable<NoInfer<Result>>>),
  context: ClassMethodDecoratorContext<This, Method>,
): Method;
export function action<This, Args extends unknown[], Result extends Promise<unknown>>(
  value: ((this: This, ...args: Args) => Result & Promise<0 extends (1 & Awaited<NoInfer<Result>>) ? never : StructuredCloneable<Awaited<NoInfer<Result>>>>)
    & (unknown extends Awaited<NoInfer<Result>> ? never : unknown),
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
): (this: This, ...args: Args) => Result;
export function action<This, Args extends unknown[], Result extends Promise<unknown>>(
  value: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
): (this: This, ...args: Args) => Result {
  const name = String(context.name);
  const wrapped = function (this: This, ...args: Args): Result {
    const call = (receiver: object, callArgs: unknown[]) => Reflect.apply(value as Function, receiver, callArgs) as Result;
    const runtime = requireActionRuntime();
    return runtime(this as object, name, args, () => call(this as object, args)) as Result;
  };
  actionNames.set(wrapped, name);
  context.addInitializer(function (this: This) {
    register("action", name, (this as { constructor: Function }).constructor, value as (...args: unknown[]) => unknown);
  });
  return wrapped;
}

let localInvoker: ((instance: object, actionName: string, args: unknown[], run: () => unknown) => unknown) | undefined;

export function setActionRuntime(
  invoke: (instance: object, actionName: string, args: unknown[], run: () => unknown) => unknown,
): void {
  localInvoker = invoke;
}

function requireActionRuntime(): NonNullable<typeof localInvoker> {
  if (!localInvoker) throw new Error("Actor runtime has not been initialized");
  return localInvoker;
}

export function actionNameOf(method: Function): string | undefined {
  return actionNames.get(method);
}
