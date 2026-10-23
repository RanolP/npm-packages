# @mekakucity/actors

`@mekakucity/actors` defines the runtime-independent contract for TypeScript actors. It provides the `Actor` base class, typed references, decorators, compensation, Effect integration, and the abstract `ActorRuntime` API. Applications choose a runtime explicitly and scope it with `runtime.run(...)`.

## Install the contract and a runtime

Install this package with a runtime implementation. `@mekakucity/days` is the in-memory runtime for local development and tests.

```sh
pnpm add @mekakucity/actors @mekakucity/days
```

The core package does not require Effect. Install the optional peer dependency when importing `@mekakucity/actors/effect`.

```sh
pnpm add effect
```

## Run actor operations inside a runtime

Create one runtime and establish its AsyncLocalStorage scope with `runtime.run(...)`. Actor operations also require an `Actor.transaction(...)`.

```ts
import { Actor, action, defer, state, type ActorRef } from "@mekakucity/actors";
import { InMemoryActorRuntime } from "@mekakucity/days";

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

const runtime = new InMemoryActorRuntime();

await runtime.run(() => Actor.transaction(async () => {
  const counter: ActorRef<Counter> = await Actor.spawn(Counter, { initial: 0 });
  await counter.add(2);
  console.log(counter.value); // 2
}));
```

`Actor.spawn` returns an `ActorRef`, not the actor instance. The reference exposes decorated asynchronous actions and read-only state snapshots. `defer` registers a decorated action as compensation; if the surrounding transaction fails, compensations run in reverse registration order.

Calling an actor API outside `runtime.run(...)` throws `NoActiveActorRuntimeError`. Calling an operation that needs a transaction outside `Actor.transaction(...)` throws `NoActiveTransactionError`.

## Implement a runtime

Import `ActorRuntime` from `@mekakucity/actors` or the runtime-author entry point `@mekakucity/actors/runtime`. The contract uses Node's `node:async_hooks` module to scope the active runtime. Implement these abstract members:

- `transaction(work)` creates or joins the runtime's transaction context.
- `spawn(Type, input)` creates an anonymous actor in the active transaction.
- `named(Type, key)` looks up or creates a named actor.
- `refreshValues(ref)` refreshes a reference's snapshot values.
- `invokeRefAction(ref, actionName, args)` sends an action through a reference.
- `invokeLocalAction(instance, actionName, args, run)` invokes a decorated action on its owning actor.
- `runDetached(ref, actionName, args)` registers detached delivery with the transaction.
- `readSnapshotValue(ref, key)` reads cached state or a derived value.
- `defer(method, args)` registers a compensation action.

The `@mekakucity/actors/runtime` entry point also exports storage-independent building blocks for runtime implementations:

| Domain | Exports |
| --- | --- |
| Actor metadata | `metadataFor`, `actionNameOf` |
| References | `createActorRef`, `isActorDescriptor`, `hydrateActorRefs`, `collectActorRefIds` |
| State cloning | `cloneOrThrow`, `assertCloneableResultPrototypes` |
| State snapshots | `stateFields`, `cloneState`, `restoreState`, `createSnapshot`, `changedStateFields`, `restoreSnapshotData`, `deepFreeze` |
| Compensation | `aggregateCompensationErrors` |
| Helper types | `ActorMetadata`, `ActorRefSurface`, `ActorRefHydration`, `ActorStateRecord`, `ActorSnapshot`, `StateData` |

These helpers operate only on supplied values, actor metadata, and callbacks. Runtime-owned storage, scheduling, reference registries, and delivery remain the runtime implementation's responsibility.

Runtime authors can validate the core implementation with `@mekakucity/actors/conformance`. Effect-specific conformance is separate so the core suite does not load the optional `effect` peer:

```ts
import { actorRuntimeConformance } from "@mekakucity/actors/conformance";
import { actorEffectConformance } from "@mekakucity/actors/conformance/effect";
import { MyActorRuntime } from "./my-actor-runtime.js";

const runtimeFactory = () => new MyActorRuntime();
actorRuntimeConformance(runtimeFactory);
actorEffectConformance(runtimeFactory);
```

The conformance subpaths require the optional `vitest` peer dependency; the Effect suite also requires `effect`. Each test receives a fresh runtime from the factory and runs inside that runtime's AsyncLocalStorage scope. A runtime with a snapshot cache can optionally provide `evictSnapshotCache` to the core suite; runtimes without that capability need no hooks.

## Known limitations

- `ActorEffect.call` widens a generic action method's parameter and result types to the generic bound.
- An action that declares an explicit `this` parameter keeps only its last overload and loses its generic type parameters on `ActorRef`.
- An asynchronous method without `@action` is indistinguishable from an action at the type level, so it appears on `ActorRef` even though the runtime has not registered it as an action.
