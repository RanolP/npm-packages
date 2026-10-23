import { Context, Effect } from "effect"
import { describe, expect } from "vitest"
import { action, Actor, defer, state } from "../../index.js"
import { ActorCompensationFailed, ActorEffect, NoActiveActorRuntimeError } from "../../effect/index.js"
import type { ActorRef } from "../../ref/types.js"
import type { ActorRuntime } from "../../runtime/actor-runtime.js"
import { createRuntimeTestTools } from "../runtime.js"

interface PrefixService {
  readonly value: string
}

const Prefix = Context.Service<PrefixService>("PrefixService")

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done; })
  return { promise, resolve }
}

export const effectSuite = (factory: () => ActorRuntime): void => {
  const { it, itOutsideRuntime } = createRuntimeTestTools(factory)
  describe("@mekakucity/actors/effect", () => {
  itOutsideRuntime("maps a missing runtime to its matching Effect tag", async () => {
    class EmptyActor extends Actor<EmptyActor, {}> {}
    const error = await Effect.runPromise(ActorEffect.spawn(EmptyActor, {}).pipe(
      Effect.catchTag("NoActiveActorRuntimeError", (cause) => Effect.succeed(cause)),
    ))
    expect(error).toBeInstanceOf(NoActiveActorRuntimeError)
    if (!(error instanceof NoActiveActorRuntimeError)) throw new Error("Expected a tagged runtime error")
    expect(error._tag).toBe("NoActiveActorRuntimeError")
  })

  it("runs actor effects inside the transaction's AsyncLocalStorage context", async (runtime) => {
    class Counter extends Actor<Counter, { value: number }> {
      @state accessor value = this.input.value
      @action async add(amount: number) {
        this.value += amount
        return this.value
      }
    }

    const program = Effect.gen(function*() {
      const prefix = yield* Prefix
      const ref = yield* ActorEffect.spawn(Counter, { value: 2 })
      const value = yield* ActorEffect.call(ref, "add", 3)
      yield* ActorEffect.refreshValues(ref)
      return `${prefix.value}:${value}:${ref.value}`
    })

    const result = await Effect.runPromise(
      ActorEffect.run(runtime, program).pipe(Effect.provideService(Prefix, { value: "count" })),
    )
    expect(result).toBe("count:5:5")
  })

  it("maps unknown action failures to a catchable tagged error with the original cause", async (runtime) => {
    class FailingActor extends Actor<FailingActor, {}> {
      @action async fail() { throw "user failure"; }
    }

    const cause = await Effect.runPromise(ActorEffect.run(runtime,
      Effect.gen(function*() {
        const ref = yield* ActorEffect.spawn(FailingActor, {})
        return yield* ActorEffect.call(ref, "fail").pipe(
          Effect.catchTag("UnknownActionError", (error) => Effect.succeed(error.cause)),
        )
      }),
    ))
    expect(cause).toBe("user failure")
  })

  it("maps compensation failures to a tagged error with compensation errors and the original cause", async (runtime) => {
    const originalFailure = new Error("action failed")
    const compensationFailure = new Error("undo failed")
    class CompensatingActor extends Actor<CompensatingActor, {}> {
      @action async run() {
        defer(this.undo)
        throw originalFailure
      }
      @action async undo() { throw compensationFailure }
    }

    const failure = await Effect.runPromise(ActorEffect.run(runtime,
      Effect.gen(function*() {
        const ref = yield* ActorEffect.spawn(CompensatingActor, {})
        return yield* ActorEffect.call(ref, "run").pipe(
          Effect.catchTag("ActorCompensationFailed", (error) => Effect.succeed(error)),
        )
      }),
    ))

    expect(failure).toBeInstanceOf(ActorCompensationFailed)
    if (!(failure instanceof ActorCompensationFailed)) throw new Error("Expected ActorCompensationFailed")
    expect(failure._tag).toBe("ActorCompensationFailed")
    expect(failure.errors).toEqual([compensationFailure])
    expect(failure.cause.cause).toBe(originalFailure)
  })

  it("preserves a typed Effect failure when a root compensation also fails", async (runtime) => {
    const originalFailure = new Error("typed body failure")
    const compensationFailure = new Error("root undo failed")
    class RootCompensator extends Actor<RootCompensator, {}> {
      @action async register() { defer(this.undo) }
      @action async undo() { throw compensationFailure }
    }

    const failure = await Effect.runPromise(ActorEffect.run(runtime,
      Effect.gen(function*() {
        const ref = yield* ActorEffect.spawn(RootCompensator, {})
        yield* ActorEffect.call(ref, "register")
        return yield* Effect.fail(originalFailure)
      }),
    ).pipe(Effect.catchTag("ActorCompensationFailed", (error) => Effect.succeed(error))))

    expect(failure).toBeInstanceOf(ActorCompensationFailed)
    if (!(failure instanceof ActorCompensationFailed)) throw new Error("Expected ActorCompensationFailed")
    expect(failure.errors).toEqual([compensationFailure])
    expect(failure.cause.cause).toBe(originalFailure)
  })

  it("maps core reentrancy errors to their matching Effect tag", async (runtime) => {
    interface BouncePeer {
      bounce(): Promise<void>
    }
    class RingActor extends Actor<RingActor, { peer?: ActorRef<BouncePeer> }> {
      @state accessor peer: ActorRef<BouncePeer> | null = this.input.peer ?? null
      @action async bounce(): Promise<void> {
        if (this.peer) await this.peer.bounce()
      }
      @action async setPeer(peer: ActorRef<BouncePeer>) { this.peer = peer; }
    }

    const caught = await Effect.runPromise(ActorEffect.run(runtime,
      Effect.gen(function*() {
        const first = yield* ActorEffect.spawn(RingActor, {})
        const second = yield* ActorEffect.spawn(RingActor, { peer: first })
        const linked = yield* ActorEffect.spawn(RingActor, { peer: second })
        yield* ActorEffect.call(first, "setPeer", linked)
        return yield* ActorEffect.call(linked, "bounce").pipe(
          Effect.catchTag("ActorReentrancyError", () => Effect.succeed("caught")),
        )
      }),
    ))
    expect(caught).toBe("caught")
  })

  it("provides named lookup and detached delivery as effects", async (runtime) => {
    const delivered = deferred()
    class SignalActor extends Actor<SignalActor, {}> {
      @action async signal() { delivered.resolve(); }
    }

    const ref = await Effect.runPromise(ActorEffect.run(runtime,
      Effect.gen(function*() {
        const maybe = yield* ActorEffect.named(SignalActor, "effect-signal").orNull()
        expect(maybe).toBeNull()
        const named = yield* ActorEffect.named(SignalActor, "effect-signal").orSpawn(() => ({}))
        yield* ActorEffect.runDetached(named, "signal")
        return named
      }),
    ))
    await delivered.promise
    expect(ref.type).toBe("SignalActor")
  })

  it("joins a same-runtime run that is already active", async (runtime) => {
    class Counter extends Actor<Counter, {}> {
      @state accessor value = 0
      @action async increment() { defer(this.decrement); this.value += 1 }
      @action async decrement() { this.value -= 1 }
    }
    await runtime.run(() => Actor.ofNamed(Counter, "nested-effect-run").orSpawn(() => ({})))
    await expect(runtime.run(async () => {
      const ref = await Actor.ofNamed(Counter, "nested-effect-run").orSpawn(() => ({}))
      await Effect.runPromise(ActorEffect.run(runtime, ActorEffect.call(ref, "increment")))
      throw new Error("roll back outer run")
    })).rejects.toThrow("roll back outer run")
    const restoredValue = await runtime.run(async () => {
      const restored = await Actor.ofNamed(Counter, "nested-effect-run").orSpawn(() => ({}))
      return restored.value
    })
    expect(restoredValue).toBe(0)
  })
  })
}
