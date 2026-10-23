import { expectTypeOf, test } from "vitest";
import { Actor, action, state } from "../src/index.js";
import type { ActorRef } from "../src/index.js";

class TypeFixture extends Actor<TypeFixture, { input: string }> {
  protected secret = "hidden";
  @state accessor count = 0;
  @state accessor values = [1, 2];
  @action async increment(by: number) { this.count += by; return this.count; }
  helper() { return this.count; }
}

class SyncActorActionMustFailTypecheck extends Actor<SyncActorActionMustFailTypecheck, {}> {
  // @ts-expect-error actor actions must return a Promise.
  @action sync() { return 1; }
}

test("actor refs expose asynchronous actions and read-only cloneable state", () => {
  const ref = null as unknown as ActorRef<TypeFixture>;
  expectTypeOf(ref.count).toEqualTypeOf<number>();
  expectTypeOf(ref.increment(1)).toEqualTypeOf<Promise<number>>();
  ref.increment.runDetached(1);
  // @ts-expect-error synchronous non-action methods are not exposed on refs.
  ref.helper();
  // @ts-expect-error nested state arrays are read-only.
  ref.values.push(3);
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
  expectTypeOf(synchronousResult).toEqualTypeOf<number>();
});
