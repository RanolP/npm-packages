import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Actor, action } from "@mekakucity/actors";
import { describe, expect, test } from "vitest";
import { DurableObjectActorRuntime, defineActorHost } from "../src/index.js";
import { TallyActor } from "./registered-actors.js";

// No allowUnregisteredTypes(scope) here: these runtimes see only what tests/worker.ts passed to defineActorHost.
const newRuntime = (scope: string) => new DurableObjectActorRuntime(env.ACTOR_HOST, { scope });
const stubOf = (ref: { id: string }) => env.ACTOR_HOST.get(env.ACTOR_HOST.idFromString(ref.id));

describe("defineActorHost registration", () => {
  // Regression: a host resolved actor classes only from registrations the caller made in the same isolate, so a
  // Durable Object woken in a fresh isolate of a deployed worker threw "Actor type ... is not registered".
  test("a reloaded host runs a stored actor using only the module-load registration", async () => {
    const scope = crypto.randomUUID();
    const ref = await newRuntime(scope).run(async () => {
      const tally = await Actor.ofNamed(TallyActor, "stored").orSpawn(() => ({ count: 0 }));
      await tally.add();
      return tally;
    });
    const meta = await runInDurableObject(stubOf(ref), (_instance, state) => state.storage.kv.get<{ type: string }>("meta"));
    expect(meta?.type).toBe("Tally");
    // Drops the host's in-memory actor, so the next call loads the class from the stored type name again.
    await runInDurableObject(stubOf(ref), (_instance, state) => state.abort()).catch(() => {});

    const count = await newRuntime(scope).run(async () =>
      (await Actor.ofNamed(TallyActor, "stored").orSpawn(() => ({ count: 100 }))).add());
    expect(count).toBe(2);
  });

  // Regression: spawning silently registered any class, so a worker missing it in defineActorHost only failed
  // later, on a host in another isolate.
  test("spawning a class missing from defineActorHost throws in the caller and names it", async () => {
    class Stray extends Actor<Stray, {}> {
      @action async ping() {}
    }
    await expect(newRuntime(crypto.randomUUID()).run(() => Actor.spawn(Stray, {})))
      .rejects.toThrow(/Stray.*defineActorHost/);
  });

  test("defineActorHost rejects a name or class bound twice inconsistently", () => {
    class Other extends Actor<Other, {}> {}
    expect(() => defineActorHost({ Tally: TallyActor })).not.toThrow();
    expect(() => defineActorHost({ Tally: Other })).toThrow(/"Tally"/);
    expect(() => defineActorHost({ TallyAgain: TallyActor })).toThrow(/TallyActor/);
  });
});
