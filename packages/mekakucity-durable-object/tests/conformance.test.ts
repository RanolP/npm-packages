import { env } from "cloudflare:test";
import { actorRuntimeConformance } from "@mekakucity/verify";
import { actorEffectConformance } from "@mekakucity/verify/effect";
import { DurableObjectActorRuntime } from "../src/index.js";
import { allowUnregisteredTypes } from "../src/testing.js";
import { snapshots } from "../src/snapshots.js";

// A random scope per runtime keeps named actors of one test away from every other test. The suites define their
// actor classes after the worker module loaded, so the scope registers them on first spawn (test-only path).
const factory = () => {
  const scope = crypto.randomUUID();
  allowUnregisteredTypes(scope);
  return new DurableObjectActorRuntime(env.ACTOR_HOST, { scope });
};

actorRuntimeConformance(factory, {
  // The isolate-wide snapshot cache is internal (not exported from the package entry), so tests reach it by path.
  evictSnapshotCache: (ref) => snapshots.delete(ref.id),
});
actorEffectConformance(factory);
