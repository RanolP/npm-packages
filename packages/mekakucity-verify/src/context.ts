import {
  Actor,
  action,
  actor,
  state,
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
}

export const actorContextSuite = (
  _factory: () => ActorRuntime,
  hooks?: ActorRuntimeConformanceHooks,
): void => {
  describe("@mekakucity/actors context", () => {
    const contextIt = hooks?.createWithContext ? it : it.skip;

    contextIt("isolates sequential calls from different callers", async () => {
      let current: ContextCarried | undefined;
      const provider: ActorContextProvider<ContextCarried> = {
        carry: () => current,
        build: buildContext,
      };
      const runtime = hooks!.createWithContext!(provider);
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
      const runtime = hooks!.createWithContext!(provider);
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
      const runtime = hooks!.createWithContext!(provider);
      await runtime.run(async () => {
        const ref = await Actor.spawn(ContextHooks, {});
        const commitError = await ref.succeed().then(
          () => { throw new Error("Expected afterCommit to reject"); },
          (error: unknown) => error as Error,
        );
        expect(commitError.message).toContain("afterCommit hook ran");
        expect(commitError.message).not.toContain("rollback hook ran");
        await Actor.refreshValues(ref);
        expect(ref.committed).toBe(1);

        const rollbackError = await ref.fail().then(
          () => { throw new Error("Expected the action to reject"); },
          (error: unknown) => error as Error,
        );
        expect(rollbackError.message).toMatch(/action failed.*rollback hook ran/);
        expect(rollbackError.message).not.toContain("afterCommit hook ran");
        await Actor.refreshValues(ref);
        expect(ref.committed).toBe(1);
      });
    });

    contextIt("builds a detached action context with undefined carried data", async () => {
      const provider: ActorContextProvider<ContextCarried> = {
        carry: () => ({ requestId: "caller" }),
        build: buildContext,
      };
      const runtime = hooks!.createWithContext!(provider);
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
      const runtime = hooks!.createWithContext!(provider);
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
