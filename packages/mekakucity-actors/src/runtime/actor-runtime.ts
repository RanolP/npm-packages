import { AsyncLocalStorage } from "node:async_hooks";
import type { Actor } from "../core/actor.js";
import type { ActorInput, ActorRef } from "../ref/types.js";
import { ActorRuntimeError, NoActiveActorRuntimeError } from "./errors.js";
import type { ActorCommitInfo, ActorCommitListener, ActorContext } from "./actor-context.js";

export type ActorConstructor<T extends Actor<unknown, unknown>> = new (input: ActorInput<T>) => T;

export interface ActorDescriptor {
  readonly type: string;
  readonly id: string;
}

export interface ActorReadInfo {
  readonly actor: ActorDescriptor;
  readonly version: number | undefined;
  /** The `@state` field that was read; absent for a whole-actor read, which depends on every field. */
  readonly key?: string;
}

export type ActorReadObserver = (info: ActorReadInfo) => void;

export type ActorDetachedSchedule =
  | { readonly afterMs: number }
  | { readonly dueAt: number };

export const MAX_ACTOR_DUE_AT = 8_640_000_000_000_000;

export type PendingActorMessage<Message extends object> = Message & {
  readonly schedule: ActorDetachedSchedule;
  readonly dueAt?: never;
};

export type DueActorMessage<Message extends object> = Omit<PendingActorMessage<Message>, "schedule" | "dueAt"> & {
  readonly schedule?: never;
  readonly dueAt: number;
};

export const resolveDueAt = (schedule: ActorDetachedSchedule, committedAt: number): number => {
  const dueAt = "afterMs" in schedule ? committedAt + schedule.afterMs : schedule.dueAt;
  if (!Number.isFinite(dueAt) || Math.abs(dueAt) > MAX_ACTOR_DUE_AT) {
    throw new ActorRuntimeError("Detached message due time must be within the valid Date range");
  }
  return dueAt;
};

export const resolveActorMessage = <Message extends object>(
  message: PendingActorMessage<Message>,
  committedAt: number,
): DueActorMessage<Message> => {
  const { schedule, dueAt: _dueAt, ...pending } = message;
  return { ...pending, dueAt: resolveDueAt(schedule, committedAt) };
};

const activeRuntime = new AsyncLocalStorage<ActorRuntime>();
const activeReadObservers = new AsyncLocalStorage<readonly ActorReadObserver[]>();

export abstract class ActorRuntime {
  readonly #commitListeners = new Set<ActorCommitListener>();

  protected withActiveRuntime<Result>(work: () => Result): Result {
    return activeRuntime.run(this, work);
  }

  static current(operation: string): ActorRuntime {
    const runtime = activeRuntime.getStore();
    if (!runtime) throw new NoActiveActorRuntimeError(operation);
    return runtime;
  }

  static observeReads<Result>(work: () => Result, onRead: ActorReadObserver): Result {
    const observers = [...(activeReadObservers.getStore() ?? []), onRead];
    return activeReadObservers.run(observers, work);
  }

  protected withoutReadObservers<Result>(work: () => Result): Result {
    return activeReadObservers.exit(work);
  }

  protected observeRead(actor: ActorDescriptor, version: number | undefined, key?: string): void {
    const descriptor = { type: actor.type, id: actor.id };
    const info: ActorReadInfo = key === undefined ? { actor: descriptor, version } : { actor: descriptor, version, key };
    for (const observer of activeReadObservers.getStore() ?? []) observer(info);
  }

  /**
   * Subscribes to versions persisted by actors hosted in this runtime's isolate.
   * Invocation is synchronous, best-effort, and at most once. Returned promises are not awaited.
   * Listener throws and rejections do not fail the action.
   */
  onCommit(listener: ActorCommitListener): () => void {
    this.#commitListeners.add(listener);
    return () => this.#commitListeners.delete(listener);
  }

  protected emitCommit(info: ActorCommitInfo): void {
    for (const listener of this.#commitListeners) {
      try {
        const result: unknown = listener(info);
        if (result instanceof Promise) result.catch(() => {});
      } catch {
        // Commit listeners observe persisted state and cannot roll it back.
      }
    }
  }

  abstract run<Result>(work: () => Result | Promise<Result>): Promise<Awaited<Result>>;
  abstract spawn<T extends Actor<unknown, unknown>>(
    Type: ActorConstructor<T>,
    input: ActorInput<T>,
    key?: string,
  ): Promise<ActorRef<T>>;
  abstract resolve<T extends Actor<unknown, unknown>>(
    Type: ActorConstructor<T>,
    key: string,
  ): Promise<ActorRef<T> | null>;
  abstract refreshValues<T extends Actor<unknown, unknown>>(ref: ActorRef<T> | ActorDescriptor): Promise<ActorRef<T>>;
  abstract selfDescriptorOf(instance: object): ActorDescriptor;
  abstract actorContextOf(instance: object): ActorContext;
  abstract invokeRefAction(ref: ActorDescriptor, actionName: string, args: unknown[]): Promise<unknown>;
  abstract invokeLocalAction(instance: object, actionName: string, args: unknown[], run: () => unknown): unknown;
  abstract runDetached(
    ref: ActorDescriptor,
    actionName: string,
    args: unknown[],
    schedule: ActorDetachedSchedule,
  ): void;
  abstract readSnapshotValue(ref: ActorDescriptor, key: string): unknown;
}
