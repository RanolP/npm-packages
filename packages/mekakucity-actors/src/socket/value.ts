import { isDeepStrictEqual } from "node:util";
import { ActorRuntimeError } from "../runtime/errors.js";

/** Structural equality for values after they cross a structured-clone boundary. */
export const socketValuesEqual = (left: unknown, right: unknown): boolean => isDeepStrictEqual(left, right);

/** Returns the exact JSON wire value, rejecting values JSON would change or cannot encode. */
export const socketJsonValue = (value: unknown, subject: string): unknown => {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (cause) {
    throw new ActorRuntimeError(`${subject} is not JSON-safe`, { cause });
  }
  if (encoded === undefined) throw new ActorRuntimeError(`${subject} is not JSON-safe`);
  const decoded: unknown = JSON.parse(encoded);
  if (!socketValuesEqual(value, decoded)) throw new ActorRuntimeError(`${subject} is not JSON-safe`);
  return decoded;
};
