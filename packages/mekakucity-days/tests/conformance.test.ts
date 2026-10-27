import { actorRuntimeConformance } from "@mekakucity/verify";
import { actorEffectConformance } from "@mekakucity/verify/effect";
import { ActorRuntime } from "@mekakucity/actors";
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
