import {
  ActorKilledError,
  ActorReentrancyError,
  ActorResultSerializationError,
  ActorRuntimeError,
  ActorSnapshotUnavailableError,
  ActorStateSerializationError,
  NoActiveActorRuntimeError,
  NoActiveTransactionError,
} from "@mekakucity/actors";
import type { Outcome, WireError } from "./protocol.js";

const knownErrors: Record<string, Function> = {
  ActorKilledError,
  ActorReentrancyError,
  ActorResultSerializationError,
  ActorRuntimeError,
  ActorSnapshotUnavailableError,
  ActorStateSerializationError,
  NoActiveActorRuntimeError,
  NoActiveTransactionError,
};

// When caller and host share an isolate (always under vitest-plugin), the
// caller gets the original error object back; elsewhere it gets a rebuilt one.
const vault = new Map<string, unknown>();
const VAULT_LIMIT = 256;

export const toWireError = (error: unknown): WireError => {
  const token = crypto.randomUUID();
  vault.set(token, error);
  if (vault.size > VAULT_LIMIT) vault.delete(vault.keys().next().value!);
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return { name, message, token };
};

export const fromWireError = (wire: WireError): unknown => {
  if (vault.has(wire.token)) {
    const original = vault.get(wire.token);
    vault.delete(wire.token);
    return original;
  }
  const error = new Error(wire.message);
  const Known = knownErrors[wire.name];
  if (Known) Object.setPrototypeOf(error, Known.prototype);
  error.name = wire.name;
  return error;
};

export const capture = async <T>(work: () => Promise<T>): Promise<Outcome<T>> => {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: toWireError(error) };
  }
};

export const unwrap = <T>(outcome: Outcome<T>): T => {
  if (outcome.ok) return outcome.value;
  throw fromWireError(outcome.error);
};
