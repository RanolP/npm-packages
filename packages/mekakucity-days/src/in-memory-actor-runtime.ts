import {
  Actor,
  ActorContextUnavailableError,
  ActorRuntime,
  ActorRuntimeError,
  ActorSelfRefUnavailableError,
  NoActiveTransactionError,
  type ActorConstructor,
  type ActorContext,
  type ActorContextProvider,
  type ActorDescriptor,
  type ActorDetachedSchedule,
  type ActorInput,
  type ActorRef,
} from "@mekakucity/actors";
import { actorClassOrThrow, restoreState, socketJsonValue } from "@mekakucity/actors/runtime";
import { applyReply, invokeActorAction, invokeRefAction } from "./action/invoke.js";
import { invokeLocal } from "./action/nested.js";
import { dispatchDetached, enqueueDetached } from "./outbox/runtime.js";
import { resolveNamedActor, spawnActor } from "./ref/creation.js";
import { hydrateRefs, refreshActorValues, typeName } from "./ref/surface.js";
import { InMemoryStore, type ActorRecord } from "./ref/in-memory-store.js";
import { createRuntimeMemory, type RuntimeMemory } from "./runtime/memory.js";
import { readSnapshotValue, snapshotVersion } from "./state/snapshot.js";
import { inMemoryActorRuntimeTestHooks, type InMemoryActorRuntimeTestHooks } from "./testing.js";
import { currentExecution } from "./transaction/context.js";
import { finishRoot, newRoot, runTransaction } from "./transaction/root.js";
import type { DueOutboxMessage } from "./outbox/message.js";
import { socketRead, socketRuntime, type SocketRuntime, type SocketValue } from "./socket-internal.js";

interface FrozenDelivery {
  readonly message: Omit<DueOutboxMessage, "dueAt">;
  readonly remainingMs: number;
}

/** frozen: forked at least once; holds pending deliveries as time remaining until due, handed to every fork. */
type RuntimePhase =
  | { readonly kind: "live" }
  | { readonly kind: "frozen"; readonly deliveries: readonly FrozenDelivery[] }
  | { readonly kind: "disposed" };

const DELIVERY_TICK_MS = 60_000;

interface PendingDelivery {
  readonly message: DueOutboxMessage;
  readonly sequence: number;
  timeout?: ReturnType<typeof setTimeout>;
}

export class InMemoryActorRuntime extends ActorRuntime implements Disposable, AsyncDisposable, SocketRuntime {
  readonly #options: InMemoryActorRuntimeOptions;
  #memory: RuntimeMemory;
  readonly #pendingDeliveries: PendingDelivery[] = [];
  readonly #deliveryTails = new Map<string, Promise<void>>();
  #deliverySequence = 0;
  #deliveryInterval: ReturnType<typeof setInterval> | undefined;
  #activeTransactions = 0;
  #phase: RuntimePhase = { kind: "live" };

  constructor(options: InMemoryActorRuntimeOptions = {}) {
    super();
    this.#options = options;
    this.#memory = this.#createMemory(new InMemoryStore());
  }

  #createMemory(backend: InMemoryStore): RuntimeMemory {
    const memory = createRuntimeMemory(
      this.#options.contextProvider,
      (info) => this.emitCommit(info),
      (work) => this.withoutReadObservers(work),
      backend,
    );
    backend.setDeliveryHandler((message) => this.withoutReadObservers(() => {
      this.#schedule(message);
      return Promise.resolve();
    }));
    return memory;
  }

  /**
   * Child runtime that starts as this runtime's committed state ("fork then drop modified"). The child copies
   * an actor only when it first routes to it, like a Durable Object cold load: the constructor runs again on
   * a structured clone of the spawn input, then restoreState applies the committed state. Named bindings and
   * id counters carry over; new spawns and writes stay in the child.
   *
   * The first fork freezes this runtime: its pending detached deliveries stop here and every fork receives
   * a copy, due after the time that was remaining. Later run/spawn/resolve on this runtime throw.
   * Throws while a transaction or detached delivery is in flight.
   */
  fork(): InMemoryActorRuntime {
    if (this.#phase.kind === "disposed") throw new ActorRuntimeError("Cannot fork a disposed InMemoryActorRuntime");
    if (this.#activeTransactions > 0) {
      throw new ActorRuntimeError("Cannot fork InMemoryActorRuntime while a transaction is in flight; await run() first");
    }
    if (this.#deliveryTails.size > 0) {
      throw new ActorRuntimeError("Cannot fork InMemoryActorRuntime while a detached delivery is in flight");
    }
    const deliveries = this.#freeze();
    const child = new InMemoryActorRuntime(this.#options);
    const memory = child.#createMemory(new InMemoryStore(this.#memory.backend, (record) => child.#copyRecord(record)));
    child.#memory = memory;
    for (const [type, Type] of this.#memory.knownTypes) memory.knownTypes.set(type, Type);
    Object.assign(memory.sequence, this.#memory.sequence);
    const now = Date.now();
    for (const { message, remainingMs } of deliveries) {
      child.#schedule({ ...structuredClone(message), dueAt: now + remainingMs });
    }
    return child;
  }

  #freeze(): readonly FrozenDelivery[] {
    if (this.#phase.kind === "frozen") return this.#phase.deliveries;
    const now = Date.now();
    const deliveries = this.#pendingDeliveries.map(({ message: { dueAt, ...message } }) => ({
      message,
      remainingMs: dueAt - now,
    }));
    this.#phase = { kind: "frozen", deliveries };
    this.#stopDeliveries();
    return deliveries;
  }

  #copyRecord(base: ActorRecord): ActorRecord {
    if ("unclonable" in base.input) {
      throw new ActorRuntimeError(
        `Cannot copy actor ${base.id} (${base.type}) into a fork: its spawn input is not structuredClone-serializable`,
        { cause: base.input.unclonable },
      );
    }
    const memory = this.#memory;
    const Type = actorClassOrThrow(base.type);
    memory.knownTypes.set(base.type, Type);
    const input = base.input.value;
    const instance = this.withActiveRuntime(() => new Type(hydrateRefs(memory, structuredClone(input))));
    const record: ActorRecord = {
      id: base.id,
      type: base.type,
      input: base.input,
      instance,
      mailbox: { tail: Promise.resolve() },
      holders: new Set(base.holders),
      heldRefs: new Set(base.heldRefs),
      version: base.version,
      snapshot: structuredClone(base.snapshot),
      killed: false,
    };
    memory.instanceIds.set(instance, base.id);
    restoreState(record, structuredClone(base.snapshot), (value) => hydrateRefs(memory, value));
    return record;
  }

  /**
   * Stops delivery timers and drops deliveries not yet started, including a frozen runtime's copies for
   * future forks; later run/spawn/resolve/fork throw. A delivery already dispatching runs to completion;
   * await [Symbol.asyncDispose]() to wait for it. Existing forks of this runtime keep working.
   */
  [Symbol.dispose](): void {
    this.#phase = { kind: "disposed" };
    this.#stopDeliveries();
  }

  /** [Symbol.dispose](), then waits for deliveries already dispatching to settle. */
  async [Symbol.asyncDispose](): Promise<void> {
    this[Symbol.dispose]();
    await Promise.allSettled(this.#deliveryTails.values());
  }

  #stopDeliveries(): void {
    if (this.#deliveryInterval !== undefined) clearInterval(this.#deliveryInterval);
    this.#deliveryInterval = undefined;
    for (const delivery of this.#pendingDeliveries.splice(0)) {
      if (delivery.timeout !== undefined) clearTimeout(delivery.timeout);
    }
  }

  #assertUsable(operation: string): void {
    switch (this.#phase.kind) {
      case "live":
        return;
      case "frozen":
        throw new ActorRuntimeError(`Cannot ${operation} on an InMemoryActorRuntime that was forked and is frozen; use a fork`);
      case "disposed":
        throw new ActorRuntimeError(`Cannot ${operation} on a disposed InMemoryActorRuntime`);
    }
  }

  #schedule(message: DueOutboxMessage): void {
    if (this.#phase.kind !== "live") return;
    this.#pendingDeliveries.push({ message, sequence: ++this.#deliverySequence });
    this.#pendingDeliveries.sort((left, right) =>
      left.message.dueAt - right.message.dueAt || left.sequence - right.sequence);
    this.#startDeliveryInterval();
    this.#tickDeliveries();
  }

  #startDeliveryInterval(): void {
    if (this.#deliveryInterval !== undefined || this.#pendingDeliveries.length === 0) return;
    this.#deliveryInterval = setInterval(() => this.withoutReadObservers(() => this.#tickDeliveries()), DELIVERY_TICK_MS);
    this.#deliveryInterval.unref();
  }

  #tickDeliveries(): void {
    if (this.#pendingDeliveries.length === 0 || this.#phase.kind !== "live") {
      if (this.#deliveryInterval !== undefined) clearInterval(this.#deliveryInterval);
      this.#deliveryInterval = undefined;
      return;
    }
    const now = Date.now();
    for (const delivery of this.#pendingDeliveries) {
      const wait = delivery.message.dueAt - now;
      if (wait > DELIVERY_TICK_MS) break;
      if (delivery.timeout !== undefined) continue;
      delivery.timeout = setTimeout(() => this.withoutReadObservers(() => {
        delivery.timeout = undefined;
        this.#drainDeliveries();
      }), Math.max(0, wait));
      delivery.timeout.unref();
    }
  }

  #drainDeliveries(): void {
    for (let next = this.#pendingDeliveries[0]; next?.message.dueAt <= Date.now(); next = this.#pendingDeliveries[0]) {
      this.#pendingDeliveries.shift();
      if (next.timeout !== undefined) clearTimeout(next.timeout);
      const targetId = next.message.target.id;
      const previous = this.#deliveryTails.get(targetId) ?? Promise.resolve();
      // A delivery queued behind another on this target may start after dispose; it must not dispatch then.
      const run = () => this.#phase.kind === "disposed"
        ? undefined
        : this.withActiveRuntime(() => dispatchDetached(this.#memory, next.message));
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
    this.#assertUsable("run");
    this.#activeTransactions += 1;
    return this.withActiveRuntime(() => runTransaction(this.#memory, work))
      .finally(() => { this.#activeTransactions -= 1; });
  }

  spawn<T extends Actor<unknown, unknown>>(
    Type: ActorConstructor<T>,
    input: ActorInput<T>,
    key?: string,
  ): Promise<ActorRef<T>> {
    this.#assertUsable("spawn");
    return spawnActor(this.#memory, Type, input, key);
  }

  resolve<T extends Actor<unknown, unknown>>(
    Type: ActorConstructor<T>,
    key: string,
  ): Promise<ActorRef<T> | null> {
    this.#assertUsable("resolve");
    return resolveNamedActor(this.#memory, Type, key);
  }

  async refreshValues<T extends Actor<unknown, unknown>>(ref: ActorRef<T> | ActorDescriptor): Promise<ActorRef<T>> {
    const { ref: refreshed, version } = await refreshActorValues(this.#memory, ref);
    this.observeRead(refreshed, version);
    return refreshed;
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

  registerEvent(instance: object, name: string, payload: unknown): void {
    const actor = this.selfDescriptorOf(instance);
    const context = currentExecution(this.#memory, "Emit actor event");
    if (!context.frame) throw new NoActiveTransactionError("Emit actor event outside its owning actor");
    context.frame.invocation.afterCommitBestEffort(() => this.emitEvent({ actor, name, payload }));
  }

  async [socketRuntime](
    actor: ActorDescriptor,
    actionName: string,
    args: unknown[],
    carried: unknown,
  ): Promise<unknown> {
    this.#assertUsable("receive a socket call");
    this.#activeTransactions += 1;
    return this.withActiveRuntime(async () => {
      const root = newRoot(this.#memory);
      try {
        const reply = await this.#memory.execution.run({ root, chain: new Set() }, () => invokeActorAction(
          this.#memory,
          root,
          actor.id,
          actionName,
          args,
          undefined,
          new Set(),
          snapshotVersion(this.#memory, actor.id),
          carried,
          undefined,
          (value) => value === undefined
            ? undefined
            : socketJsonValue(value, `Actor socket action ${actionName} result`),
        ));
        await applyReply(this.#memory, reply, actor.id);
        await finishRoot(this.#memory, root, true);
        this.observeRead(actor, reply.version);
        return reply.value;
      } catch (error) {
        await finishRoot(this.#memory, root, false);
        throw error;
      }
    }).finally(() => { this.#activeTransactions -= 1; });
  }

  async [socketRead](actor: ActorDescriptor, key: string): Promise<SocketValue> {
    return this.run(async () => {
      const { ref, version } = await refreshActorValues(this.#memory, actor);
      const value = (ref as ActorDescriptor & Record<string, unknown>)[key];
      return { value: structuredClone(value), version };
    });
  }

  async invokeRefAction(ref: ActorDescriptor, actionName: string, args: unknown[]): Promise<unknown> {
    const { value, version } = await invokeRefAction(this.#memory, ref, actionName, args);
    this.observeRead(ref, version);
    return value;
  }

  invokeLocalAction(instance: object, actionName: string, args: unknown[], run: () => unknown): unknown {
    return invokeLocal(this.#memory, instance, actionName, args, run);
  }

  runDetached(ref: ActorDescriptor, actionName: string, args: unknown[], schedule: ActorDetachedSchedule): void {
    enqueueDetached(this.#memory, ref, actionName, args, schedule);
  }

  readSnapshotValue(ref: ActorDescriptor, key: string): unknown {
    const value = readSnapshotValue(this.#memory, ref, key);
    this.#observeRef(ref, key);
    return value;
  }

  #observeRef(ref: ActorDescriptor, key: string): void {
    const snapshot = this.#memory.snapshotCache.get(ref.id);
    this.observeRead(ref, snapshot?.data ? snapshot.version : undefined, key);
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
