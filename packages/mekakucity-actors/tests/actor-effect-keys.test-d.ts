import { expectTypeOf, test } from "vitest";
import { Effect } from "effect";
import { Actor, action } from "../src/index.js";
import { ActorEffect } from "../src/effect/index.js";
import type { ActorRef, ActorRuntime } from "../src/index.js";

declare const runtime: ActorRuntime;

class EffectFixture extends Actor<EffectFixture, {}> {
  @action async action(value: number) { return value; }
  helper() { return 1; }
  @action async parsed(value: string) { return JSON.parse(value); }
}

test("ActorEffect accepts callable action keys and excludes synchronous or unsafe-result keys", () => {
  const ref = null as unknown as ActorRef<EffectFixture>;
  expectTypeOf(ActorEffect.call(ref, "action", 1)).toBeObject();
  expectTypeOf(ActorEffect.run(runtime, Effect.succeed(1))).toBeObject();
  ActorEffect.runDetached(ref, "action", 1);
  // @ts-expect-error ActorEffect.call rejects synchronous non-action methods.
  ActorEffect.call(ref, "helper");
  // @ts-expect-error ActorEffect.runDetached rejects synchronous non-action methods.
  ActorEffect.runDetached(ref, "helper");
  // @ts-expect-error ActionEffect excludes action keys whose ref result is never.
  ActorEffect.call(ref, "parsed", "{}");
});
