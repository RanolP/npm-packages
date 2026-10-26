import { Actor, ActorSelfRefUnavailableError, action, state } from "@mekakucity/actors";
import type { ActorRef } from "@mekakucity/actors";
import type { ActorRuntime } from "@mekakucity/actors/runtime";
import { describe, expect } from "vitest";
import { deferred, turn } from "./helpers.js";
import { createRuntimeTestTools, type ActorRuntimeConformanceHooks } from "./runtime.js";

export const selfReferenceSuite = (factory: () => ActorRuntime, hooks?: ActorRuntimeConformanceHooks): void => {
  const { it } = createRuntimeTestTools(factory, hooks);
  describe("@mekakucity/actors self references", () => {
  it("runs a detached self-message after the sending action commits", async (runtime) => {
    const processed = deferred();
    class SelfMessagingActor extends Actor<SelfMessagingActor, {}> {
      @state accessor count = 0;
      get doubled() { return this.count * 2; }
      @action async send() { this.count = 1; this.asRef.increment.runDetached(1); }
      @action async increment(by: number) { this.count += by; processed.resolve(); }
      @action async typecheckOnly() {
        this.asRef.increment.runDetached(1);
        // @ts-expect-error self references expose detached calls only.
        this.asRef.increment(1);
        // @ts-expect-error self references do not expose actor state.
        this.asRef.count;
        // @ts-expect-error self references do not expose actor getters.
        this.asRef.doubled;
        // @ts-expect-error self references cannot be passed as actor references.
        const ref: ActorRef<SelfMessagingActor> = this.asRef;
        void ref;
      }
    }

    const actor = await runtime.run(async () => {
      const ref = await Actor.ofNamed(SelfMessagingActor, "detached-self-message").orSpawn(() => ({}));
      await ref.send();
      return ref;
    });
    await processed.promise;
    await runtime.run(async () => {
      await Actor.refreshValues(actor);
      expect(actor.count).toBe(2);
    });
  });

  it("discards a detached self-message when the sending action rolls back", async (runtime) => {
    const processed = deferred();
    class RollingBackActor extends Actor<RollingBackActor, {}> {
      @state accessor count = 0;
      @action async sendThenFail() { this.asRef.increment.runDetached(); throw new Error("rollback"); }
      @action async send() { this.asRef.increment.runDetached(); }
      @action async increment() { this.count += 1; processed.resolve(); }
    }

    const actor = await runtime.run(async () => {
      const ref = await Actor.ofNamed(RollingBackActor, "rolled-back-self-message").orSpawn(() => ({}));
      await expect(ref.sendThenFail()).rejects.toThrow("rollback");
      return ref;
    });
    await turn();
    await runtime.run(async () => {
      await Actor.refreshValues(actor);
      expect(actor.count).toBe(0);
    });

    await runtime.run(() => actor.send());
    await processed.promise;
    await runtime.run(async () => {
      await Actor.refreshValues(actor);
      expect(actor.count).toBe(1);
    });
  });

  it("keeps Actor.asRef off actor references and rejects it during construction", async (runtime) => {
    class ConstructorActor extends Actor<ConstructorActor, {}> {
      @state accessor errorName = (() => {
        try {
          void this.asRef;
          return null;
        } catch (error) {
          return error instanceof Error ? error.name : null;
        }
      })();
    }

    await runtime.run(async () => {
      const actor = await Actor.spawn(ConstructorActor, {});
      expect("asRef" in actor).toBe(false);
      expect(actor.errorName).toBe(ActorSelfRefUnavailableError.name);
    });
  });
  });
};
