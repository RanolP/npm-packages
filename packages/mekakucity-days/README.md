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

## Development scope

The runtime keeps all state in the current process. It implements transactions, rollback, detached delivery, actor collection, and snapshot caching, but it does not provide durable storage or distributed routing. Use a production `ActorRuntime` implementation when actors must survive process loss or run across hosts.
