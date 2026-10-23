import { Cause, Data, Effect, Exit } from "effect"
import {
  Actor,
  ActorKilledError as CoreActorKilledError,
  NoActiveActorRuntimeError as CoreNoActiveActorRuntimeError,
  ActorReentrancyError as CoreActorReentrancyError,
  ActorResultSerializationError as CoreActorResultSerializationError,
  ActorRuntimeError as CoreActorRuntimeError,
  ActorSnapshotUnavailableError as CoreActorSnapshotUnavailableError,
  ActorStateSerializationError as CoreActorStateSerializationError,
  NoActiveTransactionError as CoreNoActiveTransactionError,
} from "../index.js"
import type { ActorRef, ActorRefInit } from "../index.js"
import type { ActorInput, ActorRefAction, Cloneable } from "../ref/types.js"
import type { ActorRuntime } from "../runtime/actor-runtime.js"

export class ActorRuntimeError extends Data.TaggedError("ActorRuntimeError")<{
  readonly cause: CoreActorRuntimeError
  readonly message: string
}> {}

export class NoActiveTransactionError extends Data.TaggedError("NoActiveTransactionError")<{
  readonly cause: CoreNoActiveTransactionError
  readonly message: string
}> {}

export class NoActiveActorRuntimeError extends Data.TaggedError("NoActiveActorRuntimeError")<{
  readonly cause: CoreNoActiveActorRuntimeError
  readonly message: string
}> {}

export class ActorStateSerializationError extends Data.TaggedError("ActorStateSerializationError")<{
  readonly cause: CoreActorStateSerializationError
  readonly message: string
}> {}

export class ActorResultSerializationError extends Data.TaggedError("ActorResultSerializationError")<{
  readonly cause: CoreActorResultSerializationError
  readonly message: string
}> {}

export class ActorReentrancyError extends Data.TaggedError("ActorReentrancyError")<{
  readonly cause: CoreActorReentrancyError
  readonly message: string
}> {}

export class ActorKilledError extends Data.TaggedError("ActorKilledError")<{
  readonly cause: CoreActorKilledError
  readonly message: string
}> {}

export class ActorSnapshotUnavailableError extends Data.TaggedError("ActorSnapshotUnavailableError")<{
  readonly cause: CoreActorSnapshotUnavailableError
  readonly message: string
}> {}

export class UnknownActionError extends Data.TaggedError("UnknownActionError")<{
  readonly cause: unknown
  readonly message: string
}> {}

export type ActorError =
  | ActorRuntimeError
  | NoActiveActorRuntimeError
  | NoActiveTransactionError
  | ActorStateSerializationError
  | ActorResultSerializationError
  | ActorReentrancyError
  | ActorKilledError
  | ActorSnapshotUnavailableError

export type ActorEffectError = ActorError | UnknownActionError

type ActorClass<T extends Actor<T, unknown>> = new (input: ActorInput<T>) => T
type ActionKey<T> = {
  [Key in keyof T]-?: T[Key] extends (...args: never[]) => unknown
    ? ActorRefAction<T, Key> extends never ? never : Key
    : never
}[keyof T] & keyof ActorRef<T> & string
type ActionArgs<T, Key extends ActionKey<T>> = ActorRefAction<T, Key> extends (...args: never[]) => unknown
  ? Parameters<ActorRefAction<T, Key>>
  : never
type ActionValue<T, Key extends ActionKey<T>> = ActorRefAction<T, Key> extends (...args: never[]) => Promise<infer Value>
  ? unknown extends Value ? Cloneable : Value
  : never

export interface NamedActorEffect<T extends Actor<T, unknown>> {
  orSpawn(factory: () => ActorInput<T> | Promise<ActorInput<T>>): Effect.Effect<ActorRef<T>, ActorEffectError>
  orNull(): Effect.Effect<ActorRef<T> | null, ActorEffectError>
}

class EffectBodyFailure<E> {
  constructor(readonly error: E) {}
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function toActorEffectError(cause: unknown): ActorEffectError {
  if (cause instanceof CoreNoActiveActorRuntimeError) {
    return new NoActiveActorRuntimeError({ cause, message: cause.message })
  }
  if (cause instanceof CoreActorResultSerializationError) {
    return new ActorResultSerializationError({ cause, message: cause.message })
  }
  if (cause instanceof CoreNoActiveTransactionError) {
    return new NoActiveTransactionError({ cause, message: cause.message })
  }
  if (cause instanceof CoreActorStateSerializationError) {
    return new ActorStateSerializationError({ cause, message: cause.message })
  }
  if (cause instanceof CoreActorReentrancyError) {
    return new ActorReentrancyError({ cause, message: cause.message })
  }
  if (cause instanceof CoreActorKilledError) {
    return new ActorKilledError({ cause, message: cause.message })
  }
  if (cause instanceof CoreActorSnapshotUnavailableError) {
    return new ActorSnapshotUnavailableError({ cause, message: cause.message })
  }
  if (cause instanceof CoreActorRuntimeError) {
    return new ActorRuntimeError({ cause, message: cause.message })
  }
  return new UnknownActionError({ cause, message: `Actor action failed: ${describeCause(cause)}` })
}

function tryActorPromise<A>(run: () => PromiseLike<A>): Effect.Effect<A, ActorEffectError> {
  return Effect.tryPromise({ try: () => run(), catch: toActorEffectError })
}

function actionOf<T, Key extends ActionKey<T>>(
  ref: ActorRef<T>,
  key: Key,
): ActorRefAction<T, Key> {
  return ref[key] as ActorRefAction<T, Key>
}

/** Interruption detaches the waiting fiber; the Promise-based core action keeps running. */
function call<T, Key extends ActionKey<T>>(
  ref: ActorRef<T>,
  action: Key,
  ...args: ActionArgs<T, Key>
): Effect.Effect<ActionValue<T, Key>, ActorEffectError> {
  const invoke = actionOf(ref, action)
  return tryActorPromise<ActionValue<T, Key>>(() => invoke(...args) as Promise<ActionValue<T, Key>>)
}

function spawn<T extends Actor<T, unknown>>(
  Type: ActorClass<T>,
  input: ActorInput<T>,
): Effect.Effect<ActorRef<T>, ActorEffectError> {
  return tryActorPromise(() => Actor.spawn(Type, input))
}

function named<T extends Actor<T, unknown>>(Type: ActorClass<T>, key: string): NamedActorEffect<T> {
  return {
    orSpawn: (factory) => tryActorPromise(() => Actor.ofNamed(Type, key).orSpawn(factory)),
    orNull: () => tryActorPromise(() => Actor.ofNamed(Type, key).orNull()),
  }
}

function refreshValues<T extends Actor<T, unknown>>(
  ref: ActorRef<T>,
): Effect.Effect<ActorRef<T>, ActorEffectError> {
  return tryActorPromise(() => Actor.refreshValues(ref))
}

function runDetached<T, Key extends ActionKey<T>>(
  ref: ActorRef<T>,
  action: Key,
  ...args: ActionArgs<T, Key>
): Effect.Effect<void, ActorEffectError> {
  const invoke = actionOf(ref, action)
  return tryActorPromise(() => {
    invoke.runDetached(...args)
    return Promise.resolve()
  })
}

function run<A, E, R>(runtime: ActorRuntime, program: Effect.Effect<A, E, R>): Effect.Effect<A, E | ActorEffectError, R> {
  return Effect.context<R>().pipe(
    Effect.flatMap((context) => Effect.tryPromise({
      try: () => runtime.run(async () => {
        const exit = await Effect.runPromiseExitWith(context)(program)
        if (Exit.isSuccess(exit)) return exit.value
        const failure = exit.cause.reasons.find(Cause.isFailReason)
        if (failure) throw new EffectBodyFailure(failure.error)
        throw new UnknownActionError({ cause: exit.cause, message: "Effect runtime body failed without a typed error" })
      }),
      catch: (cause) => {
        return cause instanceof EffectBodyFailure ? cause.error : toActorEffectError(cause)
      },
    })),
  )
}

export const ActorEffect = {
  call,
  spawn,
  named,
  refreshValues,
  runDetached,
  run,
} as const

export type { ActorRef, ActorRefInit }
