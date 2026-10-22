import { Effect } from "effect";
import { Actor, action, state } from "../src/index.js";
import { ActorEffect, type ActorEffectError } from "../src/effect.js";
import type { ActorRef, Cloneable } from "../src/index.js";

class TypeFixture extends Actor<TypeFixture, { input: string }> {
  protected secret = "hidden";
  @state accessor count = 0;
  @state accessor values = [1, 2];
  @action async increment(by: number) { this.count += by; return this.count; }
  helper() { return this.count; }
}

declare const ref: ActorRef<TypeFixture>;
const count: number = ref.count;
const result: Promise<number> = ref.increment(1);
ref.increment.runDetached(1);
// @ts-expect-error synchronous non-action methods are not exposed on refs.
ref.helper();
// @ts-expect-error nested state arrays are read-only.
ref.values.push(3);
void count;
void result;

class ExplicitThisActor extends Actor<ExplicitThisActor, {}> {
  @action async selfy(this: ExplicitThisActor): Promise<number> { return 42; }
}
declare const explicitThisRef: ActorRef<ExplicitThisActor>;
const selfyResult: Promise<number> = explicitThisRef.selfy();
const selfyEffect: Effect.Effect<number, ActorEffectError> = ActorEffect.call(explicitThisRef, "selfy");
void selfyResult;
void selfyEffect;

class Money {
  constructor(readonly amount: number) {}
  format() { return `$${this.amount}`; }
}

class UnsafeResultFixture extends Actor<UnsafeResultFixture, {}> {
  // @ts-expect-error action results with prototype methods lose their type after structuredClone.
  @action async makeMoney() { return new Money(5); }
  // @ts-expect-error function-valued members are not structured-clone-safe at any depth.
  @action async nestedFunction() { return { nested: { run() { return true; } } }; }
  @action async explicitAny(): Promise<any> { return 1; }
  @action async parsed(value: string) { return JSON.parse(value); }
  // @ts-expect-error symbol-keyed function members are not structured-clone-safe.
  @action async symbolFunction() { return { a: 1, [Symbol.for("key")]: () => 1 }; }
}
void UnsafeResultFixture;
declare const unsafeResultRef: ActorRef<UnsafeResultFixture>;
// @ts-expect-error actions with an any result cannot be called through a ref.
unsafeResultRef.explicitAny();
// @ts-expect-error JSON.parse's any result cannot be called through a ref.
unsafeResultRef.parsed("{}");
// @ts-expect-error ActionEffect excludes action keys whose ref result is never.
ActorEffect.call(unsafeResultRef, "parsed", "{}");

class UndecoratedUnsafeMethodActor extends Actor<UndecoratedUnsafeMethodActor, {}> {
  unsafe() { return new Money(5); }
}
declare const undecoratedUnsafeMethodRef: ActorRef<UndecoratedUnsafeMethodActor>;
// @ts-expect-error refs keep the concrete result guard for non-decorated methods.
undecoratedUnsafeMethodRef.unsafe();

const symbolDataKey = Symbol("symbol data");
interface SymbolDataResult {
  a: number;
  [symbolDataKey]: number;
}
class SymbolDataFixture extends Actor<SymbolDataFixture, {}> {
  // @ts-expect-error symbol-keyed object data is discarded by structuredClone.
  @action async literalData() { return { a: 1, [symbolDataKey]: 2 }; }
  // @ts-expect-error symbol-keyed interface data is discarded by structuredClone.
  @action async interfaceData(): Promise<SymbolDataResult> { return { a: 1, [symbolDataKey]: 2 }; }
}
void SymbolDataFixture;

class SafeResultFixture extends Actor<SafeResultFixture, {}> {
  @action async data() {
    return {
      date: new Date(),
      regexp: /actors/,
      map: new Map<string, number>(),
      set: new Set([1, 2]),
      tuple: ["actor", 1] as const,
    };
  }
  @action async noResult(): Promise<void> {}
}

declare const safeResultRef: ActorRef<SafeResultFixture>;
const cloneableResult: Promise<{
  date: Date;
  regexp: RegExp;
  map: Map<string, number>;
  set: Set<number>;
  tuple: readonly ["actor", 1];
}> = safeResultRef.data();
const voidResult: Promise<void> = safeResultRef.noResult();
void cloneableResult;
void voidResult;

interface InterfaceResult {
  label: string;
  nested: { count: number };
}
interface RecursiveValue {
  label: string;
  next?: RecursiveValue;
}

class PositiveCloneabilityFixture extends Actor<PositiveCloneabilityFixture, { child: ActorRef<TypeFixture> }> {
  @action async interfaceResult(): Promise<InterfaceResult> {
    return { label: "interface", nested: { count: 1 } };
  }
  @action async referenceMap(): Promise<Map<string, ActorRef<TypeFixture>>> {
    return new Map([["child", this.input.child]]);
  }
  @action async nullableResult(): Promise<InterfaceResult | null> { return null; }
  @action async recursiveResult(): Promise<RecursiveValue> {
    return { label: "root", next: { label: "leaf" } };
  }
}
declare const positiveRef: ActorRef<PositiveCloneabilityFixture>;
const interfaceResult: Promise<InterfaceResult> = positiveRef.interfaceResult();
const referenceMap: Promise<Map<string, ActorRef<TypeFixture>>> = positiveRef.referenceMap();
const nullableResult: Promise<InterfaceResult | null> = positiveRef.nullableResult();
const recursiveResult: Promise<RecursiveValue> = positiveRef.recursiveResult();
void interfaceResult;
void referenceMap;
void nullableResult;
void recursiveResult;

// @ts-expect-error spawn requires the actor's input shape.
Actor.spawn(TypeFixture, {});

// @ts-expect-error ActorRef state is read-only.
ref.count = 2;
// @ts-expect-error protected actor members do not appear on refs.
ref.input;
// @ts-expect-error protected subclass members do not appear on refs.
ref.secret;
// @ts-expect-error actor actions are asynchronous through refs.
const synchronousResult: number = ref.increment(1);
void synchronousResult;

class Queue<T extends Cloneable> extends Actor<Queue<T>, { items: T[] }> {
  @state accessor items: T[] = this.input.items;
  @action async push(item: T) { this.items = [...this.items, item]; }
  @action async pop(): Promise<T | undefined> {
    const [item, ...remaining] = this.items;
    this.items = remaining;
    return item;
  }
}

// @ts-expect-error functions are not valid queue payloads.
type FunctionQueue = Queue<() => void>;
void (null as unknown as FunctionQueue);
// @ts-expect-error instances with methods are not valid queue payloads.
type MoneyQueue = Queue<Money>;
void (null as unknown as MoneyQueue);

class GenericMethodActor extends Actor<GenericMethodActor, {}> {
  @action async echo<T extends Cloneable>(value: T): Promise<T> { return value; }
}
declare const genericMethodRef: ActorRef<GenericMethodActor>;
const echoedNumber: Promise<number> = genericMethodRef.echo(5);
const echoedString: Promise<string> = genericMethodRef.echo("a");
// @ts-expect-error generic echo arguments still have to be cloneable.
genericMethodRef.echo(() => 1);
// Effect call widens this generic method's result to its Cloneable constraint.
const genericEchoEffect: Effect.Effect<Cloneable, ActorEffectError> = ActorEffect.call(genericMethodRef, "echo", 5);
// @ts-expect-error Effect calls retain the generic method's Cloneable argument constraint.
ActorEffect.call(genericMethodRef, "echo", () => 1);
void echoedNumber;
void echoedString;
void genericEchoEffect;

class OverloadedMethodActor extends Actor<OverloadedMethodActor, {}> {
  echo(value: number): Promise<number>;
  echo(value: string): Promise<string>;
  @action async echo(value: number | string): Promise<number | string> { return value; }
}
declare const overloadedMethodRef: ActorRef<OverloadedMethodActor>;
const overloadedNumber: Promise<number> = overloadedMethodRef.echo(5);
const overloadedString: Promise<string> = overloadedMethodRef.echo("a");
// @ts-expect-error neither overload accepts a boolean.
overloadedMethodRef.echo(true);
void overloadedNumber;
void overloadedString;

class MutualActorA extends Actor<MutualActorA, { peer: ActorRef<MutualActorB> }> {
  @state accessor peer = this.input.peer;
  @action async callPeer(peer: ActorRef<MutualActorB>): Promise<ActorRef<MutualActorB>> { return peer; }
}
class MutualActorB extends Actor<MutualActorB, { peer: ActorRef<MutualActorA> }> {
  @state accessor peer = this.input.peer;
  @action async callPeer(peer: ActorRef<MutualActorA>): Promise<ActorRef<MutualActorA>> { return peer; }
}
declare const mutualARef: ActorRef<MutualActorA>;
declare const mutualBRef: ActorRef<MutualActorB>;
const mutualAResult: Promise<ActorRef<MutualActorB>> = mutualARef.callPeer(mutualBRef);
const mutualBResult: Promise<ActorRef<MutualActorA>> = mutualBRef.callPeer(mutualARef);
void mutualAResult;
void mutualBResult;

async function genericQueueTypes() {
  const numbers = await Actor.spawn(Queue<number>, { items: [1, 2] });
  const numberRead: readonly number[] = numbers.items;
  const numberPop: Promise<number | undefined> = numbers.pop();
  const numberEffectPop: Effect.Effect<number | undefined, ActorEffectError> = ActorEffect.call(numbers, "pop");
  await numbers.push(3);
  // @ts-expect-error number queues reject incompatible messages.
  await numbers.push("wrong");

  const objects = await Actor.spawn(Queue<{ id: string }>, { items: [{ id: "one" }] });
  const objectRead: readonly { readonly id: string }[] = objects.items;
  const objectPop: Promise<{ id: string } | undefined> = objects.pop();
  await objects.push({ id: "two" });
  // @ts-expect-error object queues reject incompatible messages.
  await objects.push({ name: "wrong" });

  const named = await Actor.ofNamed(Queue<{ id: string }>, "queue-types")
    .orSpawn(() => ({ items: [{ id: "named" }] }));
  const namedRead: readonly { readonly id: string }[] = named.items;

  const bare = await Actor.spawn(Queue, { items: [1, 2] });
  const bareRead: readonly Cloneable[] = bare.items;
  const barePop: Promise<Cloneable> = bare.pop();
  // @ts-expect-error without an instantiation expression, the item type degrades to Cloneable.
  const bareNumberPop: Promise<number | undefined> = bare.pop();
  void numberRead;
  void numberPop;
  void numberEffectPop;
  void objectRead;
  void objectPop;
  void namedRead;
  void bareRead;
  void barePop;
  void bareNumberPop;
}
void genericQueueTypes;
