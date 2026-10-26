import { env } from "cloudflare:test";
import { actorRuntimeConformance } from "@mekakucity/verify";
import { actorEffectConformance } from "@mekakucity/verify/effect";
import { DurableObjectActorRuntime } from "../src/index.js";
import { snapshots } from "../src/snapshots.js";

// A random scope per runtime keeps named actors and registered types of one test away from every other test.
const factory = () => new DurableObjectActorRuntime(env.ACTOR_HOST, { scope: crypto.randomUUID() });

actorRuntimeConformance(factory, {
  // The isolate-wide snapshot cache is internal (not exported from the package entry), so tests reach it by path.
  evictSnapshotCache: (ref) => snapshots.delete(ref.id),
});
actorEffectConformance(factory);
