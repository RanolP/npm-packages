# @mekakucity/days

`@mekakucity/days` provides `InMemoryActorRuntime`, a local development and test runtime for the `@mekakucity/actors` contract. It plays the same role for actors that workerd plays for Workers: a concrete local runtime, separate from the production platform.

## Install

Install the runtime with its peer contract.

```sh
pnpm add @mekakucity/actors @mekakucity/days
```

## Run actors in memory

Create a runtime and wrap the complete actor call chain with `runtime.run(...)`.

```ts
import { Actor, action, actor, state } from "@mekakucity/actors";
import { InMemoryActorRuntime } from "@mekakucity/days";

@actor("counter")
class Counter extends Actor<Counter, { initial: number }> {
  @state accessor value = this.input.initial;

  @action async increment(): Promise<number> {
    return ++this.value;
  }
}

const runtime = new InMemoryActorRuntime();

const value = await runtime.run(async () => {
  const counter = await Actor.spawn(Counter, { initial: 0 });
  return counter.increment();
});
```

Each `InMemoryActorRuntime` owns its actors, named actor bindings, mailboxes, snapshots, outbox, and reference lifecycle. Each `run` opens one transaction context; same-runtime nesting joins it, while another runtime remains isolated. Actor actions commit in segments, and a later failure does not restore segments that already committed. Create a fresh instance when a test needs isolated runtime state.

Scheduled detached messages use process timers. They remain pending only while the `InMemoryActorRuntime` process is running; restarting the process discards them.

## Fork a booted runtime

A test harness can boot an app once and give each test its own `runtime.fork()`.

```ts
const booted = new InMemoryActorRuntime({ contextProvider });
await boot(booted);

// Per test: starts from boot's committed state, independent of every other fork.
await using runtime = booted.fork();
```

A fork starts with no actors of its own. The first time it routes to an actor it does not have, it copies that actor from its parent like a Durable Object cold load: it constructs the actor from a structured clone of its spawn input, then applies the parent's last committed state and reference holders. Boot does not run again, but constructors and field initializers of the actors a test touches do. Named bindings and id counters carry over; new spawns, writes, and collections stay in the fork. A fork starts with an empty snapshot cache, so read a ref held in another actor's state through `Actor.refreshValues(ref)` first. Copying an actor whose spawn input `structuredClone` rejects throws.

The first `fork()` freezes the parent: its pending detached deliveries stop there, and `run`, `spawn`, and `resolve` on it throw. Each fork receives its own copy of those deliveries, due after the time each had left when the parent froze, counted from that fork's `fork()`. A frozen parent can be forked again. `fork()` throws while a `run` or a detached delivery is in flight.

`await runtime[Symbol.asyncDispose]()` (called by `await using`) stops a runtime's delivery timers, drops deliveries that have not started, waits for any delivery already running to settle, and makes later `run`, `spawn`, `resolve`, and `fork` throw. The synchronous `runtime[Symbol.dispose]()` (called by `using`) does the same without waiting, so a delivery already running can still finish after it returns. Forks of a disposed runtime keep working.

## Development scope

The runtime keeps all state in the current process. It implements transactions, rollback, detached delivery, actor collection, and snapshot caching, but it does not provide durable storage or distributed routing. Use a production `ActorRuntime` implementation when actors must survive process loss or run across hosts.
