import { expectTypeOf, test } from "vitest";
import { Actor, action } from "../src/index.js";
import type { ActorRef } from "../src/index.js";

class TypeFixture extends Actor<TypeFixture, { input: string }> {}

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

class UndecoratedUnsafeMethodActor extends Actor<UndecoratedUnsafeMethodActor, {}> {
  unsafe() { return new Money(5); }
}

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

test("action results accept structured-cloneable values and reject lossy values", () => {
  const unsafeResultRef = null as unknown as ActorRef<UnsafeResultFixture>;
  // @ts-expect-error actions with an any result cannot be called through a ref.
  unsafeResultRef.explicitAny();
  // @ts-expect-error JSON.parse's any result cannot be called through a ref.
  unsafeResultRef.parsed("{}");

  const undecoratedUnsafeMethodRef = null as unknown as ActorRef<UndecoratedUnsafeMethodActor>;
  // @ts-expect-error refs keep the concrete result guard for non-decorated methods.
  undecoratedUnsafeMethodRef.unsafe();

  const safeResultRef = null as unknown as ActorRef<SafeResultFixture>;
  expectTypeOf(safeResultRef.data()).toEqualTypeOf<Promise<{
    date: Date;
    regexp: RegExp;
    map: Map<string, number>;
    set: Set<number>;
    tuple: readonly ["actor", 1];
  }>>();
  expectTypeOf(safeResultRef.noResult()).toEqualTypeOf<Promise<void>>();

  const positiveRef = null as unknown as ActorRef<PositiveCloneabilityFixture>;
  expectTypeOf(positiveRef.interfaceResult()).toEqualTypeOf<Promise<InterfaceResult>>();
  expectTypeOf(positiveRef.referenceMap()).toEqualTypeOf<Promise<Map<string, ActorRef<TypeFixture>>>>();
  expectTypeOf(positiveRef.nullableResult()).toEqualTypeOf<Promise<InterfaceResult | null>>();
  expectTypeOf(positiveRef.recursiveResult()).toEqualTypeOf<Promise<RecursiveValue>>();
});
