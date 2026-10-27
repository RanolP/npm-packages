import {
  Actor,
  action,
  actor,
  state,
  type ActorCommitInfo,
  type ActorContextProvider,
  type ActorDescriptor,
  type ActorRef,
} from "@mekakucity/actors";
import type { ActorRuntime } from "@mekakucity/actors/runtime";
import { describe, expect, it } from "vitest";
import type { ActorRuntimeConformanceHooks } from "./runtime.js";

declare module "@mekakucity/actors" {
  interface ActorContext {
    readonly requestId: string | undefined;
    readonly origin: ActorDescriptor | undefined;
    registerConformanceHooks(): void;
    reportCommitInfo(): void;
  }
}

export interface ContextCarried {
  readonly requestId?: string;
}

const buildContext: ActorContextProvider<ContextCarried>["build"] = (carried, hooks, _self, origin) => ({
  requestId: carried?.requestId,
  origin,
  registerConformanceHooks() {
    hooks.onRollback(() => { throw new Error("rollback hook ran"); });
    hooks.afterCommit(() => { throw new Error("afterCommit hook ran"); });
  },
  reportCommitInfo() {
    hooks.afterCommit.bestEffort((info) => {
      throw new Error(`commit-info:${JSON.stringify(info)}`);
    });
  },
});

@actor("verify/context/Probe")
class ContextProbe extends Actor<ContextProbe, {}> {
  @state accessor detachedRequestId: string | null = "not-run";
  @state accessor observedOrigin: ActorDescriptor | null | "not-run" = "not-run";

  @action async read(): Promise<string | undefined> {
    return this.ctx.requestId;
  }

  @action async readsOneCachedContext(): Promise<boolean> {
    return this.ctx === this.ctx;
  }

  @action async readOrigin(): Promise<ActorDescriptor | undefined> {
    return this.ctx.origin;
  }

  @action async captureOrigin(): Promise<void> {
    this.observedOrigin = this.ctx.origin ?? null;
  }

  @action async captureDetached(): Promise<void> {
    this.detachedRequestId = this.ctx.requestId ?? null;
  }

  @action async queueDetached(target: ActorRef<ContextProbe>): Promise<void> {
    target.captureDetached.runDetached();
  }
}

@actor("verify/context/Forwarder")
class ContextForwarder extends Actor<ContextForwarder, { target: ActorRef<ContextProbe> }> {
  @state accessor target = this.input.target;

  @action async readNested(): Promise<string | undefined> {
    return this.target.read();
  }

  @action async forwardOrigin(): Promise<void> {
    await this.target.captureOrigin();
  }

  @action async queueDetachedForward(): Promise<void> {
    this.asRef.forwardOrigin.runDetached();
  }
}

@actor("verify/context/Hooks")
class ContextHooks extends Actor<ContextHooks, {}> {
  @state accessor committed = 0;

  @action async succeed(): Promise<void> {
    this.committed = 1;
    this.ctx.registerConformanceHooks();
  }

  @action async fail(): Promise<void> {
    this.committed = 2;
    this.ctx.registerConformanceHooks();
    throw new Error("action failed");
  }

  @action async reportNoop(): Promise<void> {
    this.ctx.reportCommitInfo();
  }

  @action async reportWrite(): Promise<void> {
    this.committed = 3;
    this.ctx.reportCommitInfo();
  }

  @action async reportWriteCallRevert(target: ActorRef<ContextProbe>): Promise<void> {
    const previous = this.committed;
    this.committed = 5;
    await target.read();
    this.committed = previous;
    this.ctx.reportCommitInfo();
  }

  @action async reportRollback(): Promise<void> {
    this.committed = 4;
    this.ctx.reportCommitInfo();
    throw new Error("reported action failed");
  }
}

const commitInfoFrom = (error: Error): ActorCommitInfo => {
  const marker = "commit-info:";
  const start = error.message.indexOf(marker);
  if (start < 0) throw error;
  const parsed: unknown = JSON.parse(error.message.slice(start + marker.length));
  if (typeof parsed !== "object" || parsed === null
    || !("actor" in parsed) || typeof parsed.actor !== "object" || parsed.actor === null
    || !("type" in parsed.actor) || typeof parsed.actor.type !== "string"
    || !("id" in parsed.actor) || typeof parsed.actor.id !== "string"
    || !("version" in parsed) || typeof parsed.version !== "number"
    || !("changed" in parsed) || !Array.isArray(parsed.changed)
    || !parsed.changed.every((key) => typeof key === "string")) {
    throw new TypeError("Expected a serialized ActorCommitInfo");
  }
  return {
    actor: { type: parsed.actor.type, id: parsed.actor.id },
    version: parsed.version,
    changed: [...parsed.changed],
  };
};

const errorFrom = (error: unknown): Error => {
  if (error instanceof Error) return error;
  throw new TypeError(`Expected an Error, received ${String(error)}`);
};

export const actorContextSuite = (
  _factory: () => ActorRuntime,
  hooks?: ActorRuntimeConformanceHooks,
): void => {
  describe("@mekakucity/actors context", () => {
    const configuredCreateWithContext = hooks?.createWithContext;
    const contextIt = configuredCreateWithContext ? it : it.skip;
    const createWithContext = configuredCreateWithContext ?? (() => {
      throw new Error("This runtime does not provide context conformance support");
    });

    contextIt("isolates sequential calls from different callers", async () => {
      let current: ContextCarried | undefined;
      const provider: ActorContextProvider<ContextCarried> = {
        carry: () => current,
        build: buildContext,
      };
      const runtime = createWithContext(provider);
      await runtime.run(async () => {
        const ref = await Actor.spawn(ContextProbe, {});
        current = { requestId: "first" };
        await expect(ref.read()).resolves.toBe("first");
        current = { requestId: "second" };
        await expect(ref.read()).resolves.toBe("second");
        await expect(ref.readsOneCachedContext()).resolves.toBe(true);
      });
    });

    contextIt("propagates the outer carried value through a nested actor call", async () => {
      let carries = 0;
      const provider: ActorContextProvider<ContextCarried> = {
        carry: () => {
          carries += 1;
          return { requestId: "outer" };
        },
        build: buildContext,
      };
      const runtime = createWithContext(provider);
      await runtime.run(async () => {
        const target = await Actor.spawn(ContextProbe, {});
        const forwarder = await Actor.spawn(ContextForwarder, { target });
        await expect(forwarder.readNested()).resolves.toBe("outer");
      });
      expect(carries).toBe(1);
    });

    contextIt("runs rollback hooks only after rollback and commit hooks only after commit", async () => {
      const provider: ActorContextProvider<ContextCarried> = {
        carry: () => ({ requestId: "hooks" }),
        build: buildContext,
      };
      const runtime = createWithContext(provider);
      await runtime.run(async () => {
        const ref = await Actor.spawn(ContextHooks, {});
        const commitError = await ref.succeed().then(
          () => { throw new Error("Expected afterCommit to reject"); },
          errorFrom,
        );
        expect(commitError.message).toContain("afterCommit hook ran");
        expect(commitError.message).not.toContain("rollback hook ran");
        await Actor.refreshValues(ref);
        expect(ref.committed).toBe(1);

        const rollbackError = await ref.fail().then(
          () => { throw new Error("Expected the action to reject"); },
          errorFrom,
        );
        expect(rollbackError.message).toMatch(/action failed.*rollback hook ran/);
        expect(rollbackError.message).not.toContain("afterCommit hook ran");
        await Actor.refreshValues(ref);
        expect(ref.committed).toBe(1);
      });
    });

    contextIt("reports committed versions and net changed state fields", async () => {
      const provider: ActorContextProvider<ContextCarried> = {
        carry: () => ({ requestId: "commit-info" }),
        build: buildContext,
      };
      const runtime = createWithContext(provider);
      await runtime.run(async () => {
        const ref = await Actor.spawn(ContextHooks, {});
        const actor = { type: ref.type, id: ref.id };

        const noopError = await ref.reportNoop().then(
          () => { throw new Error("Expected afterCommit to reject"); },
          errorFrom,
        );
        expect(commitInfoFrom(noopError)).toEqual({ actor, version: 1, changed: [] });

        const writeError = await ref.reportWrite().then(
          () => { throw new Error("Expected afterCommit to reject"); },
          errorFrom,
        );
        expect(commitInfoFrom(writeError)).toEqual({ actor, version: 2, changed: ["committed"] });

        const target = await Actor.spawn(ContextProbe, {});
        const revertedError = await ref.reportWriteCallRevert(target).then(
          () => { throw new Error("Expected afterCommit to reject"); },
          errorFrom,
        );
        expect(commitInfoFrom(revertedError)).toEqual({ actor, version: 4, changed: ["committed"] });

        const rollbackError = await ref.reportRollback().then(
          () => { throw new Error("Expected the action to reject"); },
          errorFrom,
        );
        expect(rollbackError.message).toContain("reported action failed");
        expect(rollbackError.message).not.toContain("commit-info:");
      });
    });

    contextIt("builds a detached action context with undefined carried data", async () => {
      const provider: ActorContextProvider<ContextCarried> = {
        carry: () => ({ requestId: "caller" }),
        build: buildContext,
      };
      const runtime = createWithContext(provider);
      const target = await runtime.run(async () => {
        const ref = await Actor.ofNamed(ContextProbe, "detached-target").orSpawn(() => ({}));
        await ref.queueDetached(ref);
        return ref;
      });

      let lastSeen: string | null = "not-run";
      for (let attempt = 0; attempt < 100; attempt += 1) {
        lastSeen = await runtime.run(async () => {
          await Actor.refreshValues(target);
          return target.detachedRequestId;
        });
        if (lastSeen !== "not-run") {
          expect(lastSeen).toBeNull();
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      expect(lastSeen).toBeNull();
    });

    contextIt("propagates the detached origin while caller-started chains have no origin", async () => {
      const provider: ActorContextProvider<ContextCarried> = {
        carry: () => ({ requestId: "caller" }),
        build: buildContext,
      };
      const runtime = createWithContext(provider);
      const { target, forwarder } = await runtime.run(async () => {
        const target = await Actor.ofNamed(ContextProbe, "origin-target").orSpawn(() => ({}));
        const forwarder = await Actor.ofNamed(ContextForwarder, "origin-forwarder").orSpawn(() => ({ target }));
        await expect(target.readOrigin()).resolves.toBeUndefined();
        await forwarder.queueDetachedForward();
        return { target, forwarder };
      });

      let lastSeen: ActorDescriptor | null | "not-run" = "not-run";
      for (let attempt = 0; attempt < 100; attempt += 1) {
        lastSeen = await runtime.run(async () => {
          await Actor.refreshValues(target);
          return target.observedOrigin;
        });
        if (lastSeen !== "not-run") {
          expect(lastSeen).toEqual({ type: forwarder.type, id: forwarder.id });
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      expect(lastSeen).toEqual({ type: forwarder.type, id: forwarder.id });
    });
  });
};
