import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Actor, actor, ActorKilledError, action, state, type ActorRef } from "@mekakucity/actors";
import { actorHolder, messageHolder, NAMED_ROOT, type HolderOp } from "@mekakucity/actors/runtime";
import { describe, expect, test, vi } from "vitest";
import { DurableObjectActorRuntime } from "../src/index.js";
import { Outbox } from "../src/outbox.js";

@actor("host-holders/Probe")
class Probe extends Actor<Probe, {}> {
  @action async ping(): Promise<string> { return "alive"; }
}

@actor("host-holders/CreateFailure")
class CreateFailure extends Actor<CreateFailure, { target: ActorRef<Probe> }> {
  @state accessor target = this.input.target;
}

const newRuntime = () => new DurableObjectActorRuntime(env.ACTOR_HOST, { scope: crypto.randomUUID() });
const stubOf = (ref: { id: string }) => env.ACTOR_HOST.get(env.ACTOR_HOST.idFromString(ref.id));
const storedKeys = (ref: { id: string }) =>
  runInDurableObject(stubOf(ref), (_instance, state) => [...state.storage.kv.list()].map(([key]) => key));
const storedHolders = (ref: { id: string }) =>
  runInDurableObject(stubOf(ref), (_instance, state) => state.storage.kv.get<string[]>("holders"));
const outboxSize = (ref: { id: string }) =>
  runInDurableObject(stubOf(ref), (_instance, state) => [...state.storage.kv.list({ prefix: "outbox:" })].length);
const inboxSize = (ref: { id: string }) =>
  runInDurableObject(stubOf(ref), (_instance, state) => [...state.storage.kv.list({ prefix: "inbox:" })].length);
const collectedRetryState = (ref: { id: string }) =>
  runInDurableObject(stubOf(ref), async (_instance, state) => ({
    alarm: await state.storage.getAlarm(),
    attempt: state.storage.kv.get<number>("collected-retry-attempt"),
    retryAt: state.storage.kv.get<number>("collected-retry-at"),
  }));
const seenKeys = (ref: { id: string }) =>
  runInDurableObject(stubOf(ref), (_instance, state) => [...state.storage.kv.list({ prefix: "seen:" })].map(([key]) => key));
const until = async (done: () => Promise<boolean>) => {
  for (let i = 0; i < 200 && !(await done()); i += 1) await new Promise((r) => setTimeout(r, 5));
};
const op = (kind: HolderOp["kind"], ref: { id: string }, holder: string): HolderOp => ({ kind, target: ref.id, holder });
const FAILED_RELEASE_TARGET = "not-a-durable-object-id";

const collectWithFailingRelease = async (runtime: DurableObjectActorRuntime, name: string) => {
  const holder = actorHolder(`collected-retry-${name}`);
  const ref = await runtime.run(async () => {
    const ref = await Actor.spawn(Probe, {});
    await stubOf(ref).applyHolderOps([op("hold", ref, holder)]);
    return ref;
  });
  await runInDurableObject(stubOf(ref), (_instance, state) => {
    state.storage.kv.put("heldRefs", [FAILED_RELEASE_TARGET]);
  });
  await runInDurableObject(stubOf(ref), (_instance, state) => state.abort()).catch(() => {});
  await stubOf(ref).applyHolderOps([op("release", ref, holder)]);
  return ref;
};

describe("ActorHost holder protocol", () => {
  // Regression: at-least-once outbox delivery re-sends ops; a non-idempotent apply would double-count a holder.
  test("same hold op delivered twice leaves one holder", async () => {
    const runtime = newRuntime();
    const ref = await runtime.run(() => Actor.ofNamed(Probe, "twice").orSpawn(() => ({})));
    const hold = op("hold", ref, messageHolder("m1"));

    await stubOf(ref).applyHolderOps([hold]);
    await stubOf(ref).applyHolderOps([hold]);
    expect(await storedHolders(ref)).toEqual([NAMED_ROOT, messageHolder("m1")]);

    await stubOf(ref).applyHolderOps([op("release", ref, messageHolder("m1"))]);
    expect(await storedHolders(ref)).toEqual([NAMED_ROOT]);
  });

  // Regression: a collected actor must leave nothing behind in its Durable Object storage.
  test("releasing the last holder makes storage list() empty afterwards", async () => {
    const runtime = newRuntime();
    let keysWhileHeld: string[] = [];
    const ref = await runtime.run(async () => {
      const probe = await Actor.spawn(Probe, {});
      keysWhileHeld = await storedKeys(probe);
      return probe;
    });

    expect(keysWhileHeld).toEqual(expect.arrayContaining(["meta", "snapshot", "version", "holders", "heldRefs"]));
    expect(await storedKeys(ref)).toEqual([]);
    await expect(runtime.run(() => ref.ping())).rejects.toBeInstanceOf(ActorKilledError);
  });

  // Regression: a ref handed off in a detached message is released by the sender before the receiver holds it;
  // the message: holder is what keeps it alive in between, so that release must not collect it.
  test("release arriving before the receiver's hold while a message: temp holder exists does not delete storage", async () => {
    const runtime = newRuntime();
    const sender = actorHolder("sender");
    const receiver = actorHolder("receiver");
    let child!: ActorRef<Probe>;
    await runtime.run(async () => {
      child = await Actor.spawn(Probe, {});
      await stubOf(child).applyHolderOps([op("hold", child, sender)]);
    });
    expect(await storedHolders(child)).toEqual([sender]);

    await stubOf(child).applyHolderOps([op("hold", child, messageHolder("handoff"))]);
    await stubOf(child).applyHolderOps([op("release", child, sender)]);
    expect(await storedKeys(child)).toContain("meta");
    expect(await storedHolders(child)).toEqual([messageHolder("handoff")]);

    await stubOf(child).applyHolderOps([op("hold", child, receiver), op("release", child, messageHolder("handoff"))]);
    expect(await storedHolders(child)).toEqual([receiver]);
    expect(await runtime.run(() => child.ping())).toBe("alive");
  });

  // Regression (review F2): an invoke that committed while its host's outbox was mid-pass replied before its
  // hold(tx) reached the spawned child; the caller's release arrived first, the late hold re-added a holder
  // nobody releases, and the child lived forever.
  test("an invoke replies only after its commit's holder ops left a busy outbox", async () => {
    @actor("host-holders/Spawner")
    class Spawner extends Actor<Spawner, {}> {
      @action async makeChild(): Promise<ActorRef<Probe>> { return Actor.spawn(Probe, {}); }
    }
    const runtime = newRuntime();
    const spawner = await runtime.run(() => Actor.ofNamed(Spawner, "busy-outbox").orSpawn(() => ({})));
    await runInDurableObject(stubOf(spawner), (instance, state) => {
      // Rows for never-created actors (each a no-op delivery) keep the pass running while the invoke commits.
      const outbox = new Outbox(state.storage.kv);
      for (let i = 0; i < 200; i += 1) outbox.append([op("release", { id: env.ACTOR_HOST.newUniqueId().toString() }, "filler")]);
      void instance.applyHolderOps([]);
    });

    const child = await runtime.run(() => spawner.makeChild());
    for (let i = 0; i < 1_000 && (await outboxSize(spawner)) > 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(await outboxSize(spawner)).toBe(0);
    await expect(runtime.run(() => child.ping())).rejects.toBeInstanceOf(ActorKilledError);
  });

  // Regression (review F4): a sender that lost deliverMessage's ack redelivers the row after the action already
  // ran and its inbox key was deleted; without the sender watermark the detached action ran twice.
  test("a redelivered detached message whose action already ran is acked without running again", async () => {
    @actor("host-holders/Counter")
    class Counter extends Actor<Counter, {}> {
      @state accessor count = 0;
      @action async hit() { this.count += 1; }
    }
    const runtime = newRuntime();
    const counter = await runtime.run(() => Actor.ofNamed(Counter, "redelivered").orSpawn(() => ({})));
    const message = {
      id: "message_redelivered",
      target: { type: counter.type, id: counter.id },
      action: "hit",
      args: [],
      heldIds: [],
      dueAt: Date.now(),
    };
    const origin = { sender: "sender-host", seq: 7 };
    const waitInboxEmpty = async () => {
      for (let i = 0; i < 1_000 && (await inboxSize(counter)) > 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    };

    expect(await stubOf(counter).deliverMessage(message, origin)).toBe("queued");
    await waitInboxEmpty();
    expect(await stubOf(counter).deliverMessage(message, origin)).toBe("queued");
    await waitInboxEmpty();

    const count = await runtime.run(async () => (await Actor.refreshValues(counter)).count);
    expect(count).toBe(1);
  });

  // Regression (review R1): when delivering an invoke's own rows failed, the invoke rejected but its committed
  // hold(tx:root) still went out on the next host call; the caller never learned the id, so the child lived forever.
  test("an invoke rejected by a failed delivery releases the holds its commit queued", async () => {
    let childId: string | undefined;
    @actor("host-holders/LeakySpawner")
    class LeakySpawner extends Actor<LeakySpawner, {}> {
      @action async makeChild(): Promise<ActorRef<Probe>> {
        const child = await Actor.spawn(Probe, {});
        childId = child.id;
        return child;
      }
    }
    const runtime = newRuntime();
    const spawner = await runtime.run(() => Actor.ofNamed(LeakySpawner, "failing-outbox").orSpawn(() => ({})));
    // A row with an invalid target id ahead of the invoke's rows makes the next pass fail.
    const blocker = await runInDurableObject(stubOf(spawner), (_instance, state) =>
      new Outbox(state.storage.kv).append([op("release", { id: "not-a-durable-object-id" }, "blocker")]));

    await expect(runtime.run(() => spawner.makeChild())).rejects.toThrow();
    expect(childId).toBeDefined();
    const child = { id: childId! };
    expect(await storedKeys(child)).toContain("meta");

    await runInDurableObject(stubOf(spawner), (instance, state) => {
      state.storage.kv.delete(`outbox:${String(blocker).padStart(12, "0")}`);
      void instance.applyHolderOps([]);
    });
    await until(async () => (await outboxSize(spawner)) === 0 && (await storedKeys(child)).length === 0);
    expect(await storedKeys(child)).toEqual([]);
  });

  test("a failed delivery has no alarm and is retried when the sender next runs", async () => {
    @actor("host-holders/RetrySender")
    class RetrySender extends Actor<RetrySender, {}> {
      @action async ping() {}
    }
    const runtime = newRuntime();
    const [target, sender] = await runtime.run(async () => {
      const target = await Actor.ofNamed(Probe, "retry-target").orSpawn(() => ({}));
      const sender = await Actor.ofNamed(RetrySender, "retry-sender").orSpawn(() => ({}));
      return [target, sender] as const;
    });
    const holder = messageHolder("retry-on-next-call");
    const failedTarget = "not-a-durable-object-id";
    const sequence = await runInDurableObject(stubOf(sender), (_instance, state) =>
      new Outbox(state.storage.kv).append([op("hold", { id: failedTarget }, holder)]));
    const key = `outbox:${String(sequence).padStart(12, "0")}`;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(runtime.run(() => sender.ping())).rejects.toThrow();
      expect(await outboxSize(sender)).toBe(1);
      expect(await runInDurableObject(stubOf(sender), (_instance, state) => state.storage.getAlarm())).toBeNull();
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[0]).toContain(`ActorHost ${sender.id}: outbox row`);
      expect(error.mock.calls[0]?.[0]).toContain(`delivery to ${failedTarget} failed`);

      await runInDurableObject(stubOf(sender), (_instance, state) => {
        state.storage.kv.put(key, { kind: "ops", target: target.id, ops: [op("hold", target, holder)] });
      });
      await runtime.run(() => sender.ping());
      await until(async () => (await outboxSize(sender)) === 0);
      expect(await storedHolders(target)).toContain(holder);
    } finally {
      error.mockRestore();
    }
  });

  test("a collected actor retries a failed release via its alarm and then deletes its storage", async () => {
    const runtime = newRuntime();
    const target = await runtime.run(() => Actor.ofNamed(Probe, "collected-retry-target").orSpawn(() => ({})));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const before = Date.now();
      const ref = await collectWithFailingRelease(runtime, "once");
      const first = await collectedRetryState(ref);
      expect(first.attempt).toBe(1);
      expect(first.alarm).toBe(first.retryAt);
      expect(first.retryAt).toBeGreaterThanOrEqual(before + 5_000);
      expect(first.retryAt).toBeLessThanOrEqual(Date.now() + 5_000);

      await runInDurableObject(stubOf(ref), (_instance, state) => {
        const [entry] = [...state.storage.kv.list({ prefix: "outbox:" })];
        if (!entry) throw new Error("Expected a pending release row");
        state.storage.kv.put(entry[0], {
          kind: "ops",
          target: target.id,
          ops: [op("release", target, actorHolder(ref.id))],
        });
      });
      await runInDurableObject(stubOf(ref), (instance) => instance.alarm());

      expect(await storedKeys(ref)).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  test("an unnamed actor collected after its initial hold fails arms a collected retry", async () => {
    const ref = { id: env.ACTOR_HOST.newUniqueId().toString() };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await stubOf(ref).create({
        scope: crypto.randomUUID(),
        type: "host-holders/CreateFailure",
        input: { target: { type: "host-holders/Probe", id: FAILED_RELEASE_TARGET } },
        named: false,
        holders: [actorHolder("create-failure-caller")],
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected create to fail");
      expect(result.error.message).toContain("Invalid Durable Object ID");
      await until(async () => (await collectedRetryState(ref)).attempt !== undefined);
      const retry = await collectedRetryState(ref);
      const collected = await runInDurableObject(stubOf(ref), (_instance, state) =>
        state.storage.kv.get<boolean>("collected"));
      expect(collected).toBe(true);
      expect(retry.attempt).toBe(1);
      expect(retry.alarm).toBe(retry.retryAt);
    } finally {
      error.mockRestore();
    }
  });

  test("a collected actor stops after five failed release retries and preserves its storage", async () => {
    const runtime = newRuntime();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let before = Date.now();
      const ref = await collectWithFailingRelease(runtime, "exhausted");
      const delays = [5_000, 8_000, 13_000, 21_000, 34_000];

      for (const [index, delay] of delays.entries()) {
        const attempt = index + 1;
        const retry = await collectedRetryState(ref);
        expect(retry.attempt).toBe(attempt);
        expect(retry.alarm).toBe(retry.retryAt);
        expect(retry.retryAt).toBeGreaterThanOrEqual(before + delay);
        expect(retry.retryAt).toBeLessThanOrEqual(Date.now() + delay);
        if (index < delays.length - 1) before = Date.now();
        await runInDurableObject(stubOf(ref), (instance) => instance.alarm());
      }

      const exhausted = await collectedRetryState(ref);
      expect(exhausted).toEqual({ alarm: null, attempt: 5, retryAt: undefined });
      expect(await storedKeys(ref)).toEqual(expect.arrayContaining([
        "collected",
        "collected-retry-attempt",
        "holders",
        "outbox:000000000001",
      ]));
      expect(error).toHaveBeenCalledTimes(6);
      expect(error.mock.calls.at(-1)?.[0]).toContain(
        `ActorHost ${ref.id}: outbox row 1 delivery to ${FAILED_RELEASE_TARGET} failed after 5 collected retries`,
      );
      expect(error.mock.calls.at(-1)?.[0]).toContain("actor storage and holds are left in place");
    } finally {
      error.mockRestore();
    }
  });

  // Regression (review R2): a receiver kept one seen:<sender> watermark per sender forever, so a long-lived
  // named receiver grew a row for every anonymous sender that ever messaged it.
  test("a collected sender's seen watermark is removed from the receiver", async () => {
    @actor("host-holders/Receiver")
    class Receiver extends Actor<Receiver, {}> {
      @state accessor count = 0;
      @action async hit() { this.count += 1; }
    }
    @actor("host-holders/Sender")
    class Sender extends Actor<Sender, { receiver: ActorRef<Receiver> }> {
      @state accessor receiver = this.input.receiver;
      @action async send() { this.receiver.hit.runDetached(); }
    }
    const runtime = newRuntime();
    const receiver = await runtime.run(() => Actor.ofNamed(Receiver, "watermarked").orSpawn(() => ({})));
    const sender = await runtime.run(async () => {
      const sender = await Actor.spawn(Sender, { receiver });
      await sender.send();
      return sender;
    });

    await until(async () => (await runtime.run(async () => (await Actor.refreshValues(receiver)).count)) === 1);
    await until(async () => (await storedKeys(sender)).length === 0 && (await seenKeys(receiver)).length === 0);
    expect(await storedKeys(sender)).toEqual([]);
    expect(await seenKeys(receiver)).toEqual([]);
  });

  // Regression (review N0): every reply in one caller root held its result under the same tx:<root> holder, so
  // a failed invoke's own cleanup release also dropped the hold an earlier successful reply placed on the same
  // ref, and the ref was collected while the root still used it.
  test("a failed invoke's cleanup keeps another reply's hold on the same ref until the root ends", async () => {
    @actor("host-holders/Maker")
    class Maker extends Actor<Maker, {}> {
      @action async make(): Promise<ActorRef<Probe>> { return Actor.spawn(Probe, {}); }
    }
    @actor("host-holders/Echo")
    class Echo extends Actor<Echo, {}> {
      @action async echo(ref: ActorRef<Probe>): Promise<ActorRef<Probe>> { return ref; }
    }
    const runtime = newRuntime();
    const [maker, echo] = await runtime.run(() => Promise.all([
      Actor.ofNamed(Maker, "n0-maker").orSpawn(() => ({})),
      Actor.ofNamed(Echo, "n0-echo").orSpawn(() => ({})),
    ]));
    const blocker = await runInDurableObject(stubOf(echo), (_instance, state) =>
      new Outbox(state.storage.kv).append([op("release", { id: "not-a-durable-object-id" }, "blocker")]));

    let x!: ActorRef<Probe>;
    let midRoot: unknown;
    await runtime.run(async () => {
      x = await maker.make();
      await expect(echo.echo(x)).rejects.toThrow();
      await runInDurableObject(stubOf(echo), (instance, state) => {
        state.storage.kv.delete(`outbox:${String(blocker).padStart(12, "0")}`);
        void instance.applyHolderOps([]);
      });
      await until(async () => (await outboxSize(echo)) === 0);
      midRoot = await x.ping().catch((error: unknown) => error);
    });
    expect(midRoot).toBe("alive");
    await until(async () => (await storedKeys(x)).length === 0);
    expect(await storedKeys(x)).toEqual([]);
  });

  // Regression (review N1): a sender kept sent:<target> for every actor it ever messaged, even ones that died.
  test("a dead ack clears the sender's sent:<target> key", async () => {
    @actor("host-holders/Receiver#2")
    class Receiver extends Actor<Receiver, {}> {
      @action async hit() {}
    }
    @actor("host-holders/Sender#2")
    class Sender extends Actor<Sender, {}> {
      @action async send(receiver: ActorRef<Receiver>) { receiver.hit.runDetached(); }
    }
    const runtime = newRuntime();
    const sender = await runtime.run(() => Actor.ofNamed(Sender, "n1-sender").orSpawn(() => ({})));
    const receiver = await runtime.run(() => Actor.spawn(Receiver, {}));
    await until(async () => (await storedKeys(receiver)).length === 0);
    await runtime.run(() => sender.send(receiver));
    const sentKeys = () => runInDurableObject(stubOf(sender), (_instance, state) =>
      [...state.storage.kv.list({ prefix: "sent:" })].map(([key]) => key));
    await until(async () => (await outboxSize(sender)) === 0 && (await sentKeys()).length === 0);
    expect(await sentKeys()).toEqual([]);
  });
});
