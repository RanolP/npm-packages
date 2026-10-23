import type { Actor } from "../core/actor.js";
import { ActorRuntime, type ActorDescriptor } from "../runtime/actor-runtime.js";
import type { ActorRef } from "./types.js";

export interface ActorRefSurface {
  readonly values: Iterable<string>;
  readonly actions: Iterable<string>;
}

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
  for (const key of surface.actions) {
    const invoke = (...args: unknown[]) =>
      ActorRuntime.current(`Invoke ${ref.type}.${key}`).invokeRefAction(ref, key, args);
    Object.defineProperty(invoke, "runDetached", {
      value: (...args: unknown[]) =>
        ActorRuntime.current(`Detach ${ref.type}.${key}`).runDetached(ref, key, args),
      enumerable: false,
    });
    Object.defineProperty(ref, key, { value: invoke, enumerable: false, configurable: false });
  }
  // Runtime-defined properties implement the mapped ActorRef<T> surface, which TypeScript cannot infer.
  return Object.freeze(ref) as ActorRef<T>;
};
