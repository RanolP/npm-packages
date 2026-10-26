import { Effect } from "effect";
import { assertType, expectTypeOf, test } from "vitest";
import { Actor, actor, action, state } from "../src/index.js";
import { ActorEffect, type ActorEffectError } from "../src/effect/index.js";
import type { Cloneable } from "../src/index.js";

class Money {
  constructor(readonly amount: number) {}
  format() { return `$${this.amount}`; }
}

@actor("generic-queues/Queue")
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
// @ts-expect-error instances with methods are not valid queue payloads.
type MoneyQueue = Queue<Money>;

test("generic queues preserve pinned payloads and degrade bare payloads to Cloneable", async () => {
  expectTypeOf<FunctionQueue>().toBeObject();
  expectTypeOf<MoneyQueue>().toBeObject();

  const numbers = await Actor.spawn(Queue<number>, { items: [1, 2] });
  expectTypeOf(numbers.items).toEqualTypeOf<readonly number[]>();
  expectTypeOf(numbers.pop()).toEqualTypeOf<Promise<number | undefined>>();
  expectTypeOf(ActorEffect.call(numbers, "pop")).toEqualTypeOf<Effect.Effect<number | undefined, ActorEffectError>>();
  await numbers.push(3);
  // @ts-expect-error number queues reject incompatible messages.
  await numbers.push("wrong");

  const objects = await Actor.spawn(Queue<{ id: string }>, { items: [{ id: "one" }] });
  expectTypeOf(objects.items).toEqualTypeOf<readonly { readonly id: string }[]>();
  expectTypeOf(objects.pop()).toEqualTypeOf<Promise<{ id: string } | undefined>>();
  await objects.push({ id: "two" });
  // @ts-expect-error object queues reject incompatible messages.
  await objects.push({ name: "wrong" });

  const named = await Actor.ofNamed(Queue<{ id: string }>, "queue-types")
    .orSpawn(() => ({ items: [{ id: "named" }] }));
  expectTypeOf(named.items).toEqualTypeOf<readonly { readonly id: string }[]>();

  const bare = await Actor.spawn(Queue, { items: [1, 2] });
  assertType<readonly Cloneable[]>(bare.items);
  expectTypeOf(bare.pop()).toEqualTypeOf<Promise<Cloneable>>();
  // @ts-expect-error without an instantiation expression, the item type degrades to Cloneable.
  const bareNumberPop: Promise<number | undefined> = bare.pop();
  expectTypeOf(bareNumberPop).toEqualTypeOf<Promise<number | undefined>>();
});
