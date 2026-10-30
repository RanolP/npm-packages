import {
  parseActorSocketClientFrame,
  type ActorDescriptor,
  type ActorSocketResultSuccess,
  type ActorSocketServerFrame,
} from "@mekakucity/actors";
import {
  actorClassOrThrow,
  actorRefSurfaceFor,
  metadataFor,
  socketJsonValue,
  socketValuesEqual,
} from "@mekakucity/actors/runtime";
import type { InMemoryActorRuntime } from "./in-memory-actor-runtime.js";
import { socketRead, socketRuntime, type SocketValue } from "./socket-internal.js";

const SOCKET_CALL_TTL_MS = 10 * 60 * 1_000;

interface CachedCall {
  expiresAt: number;
  readonly result: Promise<ActorSocketResultSuccess>;
}

const cachedCalls = new WeakMap<InMemoryActorRuntime, Map<string, Map<string, CachedCall>>>();

export interface OpenSocketOptions<Carried = unknown> {
  readonly scope: string;
  readonly carried: Carried;
  readonly send: (message: string) => void | Promise<void>;
}

export interface ActorSocketConnection {
  receive(message: string): Promise<void>;
  close(): void;
}

export const openSocket = <Carried>(
  runtime: InMemoryActorRuntime,
  descriptor: ActorDescriptor,
  options: OpenSocketOptions<Carried>,
): ActorSocketConnection => {
  const Type = actorClassOrThrow(descriptor.type);
  const metadata = metadataFor(Type);
  const surface = actorRefSurfaceFor(Type);
  const liveKeys = new Set([...surface.values, ...[...surface.getters].map(([key]) => key)]);
  const subscribed = new Set<string>();
  const lastSent = new Map<string, unknown>();
  let closed = false;
  let liveTail = Promise.resolve();
  let callsByActor = cachedCalls.get(runtime);
  if (!callsByActor) {
    callsByActor = new Map();
    cachedCalls.set(runtime, callsByActor);
  }
  let calls = callsByActor.get(descriptor.id);
  if (!calls) {
    calls = new Map();
    callsByActor.set(descriptor.id, calls);
  }

  const sendFrame = (frame: ActorSocketServerFrame): void | Promise<void> => options.send(JSON.stringify(frame));
  const reportError = async (error: unknown): Promise<void> => {
    try {
      await sendFrame({
        t: "result",
        id: "",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // A failed error frame has no remaining delivery path on this connection.
    }
  };
  const unsubscribeEvents = runtime.onEvent((event) => {
    if (event.actor.type !== descriptor.type || event.actor.id !== descriptor.id) return;
    try {
      const payload = socketJsonValue(event.payload, `Actor event ${event.name} payload`);
      void Promise.resolve(sendFrame({ t: "event", name: event.name, payload })).catch(() => {});
    } catch (error) {
      void reportError(error);
    }
  });
  const readValue = (key: string): Promise<SocketValue> =>
    runtime[socketRead](descriptor, key);
  const pushChangedValues = async (): Promise<void> => {
    if (closed) return;
    for (const key of subscribed) {
      try {
        const current = await readValue(key);
        const value = socketJsonValue(current.value, `Actor live key ${key}`);
        if (lastSent.has(key) && socketValuesEqual(lastSent.get(key), value)) continue;
        lastSent.set(key, structuredClone(value));
        await sendFrame({ t: "value", key, value, version: current.version });
      } catch (error) {
        await reportError(new Error(
          `Actor live key ${key} failed: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    }
  };
  const unsubscribeCommits = runtime.onCommit((commit) => {
    if (commit.actor.type !== descriptor.type || commit.actor.id !== descriptor.id) return;
    liveTail = liveTail.then(pushChangedValues).catch(reportError);
    return liveTail;
  });

  return {
    async receive(message) {
      const parsed = parseActorSocketClientFrame(message);
      if (!parsed.ok) {
        await sendFrame(parsed.error);
        return;
      }
      if (parsed.frame.t === "subscribe") {
        if (!liveKeys.has(parsed.frame.key)) {
          await sendFrame({ t: "result", id: "", ok: false, error: `Unknown actor live key ${parsed.frame.key}` });
          return;
        }
        subscribed.add(parsed.frame.key);
        try {
          const current = await readValue(parsed.frame.key);
          const value = socketJsonValue(current.value, `Actor live key ${parsed.frame.key}`);
          lastSent.set(parsed.frame.key, structuredClone(value));
          await sendFrame({ t: "value", key: parsed.frame.key, value, version: current.version });
        } catch (error) {
          await reportError(new Error(
            `Actor live key ${parsed.frame.key} failed: ${error instanceof Error ? error.message : String(error)}`,
          ));
        }
        return;
      }
      if (parsed.frame.t === "unsubscribe") {
        subscribed.delete(parsed.frame.key);
        lastSent.delete(parsed.frame.key);
        return;
      }

      const now = Date.now();
      for (const [key, cached] of calls) if (cached.expiresAt <= now) calls.delete(key);
      const call = parsed.frame;
      if (!metadata.clientActions.has(call.action)) {
        await sendFrame({
          t: "result",
          id: call.id,
          ok: false,
          error: `Actor action ${call.action} is not callable over a socket`,
        });
        return;
      }
      const dedupKey = `${options.scope}:${call.id}`;
      let cached = calls.get(dedupKey);
      if (!cached) {
        const result = runtime[socketRuntime](
          descriptor,
          call.action,
          [...call.args],
          options.carried,
        ).then((value): ActorSocketResultSuccess => {
          const active = calls.get(dedupKey);
          if (active) active.expiresAt = Date.now() + SOCKET_CALL_TTL_MS;
          return { t: "result", id: call.id, ok: true, value };
        });
        cached = { expiresAt: Infinity, result };
        calls.set(dedupKey, cached);
      }
      let result: ActorSocketResultSuccess;
      try {
        result = await cached.result;
      } catch (error) {
        if (calls.get(dedupKey) === cached) calls.delete(dedupKey);
        await sendFrame({
          t: "result",
          id: call.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      try {
        await sendFrame(result);
      } catch {
        // The action is already committed and cached; a later resend must reuse it.
      }
    },
    close() {
      closed = true;
      unsubscribeEvents();
      unsubscribeCommits();
    },
  };
};
