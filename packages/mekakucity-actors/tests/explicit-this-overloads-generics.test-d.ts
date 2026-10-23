import { Effect } from "effect";
import { assertType, expectTypeOf, test } from "vitest";
import { Actor, action } from "../src/index.js";
import { ActorEffect, type ActorEffectError } from "../src/effect.js";
import type { ActorRef, Cloneable } from "../src/index.js";

class ExplicitThisActor extends Actor<ExplicitThisActor, {}> {
  @action async selfy(this: ExplicitThisActor): Promise<number> { return 42; }
}

class ExplicitThisOverloadedActor extends Actor<ExplicitThisOverloadedActor, {}> {
  echo(this: ExplicitThisOverloadedActor, value: number): Promise<number>;
  echo(this: ExplicitThisOverloadedActor, value: string): Promise<string>;
  @action async echo(this: ExplicitThisOverloadedActor, value: number | string): Promise<number | string> { return value; }
}

class GenericMethodActor extends Actor<GenericMethodActor, {}> {
  @action async echo<T extends Cloneable>(value: T): Promise<T> { return value; }
}

class OverloadedMethodActor extends Actor<OverloadedMethodActor, {}> {
  echo(value: number): Promise<number>;
  echo(value: string): Promise<string>;
  @action async echo(value: number | string): Promise<number | string> { return value; }
}

test("explicit-this, overloads, and generic actions retain their supported call signatures", () => {
  const explicitThisRef = null as unknown as ActorRef<ExplicitThisActor>;
  expectTypeOf(explicitThisRef.selfy()).toEqualTypeOf<Promise<number>>();
  expectTypeOf(ActorEffect.call(explicitThisRef, "selfy")).toEqualTypeOf<Effect.Effect<number, ActorEffectError>>();

  const explicitThisOverloadedRef = null as unknown as ActorRef<ExplicitThisOverloadedActor>;
  // @ts-expect-error explicit-this overloads keep only the last signature.
  explicitThisOverloadedRef.echo(1);
  expectTypeOf(explicitThisOverloadedRef.echo("a")).toEqualTypeOf<Promise<string>>();

  const genericMethodRef = null as unknown as ActorRef<GenericMethodActor>;
  assertType<Promise<number>>(genericMethodRef.echo(5));
  assertType<Promise<string>>(genericMethodRef.echo("a"));
  // @ts-expect-error generic echo arguments still have to be cloneable.
  genericMethodRef.echo(() => 1);
  // Effect call widens this generic method's result to its Cloneable constraint.
  expectTypeOf(ActorEffect.call(genericMethodRef, "echo", 5)).toEqualTypeOf<Effect.Effect<Cloneable, ActorEffectError>>();
  // @ts-expect-error Effect calls retain the generic method's Cloneable argument constraint.
  ActorEffect.call(genericMethodRef, "echo", () => 1);

  const overloadedMethodRef = null as unknown as ActorRef<OverloadedMethodActor>;
  expectTypeOf(overloadedMethodRef.echo(5)).toEqualTypeOf<Promise<number>>();
  expectTypeOf(overloadedMethodRef.echo("a")).toEqualTypeOf<Promise<string>>();
  // @ts-expect-error neither overload accepts a boolean.
  overloadedMethodRef.echo(true);
});
