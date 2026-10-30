import { Actor, action, actor, clientAction, state } from "@mekakucity/actors";
import { expect, test } from "vitest";
import { InMemoryActorRuntime, openSocket } from "../src/index.js";

@actor("days/tests/SocketActor")
class SocketActor extends Actor<SocketActor, Record<string, never>> {
  declare events: { announced: { value: string } };

  @state accessor calls = 0;

  get doubled(): number {
    return this.calls * 2;
  }

  @action async serverOnlyIncrement(): Promise<number> {
    this.calls += 1;
    return this.calls;
  }

  @clientAction async increment(): Promise<number> {
    this.calls += 1;
    return this.calls;
  }

  @clientAction async unchanged(): Promise<number> {
    return this.calls;
  }

  @clientAction async bigintAfterIncrement(): Promise<bigint> {
    this.calls += 1;
    return BigInt(this.calls);
  }

  @clientAction async announce(value: string): Promise<void> {
    this.emit("announced", { value });
  }
}

const frames = (messages: string[]) => messages.map((message) => JSON.parse(message) as Record<string, unknown>);

test("a plain action is rejected without changing version while a client action succeeds", async () => {
  const runtime = new InMemoryActorRuntime();
  const actor = await runtime.run(() => Actor.ofNamed(SocketActor, "authorization").orSpawn(() => ({})));
  const sent: string[] = [];
  const socket = openSocket(runtime, actor, { scope: "identity", carried: undefined, send: (message) => {
    sent.push(message);
  } });

  await socket.receive(JSON.stringify({ t: "call", id: "server", action: "serverOnlyIncrement", args: [] }));
  await socket.receive(JSON.stringify({ t: "subscribe", key: "calls" }));
  await socket.receive(JSON.stringify({ t: "call", id: "client", action: "increment", args: [] }));

  expect(frames(sent)).toEqual([
    {
      t: "result",
      id: "server",
      ok: false,
      error: "Actor action serverOnlyIncrement is not callable over a socket",
    },
    { t: "value", key: "calls", value: 0, version: 0 },
    { t: "value", key: "calls", value: 1, version: 1 },
    { t: "result", id: "client", ok: true, value: 1 },
  ]);
  expect(await runtime.run(async () => (await Actor.refreshValues(actor)).calls)).toBe(1);
  socket.close();
});

test("a subscription sends its current value and only changed committed values", async () => {
  const runtime = new InMemoryActorRuntime();
  const actor = await runtime.run(() => Actor.ofNamed(SocketActor, "live").orSpawn(() => ({})));
  const sent: string[] = [];
  const socket = openSocket(runtime, actor, { scope: "identity", carried: undefined, send: (message) => {
    sent.push(message);
  } });

  await socket.receive(JSON.stringify({ t: "subscribe", key: "calls" }));
  await socket.receive(JSON.stringify({ t: "call", id: "changed", action: "increment", args: [] }));
  await socket.receive(JSON.stringify({ t: "call", id: "same", action: "unchanged", args: [] }));

  expect(frames(sent)).toEqual([
    { t: "value", key: "calls", value: 0, version: 0 },
    { t: "value", key: "calls", value: 1, version: 1 },
    { t: "result", id: "changed", ok: true, value: 1 },
    { t: "result", id: "same", ok: true, value: 1 },
  ]);
  socket.close();
});

test("a call returns a result and resending its scoped id does not rerun the action", async () => {
  const runtime = new InMemoryActorRuntime();
  const actor = await runtime.run(() => Actor.ofNamed(SocketActor, "dedup").orSpawn(() => ({})));
  const sent: string[] = [];
  const otherSent: string[] = [];
  const socket = openSocket(runtime, actor, { scope: "identity-1", carried: undefined, send: (message) => {
    sent.push(message);
  } });
  const other = openSocket(runtime, actor, { scope: "identity-2", carried: undefined, send: (message) => {
    otherSent.push(message);
  } });
  const call = JSON.stringify({ t: "call", id: "same", action: "increment", args: [] });

  await socket.receive(call);
  await socket.receive(call);
  await other.receive(call);

  expect(frames(sent)).toEqual([
    { t: "result", id: "same", ok: true, value: 1 },
    { t: "result", id: "same", ok: true, value: 1 },
  ]);
  expect(frames(otherSent)).toEqual([
    { t: "result", id: "same", ok: true, value: 2 },
  ]);
  socket.close();
  other.close();
});

test("a failed result send keeps the committed call cached for a resend", async () => {
  const runtime = new InMemoryActorRuntime();
  const actor = await runtime.run(() => Actor.ofNamed(SocketActor, "send-failure").orSpawn(() => ({})));
  const sent: string[] = [];
  let rejectNext = true;
  const socket = openSocket(runtime, actor, {
    scope: "identity",
    carried: undefined,
    send: (message) => {
      if (rejectNext) {
        rejectNext = false;
        return Promise.reject(new Error("send failed"));
      }
      sent.push(message);
    },
  });
  const call = JSON.stringify({ t: "call", id: "same", action: "increment", args: [] });

  await socket.receive(call);
  await socket.receive(call);

  expect(frames(sent)).toEqual([{ t: "result", id: "same", ok: true, value: 1 }]);
  expect(await runtime.run(async () => (await Actor.refreshValues(actor)).calls)).toBe(1);
  socket.close();
});

test("a non-JSON action result fails before committing state", async () => {
  const runtime = new InMemoryActorRuntime();
  const actor = await runtime.run(() => Actor.ofNamed(SocketActor, "json-result").orSpawn(() => ({})));
  const sent: string[] = [];
  const socket = openSocket(runtime, actor, { scope: "identity", carried: undefined, send: (message) => {
    sent.push(message);
  } });

  await socket.receive(JSON.stringify({ t: "call", id: "bigint", action: "bigintAfterIncrement", args: [] }));
  await socket.receive(JSON.stringify({ t: "subscribe", key: "calls" }));

  expect(frames(sent)).toEqual([
    {
      t: "result",
      id: "bigint",
      ok: false,
      error: "Actor socket action bigintAfterIncrement result is not JSON-safe",
    },
    { t: "value", key: "calls", value: 0, version: 0 },
  ]);
  socket.close();
});

test("all sockets receive actor events and close stops event delivery", async () => {
  const runtime = new InMemoryActorRuntime();
  const actor = await runtime.run(() => Actor.ofNamed(SocketActor, "events").orSpawn(() => ({})));
  const firstSent: string[] = [];
  const secondSent: string[] = [];
  const first = openSocket(runtime, actor, { scope: "first", carried: undefined, send: (message) => {
    firstSent.push(message);
  } });
  const second = openSocket(runtime, actor, { scope: "second", carried: undefined, send: (message) => {
    secondSent.push(message);
  } });

  await first.receive(JSON.stringify({ t: "call", id: "event-1", action: "announce", args: ["one"] }));
  second.close();
  await first.receive(JSON.stringify({ t: "call", id: "event-2", action: "announce", args: ["two"] }));

  expect(frames(firstSent).filter((frame) => frame.t === "event")).toEqual([
    { t: "event", name: "announced", payload: { value: "one" } },
    { t: "event", name: "announced", payload: { value: "two" } },
  ]);
  expect(frames(secondSent)).toEqual([
    { t: "event", name: "announced", payload: { value: "one" } },
  ]);
  first.close();
});

test("malformed input returns an error frame", async () => {
  const runtime = new InMemoryActorRuntime();
  const actor = await runtime.run(() => Actor.ofNamed(SocketActor, "malformed").orSpawn(() => ({})));
  const sent: string[] = [];
  const socket = openSocket(runtime, actor, { scope: "identity", carried: undefined, send: (message) => {
    sent.push(message);
  } });

  await socket.receive("not json");

  expect(frames(sent)).toEqual([{
    t: "result", id: "", ok: false, error: "Actor socket frame is not valid JSON",
  }]);
  socket.close();
});
