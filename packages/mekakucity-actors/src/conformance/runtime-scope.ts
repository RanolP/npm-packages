import { expect } from "vitest";
import { Actor, NoActiveActorRuntimeError, action, state } from "../index.js";
import type { ActorRuntime } from "../runtime/actor-runtime.js";
import { createRuntimeTestTools, type ActorRuntimeConformanceHooks } from "./runtime.js";

class ScopedCounter extends Actor<{ value: number }, { value: number }> {
  @state accessor value: number;

  constructor(input: { value: number }) {
    super(input);
    this.value = input.value;
  }

  @action async read(): Promise<number> {
    return this.value;
  }
}

export const runtimeScopeSuite = (factory: () => ActorRuntime, hooks?: ActorRuntimeConformanceHooks): void => {
  const { itOutsideRuntime } = createRuntimeTestTools(factory, hooks);

itOutsideRuntime("rejects actor transactions when no runtime is active", () => {
  expect(() => Actor.transaction(() => 0)).toThrow(NoActiveActorRuntimeError);
});

itOutsideRuntime("isolates nested transactions owned by different runtimes", async () => {
  const runtimeA = factory();
  const runtimeB = factory();

  await runtimeA.run(() => Actor.transaction(async () => {
    await runtimeB.run(() => Actor.transaction(async () => {
      await Actor.ofNamed(ScopedCounter, "runtime-b").orSpawn(() => ({ value: 2 }));
    }));
  }));

  const visibleInA = await runtimeA.run(() => Actor.transaction(() => Actor.ofNamed(ScopedCounter, "runtime-b").orNull()));
  const visibleInB = await runtimeB.run(() => Actor.transaction(() => Actor.ofNamed(ScopedCounter, "runtime-b").orNull()));
  expect(visibleInA).toBeNull();
  expect(visibleInB).not.toBeNull();
});
};
