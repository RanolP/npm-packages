import {
  Actor,
  actor,
  ActorNotFoundError,
  ActorStateSerializationError,
  NoActiveActorRuntimeError,
  action,
  state,
} from "@mekakucity/actors";
import type { ActorRef } from "@mekakucity/actors";
import type { ActorRuntime } from "@mekakucity/actors/runtime";
import { describe, expect } from "vitest";
import { createRuntimeTestTools, type ActorRuntimeConformanceHooks } from "./runtime.js";
import { deferred, turn } from "./helpers.js";

export const transactionSuite = (factory: () => ActorRuntime, hooks?: ActorRuntimeConformanceHooks): void => {
  const { it, itOutsideRuntime } = createRuntimeTestTools(factory, hooks);
  describe("@mekakucity/actors transactions", () => {
  itOutsideRuntime("rethrows the original error from a run and from an action", async () => {
    const runtime = factory();
    const runFailure = new Error("run failure");
    await expect(runtime.run(() => { throw runFailure; })).rejects.toBe(runFailure);

    const actionFailure = new Error("action failure");
    @actor("verify/transactions/FailingActor")
    class FailingActor extends Actor<FailingActor, {}> {
      @action async fail() { throw actionFailure; }
    }
    await runtime.run(() => Actor.ofNamed(FailingActor, "original-error").orSpawn(() => ({})));
    await expect(runtime.run(async () => {
      const ref = await Actor.ofNamed(FailingActor, "original-error").orSpawn(() => ({}));
      await ref.fail();
    })).rejects.toBe(actionFailure);
  });

  itOutsideRuntime("keeps a cross-actor segment committed before its run fails", async () => {
    const runtime = factory();
    @actor("verify/transactions/Peer")
    class Peer extends Actor<Peer, {}> {
      @action async ping() { return "pong"; }
    }
    @actor("verify/transactions/Counter")
    class Counter extends Actor<Counter, { peer: ActorRef<Peer> }> {
      @state accessor value = 0;
      @state accessor peer = this.input.peer;
      @action async commitAcrossActor() { this.value = 1; await this.peer.ping(); }
    }

    await runtime.run(async () => {
      const peer = await Actor.ofNamed(Peer, "commit-peer").orSpawn(() => ({}));
      await Actor.ofNamed(Counter, "committed-counter").orSpawn(() => ({ peer }));
    });
    const failure = new Error("fail after commit");
    await expect(runtime.run(async () => {
      const ref = await Actor.ofNamed(Counter, "committed-counter").orSpawn(async () => ({
        peer: await Actor.ofNamed(Peer, "commit-peer").orSpawn(() => ({})),
      }));
      await ref.commitAcrossActor();
      throw failure;
    })).rejects.toBe(failure);
    await runtime.run(async () => {
      const ref = await Actor.ofNamed(Counter, "committed-counter").orNull();
      expect(ref?.value).toBe(1);
    });
  });

  itOutsideRuntime("does not overwrite a concurrent commit when another run fails", async () => {
    const runtime = factory();
    @actor("verify/transactions/NamedCounter")
    class NamedCounter extends Actor<NamedCounter, {}> {
      @state accessor value = 0;
      @action async set(value: number) { this.value = value; }
    }
    await runtime.run(() => Actor.ofNamed(NamedCounter, "concurrent-counter").orSpawn(() => ({})));

    const firstCommitted = deferred();
    const releaseFirst = deferred();
    const failure = new Error("first run fails late");
    const first = runtime.run(async () => {
      const ref = await Actor.ofNamed(NamedCounter, "concurrent-counter").orSpawn(() => ({}));
      await ref.set(1);
      firstCommitted.resolve();
      await releaseFirst.promise;
      throw failure;
    });
    await firstCommitted.promise;
    await runtime.run(async () => {
      const ref = await Actor.ofNamed(NamedCounter, "concurrent-counter").orSpawn(() => ({}));
      await ref.set(2);
    });
    releaseFirst.resolve();
    await expect(first).rejects.toBe(failure);
    await runtime.run(async () => {
      const ref = await Actor.ofNamed(NamedCounter, "concurrent-counter").orNull();
      expect(ref?.value).toBe(2);
    });
  });

  it("rejects non-structured-cloneable state at commit and rolls back", async (runtime) => {
    @actor("verify/transactions/SerializableActor")
    class SerializableActor extends Actor<SerializableActor, {}> {
      @state accessor value: unknown = "safe";
      @action async breakState() { this.value = () => "not cloneable"; }
    }

    await runtime.run(async () => {
      const ref = await Actor.spawn(SerializableActor, {});
      await expect(ref.breakState()).rejects.toBeInstanceOf(ActorStateSerializationError);
      expect(ref.value).toBe("safe");
    });
  });

  it("serializes each actor mailbox and keeps request order", async (runtime) => {
    const releaseFirst = deferred();
    const firstStarted = deferred();
    const events: string[] = [];
    @actor("verify/transactions/MailboxActor")
    class MailboxActor extends Actor<MailboxActor, {}> {
      @action async work(label: string) {
        events.push(`start:${label}`);
        if (label === "first") {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        events.push(`end:${label}`);
      }
    }

    await runtime.run(async () => {
      const ref = await Actor.spawn(MailboxActor, {});
      const first = ref.work("first");
      await firstStarted.promise;
      const second = ref.work("second");
      await turn();
      expect(events).toEqual(["start:first"]);
      releaseFirst.resolve();
      await Promise.all([first, second]);
      expect(events).toEqual(["start:first", "end:first", "start:second", "end:second"]);
    });
  });

  it("rolls back an action and isolates caught same-actor sub-transaction failures", async (runtime) => {
    @actor("verify/transactions/NestedActor")
    class NestedActor extends Actor<NestedActor, {}> {
      @state accessor count = 0;
      @action async childFailure() { this.count += 10; throw new Error("child"); }
      @action async parent() {
        this.count += 1;
        try { await this.childFailure(); } catch { /* parent continues */ }
        this.count += 1;
      }
      @action async fail() { this.count = 99; throw new Error("parent"); }
    }

    await runtime.run(async () => {
      const ref = await Actor.spawn(NestedActor, {});
      await ref.parent();
      expect(ref.count).toBe(2);
      await expect(ref.fail()).rejects.toThrow("parent");
      expect(ref.count).toBe(2);
    });
  });

  it("commits before a cross-actor await and holds the caller mailbox until the reply", async (runtime) => {
    const entered = deferred();
    const release = deferred();
    @actor("verify/transactions/GateActor")
    class GateActor extends Actor<GateActor, {}> {
      @action async pause() { entered.resolve(); await release.promise; }
    }
    @actor("verify/transactions/WaitingActor")
    class WaitingActor extends Actor<WaitingActor, { gate: ActorRef<GateActor> }> {
      @state accessor value = 0;
      @state accessor gate = this.input.gate;
      @action async waitAcrossActor() { this.value = 1; await this.gate.pause(); this.value = 2; }
      @action async increment() { this.value += 1; }
      @action async spawnChild() { this.value = 4; await Actor.spawn(GateActor, {}); }
    }

    await runtime.run(async () => {
      const gate = await Actor.spawn(GateActor, {});
      const ref = await Actor.spawn(WaitingActor, { gate });
      const first = ref.waitAcrossActor();
      await entered.promise;
      await Actor.refreshValues(ref);
      expect(ref.value).toBe(1);
      const second = ref.increment();
      await turn();
      await Actor.refreshValues(ref);
      expect(ref.value).toBe(1);
      release.resolve();
      await Promise.all([first, second]);
      expect(ref.value).toBe(3);
      await ref.spawnChild();
      expect(ref.value).toBe(4);
    });
  });

  it("re-persists the action start snapshot after a nested cross-actor commit then failure", async (runtime) => {
    @actor("verify/transactions/CommitPointActor")
    class CommitPointActor extends Actor<CommitPointActor, {}> {
      @action async ping() { return "pong"; }
    }
    @actor("verify/transactions/RollbackAfterCommitActor")
    class RollbackAfterCommitActor extends Actor<RollbackAfterCommitActor, { peer: ActorRef<CommitPointActor> }> {
      @state accessor n = 0;
      @state accessor peer = this.input.peer;
      @action async inner() { this.n = 5; await this.peer.ping(); }
      @action async run() { await this.inner(); throw new Error("abort after commit point"); }
    }

    await runtime.run(async () => {
      const peer = await Actor.spawn(CommitPointActor, {});
      const ref = await Actor.spawn(RollbackAfterCommitActor, { peer });
      await expect(ref.run()).rejects.toThrow("abort after commit point");
      await Actor.refreshValues(ref);
      expect(ref.n).toBe(0);
    });
  });

  it("named actors reuse one rooted instance and actor operations require a runtime run", async (runtime) => {
    @actor("verify/transactions/NamedCounter#2")
    class NamedCounter extends Actor<NamedCounter, { count: number }> {
      @state accessor count = this.input.count;
    }
    expect(() => Actor.ofNamed(NamedCounter, "singleton")).toThrow(NoActiveActorRuntimeError);
    expect(() => Actor.spawn(NamedCounter, { count: 0 })).toThrow(NoActiveActorRuntimeError);

    await runtime.run(async () => {
      const named = Actor.ofNamed(NamedCounter, "singleton");
      expect(await named.orNull()).toBeNull();
      const [first, second] = await Promise.all([
        named.orSpawn(() => ({ count: 1 })),
        named.orSpawn(() => ({ count: 2 })),
      ]);
      expect(first.id).toBe(second.id);
      expect(first.count).toBe(1);
    });

    await runtime.run(async () => {
      const existing = await Actor.ofNamed(NamedCounter, "singleton").orSpawn(() => ({ count: 3 }));
      expect(existing.count).toBe(1);
    });
  });

  it("orThrow returns an existing ref and rejects missing actors with the requested error", async (runtime) => {
    @actor("verify/transactions/RequiredActor")
    class RequiredActor extends Actor<RequiredActor, {}> {}

    await runtime.run(async () => {
      const existing = await Actor.ofNamed(RequiredActor, "existing").orSpawn(() => ({}));
      expect((await Actor.ofNamed(RequiredActor, "existing").orThrow()).id).toBe(existing.id);

      const requested = new Error("required actor missing");
      await expect(Actor.ofNamed(RequiredActor, "requested").orThrow(() => requested)).rejects.toBe(requested);
      await expect(Actor.ofNamed(RequiredActor, "default").orThrow()).rejects.toEqual(
        new ActorNotFoundError("verify/transactions/RequiredActor", "default"),
      );
    });
  });
  });
};
