import { Actor, ActorKilledError, ActorRuntimeError, action, actor, state, type ActorRef } from "@mekakucity/actors";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InMemoryActorRuntime } from "../src/index.js";

const constructed: string[] = [];
let pingCalls = 0;

@actor("days/fork/Item")
class Item extends Actor<Item, { label: string }> {
  @state accessor label = this.input.label;

  constructor(input: { label: string }) {
    super(input);
    constructed.push(`Item:${input.label}`);
  }
}

@actor("days/fork/Board")
class Board extends Actor<Board, { title: string }> {
  @state accessor title = this.input.title;
  @state accessor count = 0;
  @state accessor item: ActorRef<Item> | null = null;
  @state accessor pings = 0;

  constructor(input: { title: string }) {
    super(input);
    constructed.push(`Board:${input.title}`);
  }

  @action async increment() { this.count += 1; }
  @action async attach(label: string) { this.item = await Actor.spawn(Item, { label }); }
  @action async armPing(ms: number) { this.asRef.ping.schedule({ after: { ms } }).runDetached(); }
  @action async ping() {
    pingCalls += 1;
    this.pings += 1;
  }
}

let releaseSlow: (() => void) | undefined;
let slowSettled = false;
let markCalls = 0;

@actor("days/fork/Gated")
class Gated extends Actor<Gated, Record<string, never>> {
  @state accessor marks = 0;

  @action async arm(ms: number) {
    this.asRef.slow.schedule({ after: { ms } }).runDetached();
    this.asRef.mark.schedule({ after: { ms } }).runDetached();
  }
  @action async slow() {
    const { promise, resolve } = Promise.withResolvers<void>();
    releaseSlow = resolve;
    await promise;
    slowSettled = true;
  }
  @action async mark() {
    markCalls += 1;
    this.marks += 1;
  }
}

const board = (key = "main") => Actor.ofNamed(Board, key).orThrow();
// A fork starts with an empty snapshot cache, as a Durable Object cold load does.
const itemLabel = async (ref: ActorRef<Board>) => ref.item && (await Actor.refreshValues(ref.item)).label;
const count = (runtime: InMemoryActorRuntime) => runtime.run(async () => (await board()).count);

let bootRuns = 0;
const boot = async (runtime: InMemoryActorRuntime) => {
  bootRuns += 1;
  await runtime.run(async () => {
    const ref = await Actor.ofNamed(Board, "main").orSpawn(() => ({ title: "boot" }));
    await ref.increment();
    await ref.attach("seeded");
    await Actor.ofNamed(Board, "other").orSpawn(() => ({ title: "untouched" }));
  });
};

beforeEach(() => {
  constructed.length = 0;
  pingCalls = 0;
  bootRuns = 0;
  slowSettled = false;
  markCalls = 0;
  releaseSlow = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

// Regression: a per-test fork must see boot's committed state and named refs without re-running boot,
// and must construct only the actors a test touches, not every actor boot created.
it("fork sees boot state without rerunning boot and constructs only touched actors", async () => {
  const base = new InMemoryActorRuntime();
  await boot(base);
  constructed.length = 0;

  const child = base.fork();
  expect(constructed).toEqual([]);
  const seen = await child.run(async () => {
    const ref = await board();
    return { title: ref.title, count: ref.count, item: await itemLabel(ref) };
  });

  expect(bootRuns).toBe(1);
  expect(seen).toEqual({ title: "boot", count: 1, item: "seeded" });
  expect(constructed).toEqual(["Board:boot", "Item:seeded"]);
});

// Regression: writes in one fork, including replacing a held ref (which collects the old actor), must not
// leak into a sibling fork or into the frozen base that later forks start from.
it("two forks are isolated and the base is unchanged after a child writes", async () => {
  const base = new InMemoryActorRuntime();
  await boot(base);

  const first = base.fork();
  const second = base.fork();
  await first.run(async () => {
    const ref = await board();
    await ref.increment();
    await ref.attach("first-only");
  });

  expect(await count(first)).toBe(2);
  expect(await first.run(async () => itemLabel(await board()))).toBe("first-only");
  expect(await count(second)).toBe(1);
  expect(await second.run(async () => itemLabel(await board()))).toBe("seeded");
  const later = base.fork();
  expect(await count(later)).toBe(1);
  expect(await later.run(async () => itemLabel(await board()))).toBe("seeded");
});

// Regression: a delayed delivery pending in the base (e.g. announce(..., delay)) must fire once in the fork at
// its remaining due time, measured from fork() rather than from boot, and must not also fire in the base.
it("base pending delayed delivery fires in the fork, not in the base", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  // Under the 60s tick, so the base already holds a live timeout for it when fork() runs.
  const delay = 40_000;
  const base = new InMemoryActorRuntime();
  await base.run(async () => {
    const ref = await Actor.ofNamed(Board, "main").orSpawn(() => ({ title: "timer" }));
    await ref.armPing(delay);
  });
  await vi.advanceTimersByTimeAsync(delay / 2);

  const child = base.fork();
  const pings = () => child.run(async () => (await board()).pings);

  await vi.advanceTimersByTimeAsync(delay / 2 - 1);
  expect(await pings()).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(async () => expect(await pings()).toBe(1));
  await vi.advanceTimersByTimeAsync(delay);
  expect(pingCalls).toBe(1);
});

// Regression: a fork taken mid-transaction would copy uncommitted state and live transaction holders.
it("fork during an in-flight transaction throws", async () => {
  const base = new InMemoryActorRuntime();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const running = base.run(async () => {
    await (await Actor.ofNamed(Board, "main").orSpawn(() => ({ title: "busy" }))).increment();
    await gate;
  });

  expect(() => base.fork()).toThrow(/transaction is in flight/);
  release();
  await running;
  expect(await count(base.fork())).toBe(1);
});

// Regression: a write to the base after fork would show up in forks that have not yet touched that actor.
it("base run after fork throws", async () => {
  const base = new InMemoryActorRuntime();
  await boot(base);
  base.fork();

  expect(() => base.run(async () => {})).toThrow(ActorRuntimeError);
  expect(() => base.run(async () => {})).toThrow(/forked and is frozen/);
});

// Regression: a fixture disposing a per-test runtime must not leave delivery timers that fire into it later.
it("disposed runtime clears its delivery timers and rejects run", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const delay = 60_000;
  const runtime = new InMemoryActorRuntime();
  await runtime.run(async () => {
    await (await Actor.ofNamed(Board, "main").orSpawn(() => ({ title: "disposed" }))).armPing(delay);
  });
  expect(vi.getTimerCount()).toBeGreaterThan(0);

  runtime[Symbol.dispose]();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(delay * 2);
  expect(pingCalls).toBe(0);
  expect(() => runtime.run(async () => {})).toThrow(/disposed/);
});

// Regression: a delivery queued behind an in-flight one on the same target used to dispatch after dispose,
// leaking a side effect into whatever ran next; asyncDispose must also wait for the in-flight one.
it("dispose drops a queued delivery behind an in-flight one, and asyncDispose waits for the in-flight one", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const runtime = new InMemoryActorRuntime();
  await runtime.run(async () => {
    await (await Actor.ofNamed(Gated, "gate").orSpawn(() => ({}))).arm(1_000);
  });
  await vi.advanceTimersByTimeAsync(1_000);
  const release = await vi.waitFor(() => {
    if (!releaseSlow) throw new Error("slow not dispatched");
    return releaseSlow;
  });

  let disposed = false;
  const disposing = runtime[Symbol.asyncDispose]().then(() => { disposed = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(disposed).toBe(false);
  release();
  await disposing;

  expect(slowSettled).toBe(true);
  expect(markCalls).toBe(0);
});

// Regression: a fork of a fork must fall through two levels to the base, and must not see an actor its
// parent fork collected (the parent's tombstone has to hide the base record).
it("fork of a fork reads the base through its parent and respects the parent's collections", async () => {
  const base = new InMemoryActorRuntime();
  await boot(base);
  const child = base.fork();
  const seededId = await child.run(async () => {
    const ref = await board();
    const { item } = ref;
    if (!item) throw new Error("boot did not attach an item");
    const id = item.id;
    await ref.increment();
    await ref.attach("child-only");
    return id;
  });

  const grandchild = child.fork();
  const seen = await grandchild.run(async () => ({
    count: (await board()).count,
    item: await itemLabel(await board()),
    other: (await board("other")).title,
  }));
  expect(seen).toEqual({ count: 2, item: "child-only", other: "untouched" });
  await expect(grandchild.run(() => Actor.refreshValues({ type: "days/fork/Item", id: seededId })))
    .rejects.toThrow(ActorKilledError);
  expect(await base.fork().run(async () =>
    (await Actor.refreshValues<Item>({ type: "days/fork/Item", id: seededId })).label)).toBe("seeded");
});
