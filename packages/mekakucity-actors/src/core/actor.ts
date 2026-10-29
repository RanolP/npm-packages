import { metadataFor } from "../action/decorators.js";
import { ActorSelfRefUnavailableError } from "../ref/errors.js";
import { immediateActorSchedule, normalizeActorSchedule } from "../ref/schedule.js";
import type { ActorInput, ActorRef, ActorRefInit, ActorScheduleOptions, ActorSelfRef } from "../ref/types.js";
import type {
  ActorDescriptor,
  ActorConstructor,
  ActorReadObserver,
} from "../runtime/actor-runtime.js";
import { ActorRuntime } from "../runtime/actor-runtime.js";
import { ActorContextUnavailableError, NoActiveActorRuntimeError } from "../runtime/errors.js";
import type { ActorContext } from "../runtime/actor-context.js";

const currentRuntimeForSelfRef = (): ActorRuntime => {
  try {
    return ActorRuntime.current("Read Actor.asRef");
  } catch (cause) {
    if (cause instanceof NoActiveActorRuntimeError) throw new ActorSelfRefUnavailableError({ cause });
    throw cause;
  }
};

export abstract class Actor<Self, Input> {
  protected readonly input: Input;
  declare protected readonly __actorInput: Input;

  constructor(input: Input) {
    this.input = input;
  }

  protected get ctx(): ActorContext {
    try {
      return ActorRuntime.current("Read Actor.ctx").actorContextOf(this);
    } catch (cause) {
      if (cause instanceof NoActiveActorRuntimeError) throw new ActorContextUnavailableError(undefined, { cause });
      throw cause;
    }
  }

  protected get asRef(): ActorSelfRef<Self> {
    const runtime = currentRuntimeForSelfRef();
    const descriptor = runtime.selfDescriptorOf(this);
    const ref: Record<string, unknown> = {};
    for (const actionName of metadataFor(this).actions.keys()) {
      Object.defineProperty(ref, actionName, {
        value: Object.freeze({
          runDetached: (...args: unknown[]) => runtime.runDetached(descriptor, actionName, args, immediateActorSchedule),
          schedule: (options: ActorScheduleOptions) => {
            const schedule = normalizeActorSchedule(options);
            return Object.freeze({
              runDetached: (...args: unknown[]) => runtime.runDetached(descriptor, actionName, args, schedule),
            });
          },
        }),
        enumerable: false,
        configurable: false,
      });
    }
    return Object.freeze(ref) as ActorSelfRef<Self>;
  }

  static spawn<T extends Actor<unknown, unknown>>(Type: ActorConstructor<T>, input: ActorInput<T>): Promise<ActorRef<T>>;
  static spawn<Type extends new (input: any) => Actor<any, any>>(
    Type: Type,
    input: ConstructorParameters<Type>[0],
  ): Promise<ActorRef<InstanceType<Type>>>;
  static spawn(
    Type: new (input: any) => Actor<any, any>,
    input: any,
  ): Promise<ActorRef<Actor<any, any>>> {
    return ActorRuntime.current("Actor.spawn").spawn(Type, input);
  }

  /**
   * Looks up the actor of `Type` named `key`. Prefer wrapping this in a static on the actor class
   * (`static ofId(id: string) { return Actor.ofNamed(Gathering, id); }`) and calling `Gathering.ofId(id)`,
   * so the key format stays with the actor.
   */
  static ofNamed<T extends Actor<unknown, unknown>>(Type: ActorConstructor<T>, key: string): ActorRefInit<T> {
    return ActorRuntime.current("Actor.ofNamed").named(Type, key);
  }

  static refreshValues<T extends Actor<unknown, unknown>>(ref: ActorRef<T> | ActorDescriptor): Promise<ActorRef<T>> {
    return ActorRuntime.current("Actor.refreshValues").refreshValues(ref);
  }

  static observeReads<Result>(work: () => Result, onRead: ActorReadObserver): Result {
    return ActorRuntime.observeReads(work, onRead);
  }
}
