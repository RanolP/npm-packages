import { Actor, ActorStateSerializationError, NoActiveTransactionError, action, state } from "../index.js";
import type { ActorRef } from "../index.js";
import type { ActorRuntime } from "../runtime/actor-runtime.js";
import { describe, expect } from "vitest";
import { createRuntimeTestTools, type ActorRuntimeConformanceHooks } from "./runtime.js";
import { deferred, turn } from "./helpers.js";

export const transactionSuite = (factory: () => ActorRuntime, hooks?: ActorRuntimeConformanceHooks): void => {
  const { it } = createRuntimeTestTools(factory, hooks);
  describe("@mekakucity/actors transactions", () => {
  it("rejects non-structured-cloneable state at commit and rolls back", async () => {
    class SerializableActor extends Actor<SerializableActor, {}> {
      @state accessor value: unknown = "safe";
      @action async breakState() { this.value = () => "not cloneable"; }
    }

    await Actor.transaction(async () => {
      const ref = await Actor.spawn(SerializableActor, {});
      await expect(ref.breakState()).rejects.toBeInstanceOf(ActorStateSerializationError);
      expect(ref.value).toBe("safe");
    });
  });

  it("serializes each actor mailbox and keeps request order", async () => {
    const releaseFirst = deferred();
    const firstStarted = deferred();
    const events: string[] = [];
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

    await Actor.transaction(async () => {
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

  it("rolls back an action and isolates caught same-actor sub-transaction failures", async () => {
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

    await Actor.transaction(async () => {
      const ref = await Actor.spawn(NestedActor, {});
      await ref.parent();
      expect(ref.count).toBe(2);
      await expect(ref.fail()).rejects.toThrow("parent");
      expect(ref.count).toBe(2);
    });
  });

  it("commits before a cross-actor await and holds the caller mailbox until the reply", async () => {
    const entered = deferred();
    const release = deferred();
    class GateActor extends Actor<GateActor, {}> {
      @action async pause() { entered.resolve(); await release.promise; }
    }
    class WaitingActor extends Actor<WaitingActor, { gate: ActorRef<GateActor> }> {
      @state accessor value = 0;
      @state accessor gate = this.input.gate;
      @action async waitAcrossActor() { this.value = 1; await this.gate.pause(); this.value = 2; }
      @action async increment() { this.value += 1; }
      @action async spawnChild() { this.value = 4; await Actor.spawn(GateActor, {}); }
    }

    await Actor.transaction(async () => {
      const gate = await Actor.spawn(GateActor, {});
      const ref = await Actor.spawn(WaitingActor, { gate });
      const first = ref.waitAcrossActor();
      await entered.promise;
      expect(ref.value).toBe(1);
      const second = ref.increment();
      await turn();
      expect(ref.value).toBe(1);
      release.resolve();
      await Promise.all([first, second]);
      expect(ref.value).toBe(3);
      await ref.spawnChild();
      expect(ref.value).toBe(4);
    });
  });

  it("re-persists the action start snapshot after a nested cross-actor commit then failure", async () => {
    class CommitPointActor extends Actor<CommitPointActor, {}> {
      @action async ping() { return "pong"; }
    }
    class RollbackAfterCommitActor extends Actor<RollbackAfterCommitActor, { peer: ActorRef<CommitPointActor> }> {
      @state accessor n = 0;
      @state accessor peer = this.input.peer;
      @action async inner() { this.n = 5; await this.peer.ping(); }
      @action async run() { await this.inner(); throw new Error("abort after commit point"); }
    }

    await Actor.transaction(async () => {
      const peer = await Actor.spawn(CommitPointActor, {});
      const ref = await Actor.spawn(RollbackAfterCommitActor, { peer });
      await expect(ref.run()).rejects.toThrow("abort after commit point");
      await Actor.refreshValues(ref);
      expect(ref.n).toBe(0);
    });
  });

  it("named actors reuse one rooted instance and actor operations require a transaction", async () => {
    class NamedCounter extends Actor<NamedCounter, { count: number }> {
      @state accessor count = this.input.count;
    }
    expect(() => Actor.ofNamed(NamedCounter, "singleton")).toThrow(NoActiveTransactionError);
    await expect(Actor.spawn(NamedCounter, { count: 0 })).rejects.toBeInstanceOf(NoActiveTransactionError);

    await Actor.transaction(async () => {
      const named = Actor.ofNamed(NamedCounter, "singleton");
      expect(await named.orNull()).toBeNull();
      const [first, second] = await Promise.all([
        named.orSpawn(() => ({ count: 1 })),
        named.orSpawn(() => ({ count: 2 })),
      ]);
      expect(first.id).toBe(second.id);
      expect(first.count).toBe(1);
    });

    await Actor.transaction(async () => {
      const existing = await Actor.ofNamed(NamedCounter, "singleton").orSpawn(() => ({ count: 3 }));
      expect(existing.count).toBe(1);
    });
  });
  });
};
