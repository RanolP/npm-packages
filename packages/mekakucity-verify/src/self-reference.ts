import { Actor, actor, ActorScheduleError, ActorSelfRefUnavailableError, action, state } from "@mekakucity/actors";
import type { ActorRef } from "@mekakucity/actors";
import type { ActorRuntime } from "@mekakucity/actors/runtime";
import { describe, expect } from "vitest";
import { completesBeforeTimeout, deferred, turn } from "./helpers.js";
import { createRuntimeTestTools, type ActorRuntimeConformanceHooks } from "./runtime.js";

export const selfReferenceSuite = (factory: () => ActorRuntime, hooks?: ActorRuntimeConformanceHooks): void => {
  const { it } = createRuntimeTestTools(factory, hooks);
  describe("@mekakucity/actors self references", () => {
  it("runs a detached self-message after the sending action commits", async (runtime) => {
    const processed = deferred();
    @actor("verify/self-reference/SelfMessagingActor")
    class SelfMessagingActor extends Actor<SelfMessagingActor, {}> {
      @state accessor count = 0;
      get doubled() { return this.count * 2; }
      @action async send() { this.count = 1; this.asRef.increment.runDetached(1); }
      @action async increment(by: number) { this.count += by; processed.resolve(); }
      @action async typecheckOnly() {
        this.asRef.increment.runDetached(1);
        this.asRef.increment.schedule({ after: { ms: 1000 } }).runDetached(1);
        this.asRef.increment.schedule({ at: new Date() }).runDetached(1);
        // @ts-expect-error self schedules accept exactly one timing form.
        this.asRef.increment.schedule({ after: { ms: 1000 }, at: new Date() });
        // @ts-expect-error self schedules require an after object rather than a bare number.
        this.asRef.increment.schedule({ after: 1000 });
        // @ts-expect-error scheduled self actions expose only runDetached.
        this.asRef.increment.schedule({ after: { ms: 1000 } }).foo;
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

    const subject = await runtime.run(async () => {
      const ref = await Actor.ofNamed(SelfMessagingActor, "detached-self-message").orSpawn(() => ({}));
      await ref.send();
      return ref;
    });
    await processed.promise;
    await runtime.run(async () => {
      await Actor.refreshValues(subject);
      expect(subject.count).toBe(2);
    });
  });

  it("runs a scheduled self-message only after its committed delay", async (runtime) => {
    const processed = deferred<number>();
    @actor("verify/self-reference/ScheduledActor")
    class ScheduledActor extends Actor<ScheduledActor, {}> {
      @action async send() {
        this.asRef.receive.schedule({ after: { ms: 100 } }).runDetached();
        return Date.now();
      }
      @action async receive() { processed.resolve(Date.now()); }
    }

    const committedAt = await runtime.run(async () => {
      const ref = await Actor.ofNamed(ScheduledActor, "scheduled-self-message").orSpawn(() => ({}));
      return ref.send();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    let ran = false;
    void processed.promise.then(() => { ran = true; });
    await turn();
    expect(ran).toBe(false);
    expect(await processed.promise).toBeGreaterThanOrEqual(committedAt + 90);
  });

  it("keeps a far-future scheduled message pending", async (runtime) => {
    let ran = false;
    @actor("verify/self-reference/FarFutureActor")
    class FarFutureActor extends Actor<FarFutureActor, {}> {
      @action async send() {
        this.asRef.receive.schedule({ after: { ms: 30 * 24 * 60 * 60 * 1000 } }).runDetached();
      }
      @action async receive() { ran = true; }
    }

    await runtime.run(async () => {
      const ref = await Actor.ofNamed(FarFutureActor, "far-future-schedule").orSpawn(() => ({}));
      await ref.send();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toBe(false);
  });

  it("measures a scheduled delay from the final sending commit", async (runtime) => {
    const processed = deferred<number>();
    @actor("verify/self-reference/SlowPeer")
    class SlowPeer extends Actor<SlowPeer, {}> {
      @action async wait() { await new Promise((resolve) => setTimeout(resolve, 300)); }
    }
    @actor("verify/self-reference/CommitTimedActor")
    class CommitTimedActor extends Actor<CommitTimedActor, { peer: ActorRef<SlowPeer> }> {
      @action async send() {
        this.asRef.receive.schedule({ after: { ms: 200 } }).runDetached();
        await this.input.peer.wait();
        return Date.now();
      }
      @action async receive() { processed.resolve(Date.now()); }
    }

    const committedAt = await runtime.run(async () => {
      const peer = await Actor.ofNamed(SlowPeer, "scheduled-commit-peer").orSpawn(() => ({}));
      const ref = await Actor.ofNamed(CommitTimedActor, "scheduled-commit-sender").orSpawn(() => ({ peer }));
      return ref.send();
    });
    expect(await processed.promise).toBeGreaterThanOrEqual(committedAt + 180);
  });

  it("discards a scheduled self-message when the sending action rolls back", async (runtime) => {
    @actor("verify/self-reference/ScheduledRollbackActor")
    class ScheduledRollbackActor extends Actor<ScheduledRollbackActor, {}> {
      @state accessor count = 0;
      @action async sendThenFail() {
        this.asRef.increment.schedule({ after: { ms: 50 } }).runDetached();
        throw new Error("rollback");
      }
      @action async increment() { this.count += 1; }
    }

    const ref = await runtime.run(async () => {
      const ref = await Actor.ofNamed(ScheduledRollbackActor, "scheduled-rollback").orSpawn(() => ({}));
      await expect(ref.sendThenFail()).rejects.toThrow("rollback");
      return ref;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await runtime.run(async () => {
      await Actor.refreshValues(ref);
      expect(ref.count).toBe(0);
    });
  });

  it("runs an absolute schedule in the past promptly", async (runtime) => {
    const processed = deferred();
    @actor("verify/self-reference/PastScheduleActor")
    class PastScheduleActor extends Actor<PastScheduleActor, {}> {
      @action async send() { this.asRef.receive.schedule({ at: new Date(0) }).runDetached(); }
      @action async receive() { processed.resolve(); }
    }

    await runtime.run(async () => {
      const ref = await Actor.ofNamed(PastScheduleActor, "past-schedule").orSpawn(() => ({}));
      await ref.send();
    });
    await completesBeforeTimeout(processed.promise);
  });

  it("orders detached messages by due time before send order", async (runtime) => {
    const processed = deferred();
    @actor("verify/self-reference/ScheduledOrderActor")
    class ScheduledOrderActor extends Actor<ScheduledOrderActor, {}> {
      @state accessor order: string[] = [];
      @action async send() {
        this.asRef.record.schedule({ after: { ms: 150 } }).runDetached("late");
        this.asRef.record.runDetached("early");
      }
      @action async record(value: string) {
        this.order = [...this.order, value];
        if (this.order.length === 2) processed.resolve();
      }
    }

    const ref = await runtime.run(async () => {
      const ref = await Actor.ofNamed(ScheduledOrderActor, "scheduled-order").orSpawn(() => ({}));
      await ref.send();
      return ref;
    });
    await completesBeforeTimeout(processed.promise);
    await runtime.run(async () => {
      await Actor.refreshValues(ref);
      expect(ref.order).toEqual(["early", "late"]);
    });
  });

  it("runs detached messages concurrently across different targets", async (runtime) => {
    const release = deferred();
    const completed = deferred();
    @actor("verify/self-reference/WaitingActor")
    class WaitingActor extends Actor<WaitingActor, {}> {
      @action async wait() {
        await release.promise;
        completed.resolve();
      }
    }
    @actor("verify/self-reference/ReleasingActor")
    class ReleasingActor extends Actor<ReleasingActor, {}> {
      @action async release() { release.resolve(); }
    }
    @actor("verify/self-reference/ConcurrentSender")
    class ConcurrentSender extends Actor<ConcurrentSender, {
      waiting: ActorRef<WaitingActor>;
      releasing: ActorRef<ReleasingActor>;
    }> {
      @state accessor waiting = this.input.waiting;
      @state accessor releasing = this.input.releasing;
      @action async send() {
        this.waiting.wait.runDetached();
        this.releasing.release.runDetached();
      }
    }

    await runtime.run(async () => {
      const waiting = await Actor.ofNamed(WaitingActor, "concurrent-waiting").orSpawn(() => ({}));
      const releasing = await Actor.ofNamed(ReleasingActor, "concurrent-releasing").orSpawn(() => ({}));
      const sender = await Actor.ofNamed(ConcurrentSender, "concurrent-sender")
        .orSpawn(() => ({ waiting, releasing }));
      await sender.send();
    });
    await completesBeforeTimeout(completed.promise);
  });

  it("rejects invalid schedule options when schedule is called", async (runtime) => {
    @actor("verify/self-reference/ValidatedScheduleActor")
    class ValidatedScheduleActor extends Actor<ValidatedScheduleActor, {}> {
      @action async receive() {}
    }
    const ref = await runtime.run(() =>
      Actor.ofNamed(ValidatedScheduleActor, "validated-schedule").orSpawn(() => ({})));
    const schedule = ref.receive.schedule as (options: unknown) => unknown;

    expect(() => schedule({ after: { ms: -1 } })).toThrow(ActorScheduleError);
    expect(() => schedule({ after: { ms: Number.NaN } })).toThrow(ActorScheduleError);
    expect(() => schedule({ after: { ms: 8_640_000_000_000_001 } })).toThrow(ActorScheduleError);
    expect(() => schedule({ at: new Date(Number.NaN) })).toThrow(ActorScheduleError);
    expect(() => schedule({})).toThrow(ActorScheduleError);
    expect(() => schedule({ after: { ms: 1 }, at: new Date() })).toThrow(ActorScheduleError);
  });

  it("keeps an anonymous actor alive while its scheduled message is pending", async (runtime) => {
    const processed = deferred();
    @actor("verify/self-reference/ScheduledAnonymousActor")
    class ScheduledAnonymousActor extends Actor<ScheduledAnonymousActor, {}> {
      @action async receive() { processed.resolve(); }
    }
    @actor("verify/self-reference/AnonymousScheduler")
    class AnonymousScheduler extends Actor<AnonymousScheduler, {}> {
      @action async send() {
        const target = await Actor.spawn(ScheduledAnonymousActor, {});
        target.receive.schedule({ after: { ms: 50 } }).runDetached();
      }
    }

    await runtime.run(async () => {
      const sender = await Actor.ofNamed(AnonymousScheduler, "anonymous-scheduler").orSpawn(() => ({}));
      await sender.send();
    });
    await completesBeforeTimeout(processed.promise);
  });

  it("discards a detached self-message when the sending action rolls back", async (runtime) => {
    const processed = deferred();
    @actor("verify/self-reference/RollingBackActor")
    class RollingBackActor extends Actor<RollingBackActor, {}> {
      @state accessor count = 0;
      @action async sendThenFail() { this.asRef.increment.runDetached(); throw new Error("rollback"); }
      @action async send() { this.asRef.increment.runDetached(); }
      @action async increment() { this.count += 1; processed.resolve(); }
    }

    const subject = await runtime.run(async () => {
      const ref = await Actor.ofNamed(RollingBackActor, "rolled-back-self-message").orSpawn(() => ({}));
      await expect(ref.sendThenFail()).rejects.toThrow("rollback");
      return ref;
    });
    await turn();
    await runtime.run(async () => {
      await Actor.refreshValues(subject);
      expect(subject.count).toBe(0);
    });

    await runtime.run(() => subject.send());
    await processed.promise;
    await runtime.run(async () => {
      await Actor.refreshValues(subject);
      expect(subject.count).toBe(1);
    });
  });

  it("keeps Actor.asRef off actor references and rejects it during construction", async (runtime) => {
    @actor("verify/self-reference/ConstructorActor")
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
      const subject = await Actor.spawn(ConstructorActor, {});
      expect("asRef" in subject).toBe(false);
      expect(subject.errorName).toBe(ActorSelfRefUnavailableError.name);
    });
  });
  });
};
