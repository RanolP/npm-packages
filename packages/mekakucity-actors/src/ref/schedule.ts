import { MAX_ACTOR_DUE_AT, type ActorDetachedSchedule } from "../runtime/actor-runtime.js";
import { ActorScheduleError } from "./errors.js";
import type { ActorScheduleOptions } from "./types.js";

export const immediateActorSchedule: ActorDetachedSchedule = { afterMs: 0 };

export const normalizeActorSchedule = (options: ActorScheduleOptions): ActorDetachedSchedule => {
  if (typeof options !== "object" || options === null) throw new ActorScheduleError("expected an options object");
  const hasAfter = "after" in options;
  const hasAt = "at" in options;
  if (hasAfter === hasAt) throw new ActorScheduleError("provide exactly one of after or at");
  if (hasAfter) {
    const ms = options.after?.ms;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > MAX_ACTOR_DUE_AT) {
      throw new ActorScheduleError(
        `after.ms must be a finite number between 0 and ${MAX_ACTOR_DUE_AT}`,
      );
    }
    return { afterMs: ms };
  }
  if (!(options.at instanceof Date) || !Number.isFinite(options.at.getTime())) {
    throw new ActorScheduleError("at must be a valid Date");
  }
  return { dueAt: options.at.getTime() };
};
