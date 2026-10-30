export interface ActorSocketCall {
  readonly t: "call";
  readonly id: string;
  readonly action: string;
  readonly args: unknown[];
}

export interface ActorSocketResultSuccess {
  readonly t: "result";
  readonly id: string;
  readonly ok: true;
  readonly value: unknown;
}

export interface ActorSocketResultFailure {
  readonly t: "result";
  readonly id: string;
  readonly ok: false;
  readonly error: unknown;
}

export type ActorSocketResult = ActorSocketResultSuccess | ActorSocketResultFailure;

export interface ActorSocketEvent {
  readonly t: "event";
  readonly name: string;
  readonly payload: unknown;
}

export interface ActorSocketSubscribe {
  readonly t: "subscribe";
  readonly key: string;
}

export interface ActorSocketUnsubscribe {
  readonly t: "unsubscribe";
  readonly key: string;
}

export interface ActorSocketValue {
  readonly t: "value";
  readonly key: string;
  readonly value: unknown;
  readonly version: number;
}

export type ActorSocketClientFrame = ActorSocketCall | ActorSocketSubscribe | ActorSocketUnsubscribe;
export type ActorSocketServerFrame = ActorSocketResult | ActorSocketEvent | ActorSocketValue;
export type ActorSocketFrame = ActorSocketClientFrame | ActorSocketServerFrame;

export type ParsedActorSocketClientFrame =
  | { readonly ok: true; readonly frame: ActorSocketClientFrame }
  | { readonly ok: false; readonly error: ActorSocketResultFailure };

const failure = (id: string, error: string): ParsedActorSocketClientFrame => ({
  ok: false,
  error: { t: "result", id, ok: false, error },
});

/** Parses the JSON wire format and validates the fields clients are allowed to send. */
export const parseActorSocketClientFrame = (message: string | ArrayBuffer): ParsedActorSocketClientFrame => {
  if (typeof message !== "string") return failure("", "Actor socket frames must be JSON text");
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return failure("", "Actor socket frame is not valid JSON");
  }
  if (typeof value !== "object" || value === null) return failure("", "Actor socket frame must be an object");
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  if (record.t === "call") {
    if (typeof record.id !== "string" || typeof record.action !== "string" || !Array.isArray(record.args)) {
      return failure(id, "Actor socket call needs string id and action fields and an args array");
    }
    return { ok: true, frame: { t: "call", id: record.id, action: record.action, args: record.args } };
  }
  if (record.t === "subscribe") {
    if (typeof record.key !== "string") return failure(id, "Actor socket subscribe needs a string key");
    return { ok: true, frame: { t: "subscribe", key: record.key } };
  }
  if (record.t === "unsubscribe") {
    if (typeof record.key !== "string") return failure(id, "Actor socket unsubscribe needs a string key");
    return { ok: true, frame: { t: "unsubscribe", key: record.key } };
  }
  return failure(id, "Unknown actor socket frame type");
};
