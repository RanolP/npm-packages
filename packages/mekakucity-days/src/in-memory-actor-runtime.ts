import {
  Actor,
  ActorRuntime,
  type ActorConstructor,
  type ActorDescriptor,
  type ActorInput,
  type ActorRef,
  type ActorRefInit,
} from "@mekakucity/actors";
import { invokeRefAction } from "./action/invoke.js";
import { invokeLocal } from "./action/nested.js";
import { registerDefer } from "./compensation/run.js";
import { dispatchDetached, enqueueDetached } from "./outbox/runtime.js";
import { namedActor, spawnActor } from "./ref/creation.js";
import { refreshActorValues } from "./ref/surface.js";
import { createRuntimeMemory } from "./runtime/memory.js";
import { readSnapshotValue } from "./state/snapshot.js";
import { inMemoryActorRuntimeTestHooks, type InMemoryActorRuntimeTestHooks } from "./testing.js";
import { runTransaction } from "./transaction/root.js";

export class InMemoryActorRuntime extends ActorRuntime {
  readonly #memory = createRuntimeMemory();

  constructor() {
    super();
    this.#memory.backend.setDeliveryHandler(async (message) => {
      void this.withActiveRuntime(() => dispatchDetached(this.#memory, message));
    });
  }

  run<Result>(work: () => Result | Promise<Result>): Promise<Awaited<Result>> {
    return this.withActiveRuntime(() => runTransaction(this.#memory, work));
  }

  spawn<T extends Actor<unknown, unknown>>(Type: ActorConstructor<T>, input: ActorInput<T>): Promise<ActorRef<T>> {
    return spawnActor(this.#memory, Type, input);
  }

  named<T extends Actor<unknown, unknown>>(Type: ActorConstructor<T>, key: string): ActorRefInit<T> {
    return namedActor(this.#memory, Type, key);
  }

  refreshValues<T extends Actor<unknown, unknown>>(ref: ActorRef<T> | ActorDescriptor): Promise<ActorRef<T>> {
    return refreshActorValues(this.#memory, ref);
  }

  invokeRefAction(ref: ActorDescriptor, actionName: string, args: unknown[]): Promise<unknown> {
    return invokeRefAction(this.#memory, ref, actionName, args);
  }

  invokeLocalAction(instance: object, actionName: string, args: unknown[], run: () => unknown): unknown {
    return invokeLocal(this.#memory, instance, actionName, args, run);
  }

  runDetached(ref: ActorDescriptor, actionName: string, args: unknown[]): void {
    enqueueDetached(this.#memory, ref, actionName, args);
  }

  readSnapshotValue(ref: ActorDescriptor, key: string): unknown {
    return readSnapshotValue(this.#memory, ref, key);
  }

  defer(method: Function, args: unknown[]): void {
    registerDefer(this.#memory, method, args);
  }

  [inMemoryActorRuntimeTestHooks](): InMemoryActorRuntimeTestHooks {
    return {
      evictSnapshotCache: (ref) => this.#memory.snapshotCache.delete(ref.id),
      lastActionReply: () => this.#memory.lastReplyForTest,
    };
  }
}
