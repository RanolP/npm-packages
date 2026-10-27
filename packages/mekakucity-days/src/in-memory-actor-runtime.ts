import {
  Actor,
  ActorContextUnavailableError,
  ActorRuntime,
  ActorSelfRefUnavailableError,
  type ActorConstructor,
  type ActorContext,
  type ActorContextProvider,
  type ActorDescriptor,
  type ActorDetachedSchedule,
  type ActorInput,
  type ActorRef,
  type ActorRefInit,
} from "@mekakucity/actors";
import { invokeRefAction } from "./action/invoke.js";
import { invokeLocal } from "./action/nested.js";
import { dispatchDetached, enqueueDetached } from "./outbox/runtime.js";
import { namedActor, spawnActor } from "./ref/creation.js";
import { refreshActorValues, typeName } from "./ref/surface.js";
import { createRuntimeMemory, type RuntimeMemory } from "./runtime/memory.js";
import { readSnapshotValue } from "./state/snapshot.js";
import { inMemoryActorRuntimeTestHooks, type InMemoryActorRuntimeTestHooks } from "./testing.js";
import { currentExecution } from "./transaction/context.js";
import { runTransaction } from "./transaction/root.js";
import type { DueOutboxMessage } from "./outbox/message.js";

const DELIVERY_TICK_MS = 60_000;

interface PendingDelivery {
  readonly message: DueOutboxMessage;
  readonly sequence: number;
  timeout?: ReturnType<typeof setTimeout>;
}

export class InMemoryActorRuntime extends ActorRuntime {
  readonly #memory: RuntimeMemory;
  readonly #pendingDeliveries: PendingDelivery[] = [];
  readonly #deliveryTails = new Map<string, Promise<void>>();
  #deliverySequence = 0;
  #deliveryInterval: ReturnType<typeof setInterval> | undefined;

  constructor(options: InMemoryActorRuntimeOptions = {}) {
    super();
    this.#memory = createRuntimeMemory(options.contextProvider);
    this.#memory.backend.setDeliveryHandler((message) => {
      this.#pendingDeliveries.push({ message, sequence: ++this.#deliverySequence });
      this.#pendingDeliveries.sort((left, right) =>
        left.message.dueAt - right.message.dueAt || left.sequence - right.sequence);
      this.#startDeliveryInterval();
      this.#tickDeliveries();
      return Promise.resolve();
    });
  }

  #startDeliveryInterval(): void {
    if (this.#deliveryInterval !== undefined || this.#pendingDeliveries.length === 0) return;
    this.#deliveryInterval = setInterval(() => this.#tickDeliveries(), DELIVERY_TICK_MS);
    this.#deliveryInterval.unref();
  }

  #tickDeliveries(): void {
    if (this.#pendingDeliveries.length === 0) {
      if (this.#deliveryInterval !== undefined) clearInterval(this.#deliveryInterval);
      this.#deliveryInterval = undefined;
      return;
    }
    const now = Date.now();
    for (const delivery of this.#pendingDeliveries) {
      const wait = delivery.message.dueAt - now;
      if (wait > DELIVERY_TICK_MS) break;
      if (delivery.timeout !== undefined) continue;
      delivery.timeout = setTimeout(() => {
        delivery.timeout = undefined;
        this.#drainDeliveries();
      }, Math.max(0, wait));
      delivery.timeout.unref();
    }
  }

  #drainDeliveries(): void {
    for (let next = this.#pendingDeliveries[0]; next?.message.dueAt <= Date.now(); next = this.#pendingDeliveries[0]) {
      this.#pendingDeliveries.shift();
      if (next.timeout !== undefined) clearTimeout(next.timeout);
      const targetId = next.message.target.id;
      const previous = this.#deliveryTails.get(targetId) ?? Promise.resolve();
      const run = () => this.withActiveRuntime(() => dispatchDetached(this.#memory, next.message));
      let tail: Promise<void>;
      tail = previous
        .then(run, run)
        .catch((error) => console.error(`InMemoryActorRuntime: detached dispatch to ${targetId} failed`, error))
        .finally(() => {
          if (this.#deliveryTails.get(targetId) === tail) this.#deliveryTails.delete(targetId);
        });
      this.#deliveryTails.set(targetId, tail);
    }
    this.#tickDeliveries();
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

  selfDescriptorOf(instance: object): ActorDescriptor {
    const id = this.#memory.instanceIds.get(instance);
    const context = currentExecution(this.#memory, "Read Actor.asRef");
    if (!id || !context.frame || context.frame.record.id !== id) throw new ActorSelfRefUnavailableError();
    return { type: typeName(instance.constructor), id };
  }

  actorContextOf(instance: object): ActorContext {
    const actorId = this.#memory.instanceIds.get(instance);
    const context = currentExecution(this.#memory, "Read Actor.ctx");
    if (!actorId || !context.frame || context.frame.record.id !== actorId) {
      throw new ActorContextUnavailableError();
    }
    return context.frame.invocation.get();
  }

  invokeRefAction(ref: ActorDescriptor, actionName: string, args: unknown[]): Promise<unknown> {
    return invokeRefAction(this.#memory, ref, actionName, args);
  }

  invokeLocalAction(instance: object, actionName: string, args: unknown[], run: () => unknown): unknown {
    return invokeLocal(this.#memory, instance, actionName, args, run);
  }

  runDetached(ref: ActorDescriptor, actionName: string, args: unknown[], schedule: ActorDetachedSchedule): void {
    enqueueDetached(this.#memory, ref, actionName, args, schedule);
  }

  readSnapshotValue(ref: ActorDescriptor, key: string): unknown {
    return readSnapshotValue(this.#memory, ref, key);
  }

  [inMemoryActorRuntimeTestHooks](): InMemoryActorRuntimeTestHooks {
    return {
      evictSnapshotCache: (ref) => this.#memory.snapshotCache.delete(ref.id),
      lastActionReply: () => this.#memory.lastReplyForTest,
    };
  }
}

export interface InMemoryActorRuntimeOptions {
  readonly contextProvider?: ActorContextProvider;
}
