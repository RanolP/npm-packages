import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Actor, ActorRuntimeError, action, actor, type ActorRef } from "@mekakucity/actors";
import { actorClassOf, actorTypeIdOf } from "@mekakucity/actors/runtime";
import { describe, expect, test, vi } from "vitest";
import { DurableObjectActorRuntime } from "../src/index.js";
import { createHostRuntimeCore } from "../src/runtime.js";
import { TallyActor } from "./registered-actors.js";

const newRuntime = (scope: string) => new DurableObjectActorRuntime(env.ACTOR_HOST, { scope });
const stubOf = (ref: { id: string }) => env.ACTOR_HOST.get(env.ACTOR_HOST.idFromString(ref.id));

describe("@actor registration", () => {
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
    // Drops the host's in-memory actor, so the next call loads the class from the stored type id again.
    await runInDurableObject(stubOf(ref), (_instance, state) => state.abort()).catch(() => {});

    const count = await newRuntime(scope).run(async () =>
      (await Actor.ofNamed(TallyActor, "stored").orSpawn(() => ({ count: 100 }))).add());
    expect(count).toBe(2);
  });

  // Regression: @action registered only when an instance was constructed, and a worker never constructs the
  // actors it calls (they live in their ActorHost), so its refs had no action methods: `counter.add is not a function`.
  test("a ref built in an isolate that never constructed the actor exposes its actions", () => {
    @actor("registration/NeverConstructed")
    class NeverConstructed extends Actor<NeverConstructed, {}> {
      @action async add(amount: number): Promise<number> { return amount; }
    }
    const core = createHostRuntimeCore(env.ACTOR_HOST, crypto.randomUUID());
    const ref: ActorRef<NeverConstructed> = core.makeRef("registration/NeverConstructed", env.ACTOR_HOST.newUniqueId().toString());
    expect(typeof ref.add).toBe("function");
  });

  test("spawning a class without @actor throws in the caller and names it", async () => {
    class Stray extends Actor<Stray, {}> {
      @action async ping() {}
    }
    await expect(newRuntime(crypto.randomUUID()).run(() => Actor.spawn(Stray, {})))
      .rejects.toThrow(/Stray.*@actor\(id\)/);
  });

  test("a ref for a type id no loaded class carries throws instead of building a ref without actions", async () => {
    const runtime = newRuntime(crypto.randomUUID());
    await expect(runtime.run(() => Actor.refreshValues({ type: "registration/Missing", id: env.ACTOR_HOST.newUniqueId().toString() })))
      .rejects.toThrow(ActorRuntimeError);
  });

  // HMR and watch mode re-evaluate a module, defining the class again under the same id; the newer one must win.
  test("re-defining a class under the same id makes lookups by id return the new class", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      @actor("registration/Redefined")
      class Old extends Actor<Old, {}> {
        @action async before(): Promise<void> {}
      }
      expect(warn).not.toHaveBeenCalled();
      @actor("registration/Redefined")
      class New extends Actor<New, {}> {
        @action async after(): Promise<void> {}
      }
      // The same class object registering again under its own id is a no-op, not an override.
      actor("registration/Redefined")(New, {} as ClassDecoratorContext<typeof New>);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toContain("registration/Redefined");
      expect(actorClassOf("registration/Redefined")).toBe(New);
      expect(actorTypeIdOf(Old)).toBe("registration/Redefined");
      expect(actorTypeIdOf(New)).toBe("registration/Redefined");
    } finally {
      warn.mockRestore();
    }
    const core = createHostRuntimeCore(env.ACTOR_HOST, crypto.randomUUID());
    const ref = core.makeRef<Actor<unknown, unknown>>("registration/Redefined", env.ACTOR_HOST.newUniqueId().toString()) as unknown as Record<string, unknown>;
    expect(typeof ref.after).toBe("function");
    expect(ref.before).toBeUndefined();
  });
});
