import { Effect } from "effect";
import { assertType, expectTypeOf, test } from "vitest";
import { Actor, action } from "../src/index.js";
import { ActorEffect, type ActorEffectError } from "../src/effect/index.js";
import type { ActorRef, Cloneable } from "../src/index.js";

class ExplicitThisActor extends Actor<ExplicitThisActor, {}> {
  // @ts-expect-error an explicit `this` would make the action uncallable on ActorRef, so @action rejects it.
  @action async selfy(this: ExplicitThisActor): Promise<number> { return 42; }
  // @ts-expect-error the rejection also covers void-returning actions, which resolve through the second decorator overload.
  @action async touch(this: ExplicitThisActor): Promise<void> {}
}

class ExplicitThisImplementationActor extends Actor<ExplicitThisImplementationActor, {}> {
  echo(value: number): Promise<number>;
  echo(value: string): Promise<string>;
  // @ts-expect-error an explicit `this` on the implementation of an overloaded action is rejected too.
  @action async echo(this: ExplicitThisImplementationActor, value: number | string): Promise<number | string> { return value; }
}

class GenericMethodActor extends Actor<GenericMethodActor, {}> {
  @action async echo<T extends Cloneable>(value: T): Promise<T> { return value; }
}

class OverloadedMethodActor extends Actor<OverloadedMethodActor, {}> {
  echo(value: number): Promise<number>;
  echo(value: string): Promise<string>;
  @action async echo(value: number | string): Promise<number | string> { return value; }
}

test("overloaded and generic actions keep their call signatures on refs", () => {
  const genericMethodRef = null as unknown as ActorRef<GenericMethodActor>;
  // A ref type that rebuilds the action signature from its parameters and result erases T and widens this to Promise<Cloneable>.
  expectTypeOf(genericMethodRef.echo(5)).toEqualTypeOf<Promise<5>>();
  assertType<Promise<string>>(genericMethodRef.echo("a"));
  // @ts-expect-error generic echo arguments still have to be cloneable.
  genericMethodRef.echo(() => 1);
  // Effect call widens this generic method's result to its Cloneable constraint.
  expectTypeOf(ActorEffect.call(genericMethodRef, "echo", 5)).toEqualTypeOf<Effect.Effect<Cloneable, ActorEffectError>>();
  // @ts-expect-error Effect calls retain the generic method's Cloneable argument constraint.
  ActorEffect.call(genericMethodRef, "echo", () => 1);

  const overloadedMethodRef = null as unknown as ActorRef<OverloadedMethodActor>;
  // A ref type that rebuilds the action signature keeps only the last (string) overload.
  expectTypeOf(overloadedMethodRef.echo(5)).toEqualTypeOf<Promise<number>>();
  expectTypeOf(overloadedMethodRef.echo("a")).toEqualTypeOf<Promise<string>>();
  // @ts-expect-error neither overload accepts a boolean.
  overloadedMethodRef.echo(true);
});
