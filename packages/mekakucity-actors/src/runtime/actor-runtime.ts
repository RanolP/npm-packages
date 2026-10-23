import { AsyncLocalStorage } from "node:async_hooks";
import type { Actor } from "../core/actor.js";
import type { ActorInput, ActorRef, ActorRefInit } from "../ref/types.js";
import { NoActiveActorRuntimeError } from "./errors.js";

export type ActorConstructor<T extends Actor<unknown, unknown>> = new (input: ActorInput<T>) => T;

export interface ActorDescriptor {
  readonly type: string;
  readonly id: string;
}

const activeRuntime = new AsyncLocalStorage<ActorRuntime>();

export abstract class ActorRuntime {
  protected withActiveRuntime<Result>(work: () => Result): Result {
    return activeRuntime.run(this, work);
  }

  static current(operation: string): ActorRuntime {
    const runtime = activeRuntime.getStore();
    if (!runtime) throw new NoActiveActorRuntimeError(operation);
    return runtime;
  }

  abstract run<Result>(work: () => Result | Promise<Result>): Promise<Awaited<Result>>;
  abstract spawn<T extends Actor<unknown, unknown>>(Type: ActorConstructor<T>, input: ActorInput<T>): Promise<ActorRef<T>>;
  abstract named<T extends Actor<unknown, unknown>>(Type: ActorConstructor<T>, key: string): ActorRefInit<T>;
  abstract refreshValues<T extends Actor<unknown, unknown>>(ref: ActorRef<T> | ActorDescriptor): Promise<ActorRef<T>>;
  abstract invokeRefAction(ref: ActorDescriptor, actionName: string, args: unknown[]): Promise<unknown>;
  abstract invokeLocalAction(instance: object, actionName: string, args: unknown[], run: () => unknown): unknown;
  abstract runDetached(ref: ActorDescriptor, actionName: string, args: unknown[]): void;
  abstract readSnapshotValue(ref: ActorDescriptor, key: string): unknown;
  abstract defer(method: Function, args: unknown[]): void;
}
