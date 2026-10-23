import { Actor, ActorCompensationError, ActorKilledError, ActorReentrancyError, defer, action, state } from "../index.js";
import type { ActorRef } from "../index.js";
import type { ActorRuntime } from "../runtime/actor-runtime.js";
import { describe, expect } from "vitest";
import { createRuntimeTestTools, type ActorRuntimeConformanceHooks } from "./runtime.js";
import { completesBeforeTimeout, deferred, turn } from "./helpers.js";

export const compensationSuite = (factory: () => ActorRuntime, hooks?: ActorRuntimeConformanceHooks): void => {
  const { it } = createRuntimeTestTools(factory, hooks);
  describe("@mekakucity/actors compensation", () => {
  it("runs the orchestrator's A and B compensations in reverse order when C fails", async () => {
    const undoOrder: string[] = [];
    class AActor extends Actor<AActor, {}> {
      @action async run() { defer(this.undo); }
      @action async undo() { undoOrder.push("A"); }
    }
    class BActor extends Actor<BActor, {}> {
      @action async run() { defer(this.undo); }
      @action async undo() { undoOrder.push("B"); }
    }
    class CActor extends Actor<CActor, {}> {
      @action async run() { throw new Error("C failed"); }
    }
    class DActor extends Actor<DActor, { a: ActorRef<AActor>; b: ActorRef<BActor>; c: ActorRef<CActor> }> {
      @state accessor a = this.input.a;
      @state accessor b = this.input.b;
      @state accessor c = this.input.c;
      @action async orchestrate() { await this.a.run(); await this.b.run(); await this.c.run(); }
    }

    await Actor.transaction(async () => {
      const a = await Actor.spawn(AActor, {});
      const b = await Actor.spawn(BActor, {});
      const c = await Actor.spawn(CActor, {});
      const d = await Actor.spawn(DActor, { a, b, c });
      await expect(d.orchestrate()).rejects.toThrow("C failed");
      expect(undoOrder).toEqual(["B", "A"]);
    });
  });

  it("runs a direct self-targeting compensation without reacquiring the actor mailbox", async () => {
    const undoOrder: string[] = [];
    class SelfCompensatingActor extends Actor<SelfCompensatingActor, {}> {
      @state accessor undoCount = 0;
      @action async run() { defer(this.undo); throw new Error("abort"); }
      @action async undo() { this.undoCount += 1; undoOrder.push("self"); }
    }

    await Actor.transaction(async () => {
      const ref = await Actor.spawn(SelfCompensatingActor, {});
      await expect(completesBeforeTimeout(ref.run())).rejects.toThrow("abort");
      expect(undoOrder).toEqual(["self"]);
      await Actor.refreshValues(ref);
      expect(ref.undoCount).toBe(0);
    });
  });

  it("runs a self-targeting compensation registered by a nested action without deadlocking", async () => {
    const undoOrder: string[] = [];
    class NestedSelfCompensatingActor extends Actor<NestedSelfCompensatingActor, {}> {
      @action async step() { defer(this.undo); }
      @action async run() { await this.step(); throw new Error("abort"); }
      @action async undo() { undoOrder.push("nested-self"); }
    }

    await Actor.transaction(async () => {
      const ref = await Actor.spawn(NestedSelfCompensatingActor, {});
      await expect(completesBeforeTimeout(ref.run())).rejects.toThrow("abort");
      expect(undoOrder).toEqual(["nested-self"]);
    });
  });

  it("preserves reverse order when one compensation targets its waiting actor", async () => {
    const undoOrder: string[] = [];
    class RemoteUndoActor extends Actor<RemoteUndoActor, {}> {
      @action async run() { defer(this.undo); }
      @action async undo() { undoOrder.push("remote"); }
    }
    class MixedUndoActor extends Actor<MixedUndoActor, { remote: ActorRef<RemoteUndoActor> }> {
      @state accessor remote = this.input.remote;
      @action async run() {
        defer(this.undo);
        await this.remote.run();
        throw new Error("abort");
      }
      @action async undo() { undoOrder.push("self"); }
    }

    await Actor.transaction(async () => {
      const remote = await Actor.spawn(RemoteUndoActor, {});
      const ref = await Actor.spawn(MixedUndoActor, { remote });
      await expect(completesBeforeTimeout(ref.run())).rejects.toThrow("abort");
      expect(undoOrder).toEqual(["remote", "self"]);
    });
  });

  it("runs self-compensation before restoring the failed action's start state", async () => {
    class SelfUndoStateActor extends Actor<SelfUndoStateActor, {}> {
      @state accessor n = 0;
      @action async step() { this.n += 1; defer(this.dec); }
      @action async run() { await this.step(); throw new Error("abort after step"); }
      @action async dec() { this.n -= 1; }
    }

    await Actor.transaction(async () => {
      const ref = await Actor.spawn(SelfUndoStateActor, {});
      await expect(ref.run()).rejects.toThrow("abort after step");
      await Actor.refreshValues(ref);
      expect(ref.n).toBe(0);
    });
  });

  it("delivers detached messages from compensation and releases their receiver holder", async () => {
    const processed = deferred();
    let hits = 0;
    class Receiver extends Actor<Receiver, {}> {
      @action async hit() { hits += 1; processed.resolve(); }
    }
    class Sender extends Actor<Sender, { receiver: ActorRef<Receiver> }> {
      @state accessor receiver: ActorRef<Receiver> | null = this.input.receiver;
      @action async run() { defer(this.undo); throw new Error("rollback sender"); }
      @action async undo() { this.receiver!.hit.runDetached(); }
      @action async drop() { this.receiver = null; }
    }

    let receiver!: ActorRef<Receiver>;
    let sender!: ActorRef<Sender>;
    await Actor.transaction(async () => {
      receiver = await Actor.spawn(Receiver, {});
      sender = await Actor.ofNamed(Sender, "compensation-outbox-sender").orSpawn(() => ({ receiver }));
      await expect(sender.run()).rejects.toThrow("rollback sender");
    });

    await processed.promise;
    await turn();
    expect(hits).toBe(1);
    await Actor.transaction(() => sender.drop());
    await expect(Actor.transaction(() => receiver.hit())).rejects.toBeInstanceOf(ActorKilledError);
  });

  it("compensation mode does not leak into concurrent sibling branches", async () => {
    const compensationStarted = deferred();
    const releaseCompensation = deferred();
    let hits = 0;
    let senderUndos = 0;
    class Receiver extends Actor<Receiver, {}> {
      @action async hit() { hits += 1; }
    }
    class Slow extends Actor<Slow, {}> {
      @action async run() { defer(this.undo); throw new Error("slow failed"); }
      @action async undo() { compensationStarted.resolve(); await releaseCompensation.promise; }
    }
    class Sender extends Actor<Sender, { receiver: ActorRef<Receiver> }> {
      @state accessor receiver = this.input.receiver;
      @action async send() { this.receiver.hit.runDetached(); defer(this.undo); }
      @action async undo() { senderUndos += 1; }
    }

    let slowOutcome!: Promise<unknown>;
    await expect(Actor.transaction(async () => {
      const slow = await Actor.ofNamed(Slow, "compensation-sibling-probe").orSpawn(() => ({}));
      const receiver = await Actor.spawn(Receiver, {});
      const sender = await Actor.spawn(Sender, { receiver });
      slowOutcome = slow.run().then(() => null, (error: unknown) => error);
      await compensationStarted.promise;
      await sender.send();
      throw new Error("outer rollback");
    })).rejects.toThrow("outer rollback");

    expect(senderUndos).toBe(1);
    expect(hits).toBe(0);
    releaseCompensation.resolve();
    expect(await slowOutcome).toMatchObject({ message: "slow failed" });
  });

  it("compensation calling back into the failing orchestrator fails fast instead of hanging", async () => {
    let undoRuns = 0;
    let notifyRuns = 0;
    const originalFailure = new Error("original orchestration failure");
    class Compensator extends Actor<Compensator, {}> {
      @action async run(orchestrator: ActorRef<Orchestrator>) { defer(this.undo, orchestrator); }
      @action async undo(orchestrator: ActorRef<Orchestrator>) {
        undoRuns += 1;
        await orchestrator.notify();
      }
    }
    class Orchestrator extends Actor<Orchestrator, { compensator: ActorRef<Compensator> }> {
      @state accessor compensator = this.input.compensator;
      @action async orchestrate(self: ActorRef<Orchestrator>) {
        await this.compensator.run(self);
        throw originalFailure;
      }
      @action async notify() { notifyRuns += 1; }
    }

    const failure = await completesBeforeTimeout(Actor.transaction(async () => {
      const compensator = await Actor.spawn(Compensator, {});
      const orchestrator = await Actor.spawn(Orchestrator, { compensator });
      await orchestrator.orchestrate(orchestrator);
    })).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ActorCompensationError);
    if (!(failure instanceof ActorCompensationError)) throw new Error("Expected ActorCompensationError");
    expect(failure.cause).toBe(originalFailure);
    expect(failure.errors).toHaveLength(1);
    expect(failure.errors[0]).toBeInstanceOf(ActorReentrancyError);
    expect(undoRuns).toBe(1);
    expect(notifyRuns).toBe(0);
  });

  it("collects root compensation failures in execution order and retains the original cause", async () => {
    const calls: string[] = [];
    const originalFailure = new Error("transaction failure");
    class Compensator extends Actor<Compensator, {}> {
      @action async run() { defer(this.undo, "first"); defer(this.undo, "second"); }
      @action async undo(label: string) { calls.push(label); throw new Error(`undo ${label} failed`); }
    }

    const failure = await Actor.transaction(async () => {
      const ref = await Actor.spawn(Compensator, {});
      await ref.run();
      throw originalFailure;
    }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ActorCompensationError);
    if (!(failure instanceof ActorCompensationError)) throw new Error("Expected ActorCompensationError");
    expect(failure.cause).toBe(originalFailure);
    expect(calls).toEqual(["second", "first"]);
    expect(failure.errors.map((error) => (error as Error).message)).toEqual(["undo second failed", "undo first failed"]);
  });

  it("flattens nested compensation failures while preserving the original action cause", async () => {
    const originalFailure = new Error("nested action failed");
    const innerFailure = new Error("inner undo failed");
    const outerFailure = new Error("outer undo failed");
    class NestedCompensationActor extends Actor<NestedCompensationActor, {}> {
      @action async run() {
        defer(this.undoOuter);
        await this.inner();
      }
      @action async inner() {
        defer(this.undoInner);
        throw originalFailure;
      }
      @action async undoInner() { throw innerFailure; }
      @action async undoOuter() { throw outerFailure; }
    }

    await Actor.transaction(async () => {
      const ref = await Actor.spawn(NestedCompensationActor, {});
      const failure = await ref.run().then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(ActorCompensationError);
      if (!(failure instanceof ActorCompensationError)) throw new Error("Expected ActorCompensationError");
      expect(failure.cause).toBe(originalFailure);
      expect(failure.errors).toEqual([innerFailure, outerFailure]);
    });
  });
  });
};
