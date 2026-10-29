import { actorRuntimeConformance } from "@mekakucity/verify";
import { actorEffectConformance } from "@mekakucity/verify/effect";
import { Actor, ActorRuntime, actor, state } from "@mekakucity/actors";
import { InMemoryActorRuntime } from "../src/index.js";
import { inMemoryActorRuntimeTestHooks } from "../src/testing.js";
import { expect, test } from "vitest";

let coreFactoryCalls = 0;
let effectFactoryCalls = 0;
const coreFactory = () => {
  coreFactoryCalls += 1;
  return new InMemoryActorRuntime();
};
const effectFactory = () => {
  effectFactoryCalls += 1;
  return new InMemoryActorRuntime();
};

actorRuntimeConformance(coreFactory, {
  createWithContext: (contextProvider) => new InMemoryActorRuntime({ contextProvider }),
  evictSnapshotCache(ref) {
    const runtime = ActorRuntime.current("evict the in-memory snapshot cache");
    if (!(runtime instanceof InMemoryActorRuntime)) throw new TypeError("Expected InMemoryActorRuntime");
    runtime[inMemoryActorRuntimeTestHooks]().evictSnapshotCache(ref);
  },
});
actorEffectConformance(effectFactory);

test("keeps core and effect conformance factories isolated", () => {
  expect(coreFactoryCalls).toBeGreaterThan(0);
  expect(effectFactoryCalls).toBeGreaterThan(0);
});

test("orNull/orSpawn on an existing named actor returns a ref whose state reads without refreshValues", async () => {
  @actor("days/conformance/NamedState")
  class NamedState extends Actor<NamedState, { value: number }> {
    @state accessor value = this.input.value;
  }

  const runtime = new InMemoryActorRuntime();
  await runtime.run(async () => {
    const seeded = await Actor.ofNamed(NamedState, "cached-lookup").orSpawn(() => ({ value: 42 }));

    runtime[inMemoryActorRuntimeTestHooks]().evictSnapshotCache(seeded);
    const fromOrNull = await Actor.ofNamed(NamedState, "cached-lookup").orNull();
    expect(fromOrNull?.value).toBe(42);

    runtime[inMemoryActorRuntimeTestHooks]().evictSnapshotCache(fromOrNull!);
    const [fromOrSpawn, fromPendingOrSpawn] = await Promise.all([
      Actor.ofNamed(NamedState, "cached-lookup").orSpawn(() => ({ value: 0 })),
      Actor.ofNamed(NamedState, "cached-lookup").orSpawn(() => ({ value: 0 })),
    ]);
    expect(fromOrSpawn.value).toBe(42);
    expect(fromPendingOrSpawn.value).toBe(42);
  });
});
