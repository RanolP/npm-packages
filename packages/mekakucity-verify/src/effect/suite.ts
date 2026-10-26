import { Cause, Context, Effect, Exit } from "effect"
import { describe, expect } from "vitest"
import { action, Actor, actor, state } from "@mekakucity/actors"
import { ActorEffect, NoActiveActorRuntimeError } from "@mekakucity/actors/effect"
import type { ActorRef } from "@mekakucity/actors"
import type { ActorRuntime } from "@mekakucity/actors/runtime"
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
    @actor("verify/effect/EmptyActor")
    class EmptyActor extends Actor<EmptyActor, {}> {}
    const error = await Effect.runPromise(ActorEffect.spawn(EmptyActor, {}).pipe(
      Effect.catchTag("NoActiveActorRuntimeError", (cause) => Effect.succeed(cause)),
    ))
    expect(error).toBeInstanceOf(NoActiveActorRuntimeError)
    if (!(error instanceof NoActiveActorRuntimeError)) throw new Error("Expected a tagged runtime error")
    expect(error._tag).toBe("NoActiveActorRuntimeError")
  })

  it("runs actor effects inside the transaction's AsyncLocalStorage context", async (runtime) => {
    @actor("verify/effect/Counter")
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
    @actor("verify/effect/FailingActor")
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

  it("preserves a typed Effect failure from run", async (runtime) => {
    const originalFailure = new Error("typed body failure")
    const exit = await Effect.runPromiseExit(ActorEffect.run(runtime, Effect.fail(originalFailure)))
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) throw new Error("Expected a typed failure")
    const failure = exit.cause.reasons.find(Cause.isFailReason)
    expect(failure?.error).toBe(originalFailure)
  })

  it("maps core reentrancy errors to their matching Effect tag", async (runtime) => {
    interface BouncePeer {
      bounce(): Promise<void>
    }
    @actor("verify/effect/RingActor")
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
    @actor("verify/effect/SignalActor")
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
    expect(ref.type).toBe("verify/effect/SignalActor")
  })

  it("joins a same-runtime run that is already active", async (runtime) => {
    @actor("verify/effect/Counter#2")
    class Counter extends Actor<Counter, {}> {
      @state accessor value = 0
      @action async increment() { this.value += 1 }
    }
    await runtime.run(() => Actor.ofNamed(Counter, "nested-effect-run").orSpawn(() => ({})))
    const failure = new Error("fail outer run")
    await expect(runtime.run(async () => {
      const ref = await Actor.ofNamed(Counter, "nested-effect-run").orSpawn(() => ({}))
      await Effect.runPromise(ActorEffect.run(runtime, ActorEffect.call(ref, "increment")))
      throw failure
    })).rejects.toBe(failure)
    const committedValue = await runtime.run(async () => {
      const counter = await Actor.ofNamed(Counter, "nested-effect-run").orSpawn(() => ({}))
      return counter.value
    })
    expect(committedValue).toBe(1)
  })
  })
}
