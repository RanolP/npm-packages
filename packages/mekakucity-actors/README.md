# @mekakucity/actors

`@mekakucity/actors` is an in-process actor library for TypeScript. Actors serialize action execution, expose immutable state snapshots through typed references, and roll back registered compensations when a transaction fails.

## Install

```sh
pnpm add @mekakucity/actors
```

The core package does not require Effect. Install the optional peer dependency when importing the `@mekakucity/actors/effect` subpath:

```sh
pnpm add effect
```

## Create and call an actor

Define mutable state with `@state` and callable asynchronous methods with `@action`. Actor operations run inside `Actor.transaction`.

```ts
import { Actor, action, defer, state, type ActorRef } from "@mekakucity/actors";

class Counter extends Actor<Counter, { initial: number }> {
  @state accessor value = this.input.initial;

  @action async add(amount: number): Promise<number> {
    const previous = this.value;
    defer(this.restore, previous);
    this.value += amount;
    return this.value;
  }

  @action async restore(value: number): Promise<void> {
    this.value = value;
  }
}

await Actor.transaction(async () => {
  const counter: ActorRef<Counter> = await Actor.spawn(Counter, { initial: 0 });

  await counter.add(2);
  console.log(counter.value); // 2
});
```

`Actor.spawn` returns an `ActorRef`, not the actor instance. The reference exposes decorated asynchronous actions and read-only state snapshots. `defer` registers a decorated action as compensation; if the surrounding transaction fails, compensations run in reverse registration order.

## Known limitations

- `ActorEffect.call` widens a generic action method's parameter and result types to the generic bound.
- An action that declares an explicit `this` parameter keeps only its last overload and loses its generic type parameters on `ActorRef`.
- An asynchronous method without `@action` is indistinguishable from an action at the type level, so it appears on `ActorRef` even though the runtime has not registered it as an action.
