import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Actor } from "@mekakucity/actors";
import { expect, test } from "vitest";
import { DurableObjectActorRuntime } from "../src/index.js";
import { TallyActor } from "./registered-actors.js";

const connectSocket = async (stub: DurableObjectStub, requestId: string) => {
  const response = await stub.fetch("http://actor/socket", {
    headers: { Upgrade: "websocket", "x-request-id": requestId },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("ActorHost did not return a WebSocket");
  socket.accept();
  return socket;
};

const openSocket = async (requestId = crypto.randomUUID()) => {
  const runtime = new DurableObjectActorRuntime(env.ACTOR_HOST, { scope: crypto.randomUUID() });
  const ref = await runtime.run(() => Actor.ofNamed(TallyActor, "socket").orSpawn(() => ({ count: 0 })));
  const stub = env.ACTOR_HOST.get(env.ACTOR_HOST.idFromString(ref.id));
  const socket = await connectSocket(stub, requestId);
  return { ref, socket, stub };
};

const nextFrame = (socket: WebSocket): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
  const onMessage = (event: MessageEvent) => {
    cleanup();
    try {
      resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
    } catch (error) {
      reject(error);
    }
  };
  const onError = () => {
    cleanup();
    reject(new Error("Actor socket failed before returning a frame"));
  };
  const cleanup = () => {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
  };
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
});

const nextFrames = (socket: WebSocket, count: number): Promise<Record<string, unknown>[]> =>
  new Promise((resolve, reject) => {
    const frames: Record<string, unknown>[] = [];
    const onMessage = (event: MessageEvent) => {
      try {
        frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
        if (frames.length === count) {
          cleanup();
          resolve(frames);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error("Actor socket failed before returning all frames"));
    };
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
  });

const call = async (socket: WebSocket, frame: Record<string, unknown>) => {
  const response = nextFrame(socket);
  socket.send(JSON.stringify(frame));
  return response;
};

const expectNoFrame = (socket: WebSocket): Promise<void> => new Promise((resolve, reject) => {
  const onMessage = (event: MessageEvent) => {
    cleanup();
    reject(new Error(`Expected no frame, received ${String(event.data)}`));
  };
  const timer = setTimeout(() => {
    cleanup();
    resolve();
  }, 20);
  const cleanup = () => {
    clearTimeout(timer);
    socket.removeEventListener("message", onMessage);
  };
  socket.addEventListener("message", onMessage);
});

test("a plain action is rejected without changing version while a client action succeeds", async () => {
  const { socket, stub } = await openSocket();
  expect(await call(socket, { t: "call", id: "server", action: "serverOnlyAdd", args: [] })).toEqual({
    t: "result",
    id: "server",
    ok: false,
    error: "Actor action serverOnlyAdd is not callable over a socket",
  });
  expect(await runInDurableObject(stub, (_instance, state) => state.storage.kv.get("version"))).toBe(0);
  expect(await call(socket, { t: "call", id: "first", action: "add", args: [] })).toEqual({
    t: "result", id: "first", ok: true, value: 1,
  });
  expect(await runInDurableObject(stub, (_instance, state) => ({
    snapshot: state.storage.kv.get("snapshot"),
    version: state.storage.kv.get("version"),
  }))).toEqual({ snapshot: { count: 1 }, version: 1 });
  socket.close();
});

test("a subscription sends its current value and only changed committed values", async () => {
  const { socket } = await openSocket();
  const initial = nextFrame(socket);
  socket.send(JSON.stringify({ t: "subscribe", key: "count" }));
  expect(await initial).toEqual({ t: "value", key: "count", value: 0, version: 0 });

  const changed = nextFrames(socket, 2);
  socket.send(JSON.stringify({ t: "call", id: "changed", action: "add", args: [] }));
  expect(await changed).toEqual([
    { t: "value", key: "count", value: 1, version: 1 },
    { t: "result", id: "changed", ok: true, value: 1 },
  ]);
  expect(await call(socket, { t: "call", id: "same", action: "unchanged", args: [] })).toEqual({
    t: "result", id: "same", ok: true, value: 1,
  });
  await expectNoFrame(socket);
  socket.close();
});

test("a value frame is sent only to sockets subscribed to its key", async () => {
  const { socket: subscribed, stub } = await openSocket("subscribed");
  const other = await connectSocket(stub, "other");
  const otherFrames: Record<string, unknown>[] = [];
  other.addEventListener("message", (event) => {
    otherFrames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  });
  const initial = nextFrame(subscribed);
  subscribed.send(JSON.stringify({ t: "subscribe", key: "count" }));
  await initial;

  const changed = nextFrame(subscribed);
  expect(await call(other, { t: "call", id: "other-add", action: "add", args: [] })).toEqual({
    t: "result", id: "other-add", ok: true, value: 1,
  });
  expect(await changed).toEqual({ t: "value", key: "count", value: 1, version: 1 });
  await expectNoFrame(other);
  expect(otherFrames).toEqual([{ t: "result", id: "other-add", ok: true, value: 1 }]);
  subscribed.close();
  other.close();
});

test("a getter on the actor ref surface can be subscribed", async () => {
  const { socket } = await openSocket();
  const initial = nextFrame(socket);
  socket.send(JSON.stringify({ t: "subscribe", key: "doubled" }));
  expect(await initial).toEqual({ t: "value", key: "doubled", value: 0, version: 0 });

  const changed = nextFrames(socket, 2);
  socket.send(JSON.stringify({ t: "call", id: "double", action: "add", args: [] }));
  expect(await changed).toEqual([
    { t: "value", key: "doubled", value: 2, version: 1 },
    { t: "result", id: "double", ok: true, value: 1 },
  ]);
  socket.close();
});

test("a throwing live getter cannot roll back a committed call or block other keys", async () => {
  const { socket, stub } = await openSocket();
  for (const key of ["explodesAfterChange", "count"]) {
    const initial = nextFrame(socket);
    socket.send(JSON.stringify({ t: "subscribe", key }));
    await initial;
  }

  const committed = nextFrames(socket, 3);
  const frame = { t: "call", id: "getter-failure", action: "add", args: [] };
  socket.send(JSON.stringify(frame));
  expect(await committed).toEqual([
    {
      t: "result",
      id: "",
      ok: false,
      error: "Actor live key explodesAfterChange failed: getter exploded",
    },
    { t: "value", key: "count", value: 1, version: 1 },
    { t: "result", id: "getter-failure", ok: true, value: 1 },
  ]);
  expect(await call(socket, frame)).toEqual({
    t: "result", id: "getter-failure", ok: true, value: 1,
  });
  expect(await runInDurableObject(stub, (_instance, state) => ({
    snapshot: state.storage.kv.get("snapshot"),
    version: state.storage.kv.get("version"),
  }))).toEqual({ snapshot: { count: 1 }, version: 1 });
  socket.close();
});

test("a non-JSON action result fails before committing state or a dedup row", async () => {
  const { socket, stub } = await openSocket();
  const frame = { t: "call", id: "bigint", action: "bigintAfterAdd", args: [] };

  expect(await call(socket, frame)).toEqual({
    t: "result",
    id: "bigint",
    ok: false,
    error: "Actor socket action bigintAfterAdd result is not JSON-safe",
  });
  expect(await call(socket, frame)).toMatchObject({ ok: false });
  expect(await runInDurableObject(stub, (_instance, state) => ({
    calls: [...state.storage.kv.list({ prefix: "socket-call:" })],
    snapshot: state.storage.kv.get("snapshot"),
    version: state.storage.kv.get("version"),
  }))).toEqual({ calls: [], snapshot: { count: 0 }, version: 0 });
  socket.close();
});

test("resending the same call id returns the stored result and the actor version does not move", async () => {
  const { socket, stub } = await openSocket();
  const frame = { t: "call", id: "same", action: "add", args: [] };
  expect(await call(socket, frame)).toMatchObject({ ok: true, value: 1 });
  expect(await call(socket, frame)).toMatchObject({ ok: true, value: 1 });
  expect(await runInDurableObject(stub, (_instance, state) => ({
    snapshot: state.storage.kv.get("snapshot"),
    version: state.storage.kv.get("version"),
  }))).toEqual({ snapshot: { count: 1 }, version: 1 });
  socket.close();
});

test("dedup remains scoped by user identity after wrapping the socket attachment", async () => {
  const { socket: first, stub } = await openSocket("first-identity");
  const second = await connectSocket(stub, "second-identity");
  const frame = { t: "call", id: "shared", action: "add", args: [] };
  expect(await call(first, frame)).toMatchObject({ ok: true, value: 1 });
  expect(await call(second, frame)).toMatchObject({ ok: true, value: 2 });
  expect(await runInDurableObject(stub, (_instance, state) => ({
    snapshot: state.storage.kv.get("snapshot"),
    version: state.storage.kv.get("version"),
  }))).toEqual({ snapshot: { count: 2 }, version: 2 });
  first.close();
  second.close();
});

test("the action sees the carried value derived from the attachment", async () => {
  const { socket } = await openSocket("socket-identity");
  expect(await call(socket, { t: "call", id: "context", action: "contextRequestId", args: [] })).toEqual({
    t: "result", id: "context", ok: true, value: "socket-identity",
  });
  socket.close();
});

test("a malformed frame gets an error frame and the socket stays usable", async () => {
  const { socket } = await openSocket();
  const malformed = nextFrame(socket);
  socket.send("not json");
  expect(await malformed).toMatchObject({ t: "result", id: "", ok: false });
  expect(await call(socket, { t: "call", id: "after-error", action: "add", args: [] })).toEqual({
    t: "result", id: "after-error", ok: true, value: 1,
  });
  socket.close();
});


test("an event emitted by a socket action is broadcast to every socket on the actor", async () => {
  const { socket: caller, stub } = await openSocket("caller");
  const observer = await connectSocket(stub, "observer");
  const callerFrames = nextFrames(caller, 2);
  const observerEvent = nextFrame(observer);
  caller.send(JSON.stringify({ t: "call", id: "announce", action: "announce", args: [] }));
  expect(await callerFrames).toEqual([
    { t: "event", name: "counted", payload: { count: 0 } },
    { t: "result", id: "announce", ok: true },
  ]);
  expect(await observerEvent).toEqual({ t: "event", name: "counted", payload: { count: 0 } });
  caller.close();
  observer.close();
});

test("an event emitted by a throwing socket action is not delivered", async () => {
  const { socket } = await openSocket();
  expect(await call(socket, {
    t: "call", id: "failed-announcement", action: "announceThenThrow", args: [],
  })).toEqual({ t: "result", id: "failed-announcement", ok: false, error: "announcement failed" });
  expect(await call(socket, { t: "call", id: "after-failure", action: "add", args: [] })).toEqual({
    t: "result", id: "after-failure", ok: true, value: 1,
  });
  socket.close();
});
