import {
  Actor,
  action,
  actor,
  state,
  type ActorCommitInfo,
  type ActorRef,
  type ActorReadInfo,
} from "@mekakucity/actors";
import { ActorRuntime } from "@mekakucity/actors/runtime";
import { describe, expect } from "vitest";
import { createRuntimeTestTools, type ActorRuntimeConformanceHooks } from "./runtime.js";

@actor("verify/observation/Counter")
class ObservationCounter extends Actor<ObservationCounter, {}> {
  @state accessor count = 0;
  @state accessor flag = false;
  commitEvents: ActorCommitInfo[] = [];
  stopCommitFeed: (() => void) | undefined;

  @action async noop(): Promise<void> {}

  @action async reads(target: ActorRef<ObservationCounter>): Promise<void> {
    await target.noop();
  }

  @action async subscribeToCommits(): Promise<void> {
    this.stopCommitFeed?.();
    this.commitEvents = [];
    const runtime = ActorRuntime.current("subscribe to actor commits");
    const self = runtime.selfDescriptorOf(this);
    this.stopCommitFeed = runtime.onCommit((info) => {
      if (info.actor.type === self.type && info.actor.id === self.id) this.commitEvents.push(info);
    });
  }

  @action async increment(): Promise<void> {
    this.count += 1;
  }

  @action async subscribeToFailingCommits(): Promise<void> {
    ActorRuntime.current("subscribe to failing actor commits").onCommit(async () => {
      await Promise.resolve();
      throw new Error("commit listener failed");
    });
  }

  @action async nestedWriteCall(target: ActorRef<ObservationCounter>): Promise<void> {
    this.flag = true;
    await target.noop();
  }

  @action async nestedWriteCallFail(target: ActorRef<ObservationCounter>): Promise<void> {
    await this.nestedWriteCall(target);
    throw new Error("nested-write-call-fail");
  }

  @action async nestedWriteCallReset(target: ActorRef<ObservationCounter>): Promise<void> {
    await this.nestedWriteCall(target);
    this.flag = false;
  }

  @action async writeCallRevert(target: ActorRef<ObservationCounter>): Promise<void> {
    this.flag = true;
    await target.noop();
    this.flag = false;
  }

  @action async writeCallFail(target: ActorRef<ObservationCounter>): Promise<void> {
    this.flag = true;
    await target.noop();
    throw new Error("write-call-fail");
  }

  @action async readCommitEvents(): Promise<ActorCommitInfo[]> {
    return this.commitEvents;
  }
}

export const observationSuite = (
  factory: () => ActorRuntime,
  hooks?: ActorRuntimeConformanceHooks,
): void => {
  const { it } = createRuntimeTestTools(factory, hooks);
  describe("@mekakucity/actors observation", () => {
    it("reports value, action, and refresh reads with their snapshot versions", async (runtime) => {
      const reads: ActorReadInfo[] = [];
      const ref = await Actor.observeReads(
        () => runtime.run(async () => {
          const ref = await Actor.spawn(ObservationCounter, {});
          expect(ref.count).toBe(0);
          await ref.noop();
          await Actor.refreshValues(ref);
          return ref;
        }),
        (read) => reads.push(read),
      );

      const actor = { type: ref.type, id: ref.id };
      expect(reads).toEqual([
        { actor, version: 0 },
        { actor, version: 1 },
        { actor, version: 1 },
      ]);
    });

    it("reports only the directly called actor across a cross-actor action", async (runtime) => {
      const reads: ActorReadInfo[] = [];
      await runtime.run(async () => {
        const caller = await Actor.spawn(ObservationCounter, {});
        const target = await Actor.spawn(ObservationCounter, {});
        await Actor.observeReads(
          () => caller.reads(target),
          (read) => reads.push(read),
        );
        expect(reads).toEqual([{
          actor: { type: caller.type, id: caller.id },
          version: 1,
        }]);
      });
    });

    it("emits ctx-free final, segment, and compensating rollback commits", async (runtime) => {
      await runtime.run(async () => {
        const caller = await Actor.spawn(ObservationCounter, {});
        const target = await Actor.spawn(ObservationCounter, {});
        await caller.subscribeToCommits();

        await caller.increment();
        const afterIncrement = await caller.readCommitEvents();
        expect(afterIncrement).toContainEqual({
          actor: { type: caller.type, id: caller.id },
          version: 2,
          changed: ["count"],
        });

        await caller.writeCallRevert(target);
        const afterRevert = await caller.readCommitEvents();
        expect(afterRevert).toContainEqual({
          actor: { type: caller.type, id: caller.id },
          version: 4,
          changed: ["flag"],
        });
        expect(afterRevert).toContainEqual({
          actor: { type: caller.type, id: caller.id },
          version: 5,
          changed: ["flag"],
        });

        await expect(caller.writeCallFail(target)).rejects.toThrow("write-call-fail");
        const afterRollback = await caller.readCommitEvents();
        expect(afterRollback).toContainEqual({
          actor: { type: caller.type, id: caller.id },
          version: 7,
          changed: ["flag"],
        });
        expect(afterRollback).toContainEqual({
          actor: { type: caller.type, id: caller.id },
          version: 8,
          changed: ["flag"],
        });
      });
    });

    it("shares the segment baseline with nested local actions", async (runtime) => {
      await runtime.run(async () => {
        const failing = await Actor.spawn(ObservationCounter, {});
        const failingTarget = await Actor.spawn(ObservationCounter, {});
        await failing.subscribeToCommits();

        await expect(failing.nestedWriteCallFail(failingTarget)).rejects.toThrow("nested-write-call-fail");
        const failedEvents = await failing.readCommitEvents();
        expect(failedEvents.some((event) => event.version === 2 && event.changed.includes("flag"))).toBe(true);
        expect(failedEvents.some((event) => event.version === 3 && event.changed.includes("flag"))).toBe(true);

        const resetting = await Actor.spawn(ObservationCounter, {});
        const resettingTarget = await Actor.spawn(ObservationCounter, {});
        await resetting.subscribeToCommits();
        await resetting.nestedWriteCallReset(resettingTarget);
        const resetEvents = await resetting.readCommitEvents();
        expect(resetEvents.some((event) => event.version === 2 && event.changed.includes("flag"))).toBe(true);
        expect(resetEvents.some((event) => event.version === 3 && event.changed.includes("flag"))).toBe(true);
      });
    });

    it("does not fail an action or leak an unhandled rejection when an async commit listener rejects", async (runtime) => {
      await runtime.run(async () => {
        const ref = await Actor.spawn(ObservationCounter, {});
        await expect(ref.subscribeToFailingCommits()).resolves.toBeUndefined();
        await expect(ref.increment()).resolves.toBeUndefined();
      });
    });
  });
};
