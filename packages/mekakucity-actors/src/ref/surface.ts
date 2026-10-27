import { Actor } from "../core/actor.js";
import { metadataFor } from "../action/decorators.js";
import { ActorRuntime, type ActorDescriptor } from "../runtime/actor-runtime.js";
import { immediateActorSchedule, normalizeActorSchedule } from "./schedule.js";
import type { ActorRef, ActorScheduleOptions } from "./types.js";

export interface ActorRefSurface {
  readonly values: Iterable<string>;
  readonly actions: Iterable<string>;
  readonly getters: Iterable<readonly [string, (this: object) => unknown]>;
}

export const actorRefSurfaceFor = (ctor: Function): ActorRefSurface => {
  const metadata = metadataFor(ctor);
  const getters = new Map<string, (this: object) => unknown>();
  const seen = new Set<string>();
  for (let prototype = ctor.prototype; prototype && prototype !== Actor.prototype; prototype = Object.getPrototypeOf(prototype)) {
    for (const key of Object.getOwnPropertyNames(prototype)) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (metadata.state.has(key) || metadata.actions.has(key)) continue;
      const getter = Object.getOwnPropertyDescriptor(prototype, key)?.get;
      if (getter) getters.set(key, getter);
    }
  }
  return { values: metadata.state, actions: metadata.actions.keys(), getters };
};

export const createActorRef = <T extends Actor<unknown, unknown>>(
  descriptor: ActorDescriptor,
  surface: ActorRefSurface,
): ActorRef<T> => {
  const ref: ActorDescriptor & Record<string, unknown> = { type: descriptor.type, id: descriptor.id };
  for (const key of surface.values) {
    Object.defineProperty(ref, key, {
      enumerable: false,
      configurable: false,
      get: () => ActorRuntime.current(`Read actor ref ${ref.id}`).readSnapshotValue(ref, key),
    });
  }
  for (const [key, getter] of surface.getters) {
    Object.defineProperty(ref, key, {
      enumerable: false,
      configurable: false,
      get: () => getter.call(ref),
    });
  }
  for (const key of surface.actions) {
    const invoke = (...args: unknown[]) =>
      ActorRuntime.current(`Invoke ${ref.type}.${key}`).invokeRefAction(ref, key, args);
    Object.defineProperty(invoke, "runDetached", {
      value: (...args: unknown[]) =>
        ActorRuntime.current(`Detach ${ref.type}.${key}`).runDetached(ref, key, args, immediateActorSchedule),
      enumerable: false,
    });
    Object.defineProperty(invoke, "schedule", {
      value: (options: ActorScheduleOptions) => {
        const schedule = normalizeActorSchedule(options);
        return Object.freeze({
          runDetached: (...args: unknown[]) =>
            ActorRuntime.current(`Schedule ${ref.type}.${key}`).runDetached(ref, key, args, schedule),
        });
      },
      enumerable: false,
    });
    Object.defineProperty(ref, key, { value: invoke, enumerable: false, configurable: false });
  }
  // Runtime-defined properties implement the mapped ActorRef<T> surface, which TypeScript cannot infer.
  return Object.freeze(ref) as ActorRef<T>;
};
