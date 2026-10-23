import type { ActorDescriptor, ActorConstructor } from "../runtime/actor-runtime.js";
import { ActorRuntime } from "../runtime/actor-runtime.js";
import type { ActorInput, ActorRef, ActorRefInit } from "../ref/types.js";

export abstract class Actor<Self, Input> {
  protected readonly input: Input;
  declare protected readonly __actorInput: Input;

  constructor(input: Input) {
    this.input = input;
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

  static ofNamed<T extends Actor<unknown, unknown>>(Type: ActorConstructor<T>, key: string): ActorRefInit<T> {
    return ActorRuntime.current("Actor.ofNamed").named(Type, key);
  }

  static refreshValues<T extends Actor<unknown, unknown>>(ref: ActorRef<T> | ActorDescriptor): Promise<ActorRef<T>> {
    return ActorRuntime.current("Actor.refreshValues").refreshValues(ref);
  }
}
