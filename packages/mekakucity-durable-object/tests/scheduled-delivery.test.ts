import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Actor, actor, action, ActorRuntimeError, state } from "@mekakucity/actors";
import { expect, test, vi } from "vitest";
import { DurableObjectActorRuntime } from "../src/index.js";

const stubOf = (ref: { id: string }) => env.ACTOR_HOST.get(env.ACTOR_HOST.idFromString(ref.id));

test("a scheduled message survives target Durable Object restart", async () => {
  @actor("scheduled-delivery/RestartedTarget")
  class RestartedTarget extends Actor<RestartedTarget, {}> {
    @state accessor received = 0;
    @action async receive() { this.received += 1; }
  }

  const scope = crypto.randomUUID();
  const runtime = new DurableObjectActorRuntime(env.ACTOR_HOST, { scope });
  const target = await runtime.run(async () => {
    const ref = await Actor.ofNamed(RestartedTarget, "scheduled-restart-target").orSpawn(() => ({}));
    ref.receive.schedule({ after: { ms: 100 } }).runDetached();
    return ref;
  });

  await runInDurableObject(stubOf(target), (_instance, state) => state.abort()).catch(() => {});
  const deadline = Date.now() + 5_000;
  let received = 0;
  while (received !== 1 && Date.now() < deadline) {
    received = await runtime.run(async () => {
      await Actor.refreshValues(target);
      return target.received;
    });
    if (received !== 1) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (received !== 1) throw new Error(`Timed out waiting for scheduled delivery; last received value: ${received}`);
  expect(received).toBe(1);
}, 30_000);

test("a busy inbox dispatch uses five persisted backstop alarms without a tight loop", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  @actor("scheduled-delivery/SlowTarget")
  class SlowTarget extends Actor<SlowTarget, {}> {
    @action async receive() {
      started.resolve();
      await release.promise;
    }
  }

  const scope = crypto.randomUUID();
  const runtime = new DurableObjectActorRuntime(env.ACTOR_HOST, { scope });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const before = Date.now();
    const target = await runtime.run(async () => {
      const ref = await Actor.ofNamed(SlowTarget, "slow-scheduled-target").orSpawn(() => ({}));
      ref.receive.runDetached();
      return ref;
    });
    await started.promise;

    const first = await runInDurableObject(stubOf(target), async (_instance, state) => ({
      alarm: await state.storage.getAlarm(),
      backstop: [...state.storage.kv.list<{ attempt: number; retryAt?: number }>({ prefix: "inbox-backstop:" })][0],
    }));
    const after = Date.now();
    expect(first.backstop?.[1].attempt).toBe(0);
    expect(first.alarm).toBe(first.backstop?.[1].retryAt);
    expect(first.alarm).toBeGreaterThanOrEqual(before + 5_000);
    expect(first.alarm).toBeLessThanOrEqual(after + 5_000);

    const delays = [8_000, 13_000, 21_000, 34_000];
    for (const [index, delay] of delays.entries()) {
      const before = Date.now();
      const wake = await runInDurableObject(stubOf(target), async (instance, state) => {
        const [entry] = [...state.storage.kv.list<{ attempt: number; retryAt?: number }>({
          prefix: "inbox-backstop:",
        })];
        if (!entry) throw new Error("Expected a pending inbox backstop");
        state.storage.kv.put(entry[0], { ...entry[1], retryAt: Date.now() - 1 });
        await instance.alarm();
        return {
          alarm: await state.storage.getAlarm(),
          backstop: state.storage.kv.get<{ attempt: number; retryAt?: number }>(entry[0]),
        };
      });
      const after = Date.now();
      expect(wake.backstop?.attempt).toBe(index + 1);
      expect(wake.alarm).toBe(wake.backstop?.retryAt);
      expect(wake.alarm).toBeGreaterThanOrEqual(before + delay);
      expect(wake.alarm).toBeLessThanOrEqual(after + delay);
    }

    const exhausted = await runInDurableObject(stubOf(target), async (instance, state) => {
      const [entry] = [...state.storage.kv.list<{ attempt: number; retryAt?: number }>({
        prefix: "inbox-backstop:",
      })];
      if (!entry) throw new Error("Expected a pending inbox backstop");
      state.storage.kv.put(entry[0], { ...entry[1], retryAt: Date.now() - 1 });
      await instance.alarm();
      return {
        alarm: await state.storage.getAlarm(),
        backstop: state.storage.kv.get<{ attempt: number; retryAt?: number }>(entry[0]),
        inboxKey: `inbox:${entry[0].slice("inbox-backstop:".length)}`,
      };
    });
    expect(exhausted.backstop).toEqual({ attempt: 5 });
    expect(exhausted.alarm).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain(`ActorHost ${target.id}: inbox row ${exhausted.inboxKey}`);
    expect(error.mock.calls[0]?.[0]).toContain(`message ${exhausted.inboxKey.slice("inbox:".length)} action receive`);
  } finally {
    release.resolve();
    error.mockRestore();
  }
});

test("an in-flight inbox row resumes from its persisted backstop after restart", async () => {
  const started = Promise.withResolvers<void>();
  const never = new Promise<void>(() => {});
  let firstRun = true;
  @actor("scheduled-delivery/RestartedSlowTarget")
  class RestartedSlowTarget extends Actor<RestartedSlowTarget, {}> {
    @state accessor received = 0;
    @action async receive() {
      if (firstRun) {
        firstRun = false;
        started.resolve();
        await never;
      }
      this.received += 1;
    }
  }

  const scope = crypto.randomUUID();
  const runtime = new DurableObjectActorRuntime(env.ACTOR_HOST, { scope });
  const target = await runtime.run(async () => {
    const ref = await Actor.ofNamed(RestartedSlowTarget, "restarted-in-flight-target").orSpawn(() => ({}));
    ref.receive.runDetached();
    return ref;
  });
  await started.promise;
  await runInDurableObject(stubOf(target), (_instance, state) => state.abort()).catch(() => {});

  await runInDurableObject(stubOf(target), async (instance, state) => {
    const [entry] = [...state.storage.kv.list<{ attempt: number; retryAt?: number }>({
      prefix: "inbox-backstop:",
    })];
    if (!entry) throw new Error("Expected a persisted inbox backstop");
    state.storage.kv.put(entry[0], { ...entry[1], retryAt: Date.now() - 1 });
    await instance.alarm();
  });

  await runtime.run(async () => {
    await Actor.refreshValues(target);
    expect(target.received).toBe(1);
  });
});

test("rejects a legacy-shaped inbox row with ActorRuntimeError", async () => {
  @actor("scheduled-delivery/CurrentTarget")
  class CurrentTarget extends Actor<CurrentTarget, {}> {
    @action async receive() {}
  }

  const scope = crypto.randomUUID();
  const runtime = new DurableObjectActorRuntime(env.ACTOR_HOST, { scope });
  const target = await runtime.run(() =>
    Actor.ofNamed(CurrentTarget, "legacy-inbox-target").orSpawn(() => ({})));
  const legacyMessage = {
    id: "legacy_inbox_message",
    target: { type: target.type, id: target.id },
    action: "receive",
    args: [],
    heldIds: [],
  };
  await runInDurableObject(stubOf(target), (_instance, state) => {
    state.storage.kv.put("inbox:legacy_inbox_message", legacyMessage);
  });
  await runInDurableObject(stubOf(target), (_instance, state) => state.abort()).catch(() => {});

  const alarm = runInDurableObject(stubOf(target), (instance) => instance.alarm());
  await expect(alarm).rejects.toBeInstanceOf(ActorRuntimeError);
  await expect(alarm).rejects.toThrow("Stored inbox message is incompatible");
});
