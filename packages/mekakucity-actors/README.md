# @mekakucity/actors

`@mekakucity/actors` defines the runtime-independent contract for TypeScript actors. It provides the `Actor` base class, typed references, decorators, Effect integration, and the abstract `ActorRuntime` API. Applications choose a runtime explicitly and scope it with `runtime.run(...)`.

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

Create one runtime and open its transaction context with `runtime.run(...)`. The call establishes the AsyncLocalStorage scope and commits actor actions in segments. A failed run discards only its uncommitted work; segments committed before the failure stay, so the caller can retry from that state.

```ts
import { Actor, action, state } from "@mekakucity/actors";
import { InMemoryActorRuntime } from "@mekakucity/days";

class Counter extends Actor<Counter, { initial: number }> {
  @state accessor value = this.input.initial;

  @action async add(amount: number): Promise<number> {
    this.value += amount;
    return this.value;
  }
}

const runtime = new InMemoryActorRuntime();

await runtime.run(async () => {
  const counter = await Actor.spawn(Counter, { initial: 0 });
  await counter.add(2);
  console.log(counter.value); // 2
});
```

`Actor.spawn` returns an `ActorRef`, not the actor instance. The reference exposes decorated asynchronous actions, read-only `@state` snapshots, and every getter declared by the actor class. An action must not declare an explicit `this` parameter; `@action` rejects it at compile time.

Reading a getter through an `ActorRef` evaluates the class getter with the reference as `this`, so reads of `@state` fields and other getters use the reference's current snapshot. That `this` value contains only `@state` fields, getters, actions, `type`, and `id`; it does not contain `this.input`, private helpers, or fields without `@state`.

Calling an actor API outside `runtime.run(...)` throws `NoActiveActorRuntimeError`. A nested `run` on the same runtime joins the open transaction; a nested `run` on another runtime opens an isolated transaction owned by that runtime.

## Send a detached message to the same actor

Use `this.asRef` inside an action to queue another action on the same actor.

```ts
class Counter extends Actor<Counter, { initial: number }> {
  @state accessor value = this.input.initial;

  @action async addLater(amount: number): Promise<void> {
    this.asRef.add.runDetached(amount);
  }

  @action async add(amount: number): Promise<void> {
    this.value += amount;
  }
}
```

The self-reference exposes only `runDetached(...)`. The runtime delivers the message after the sending action commits and discards it if that action rolls back. Awaited self-calls are not available because waiting for the current actor to call itself would cause reentrancy.

## External I/O

Use detached actions as an outbox and model external work as a multi-transaction saga.

```ts
import { Actor, action, state } from "@mekakucity/actors";

type PaymentResult =
  | { status: "approved"; authorizationId: string }
  | { status: "declined"; reason: string };

declare const paymentApi: {
  authorize(input: { idempotencyKey: string; amount: number }): Promise<PaymentResult>;
};

class Order extends Actor<Order, { orderId: string; amount: number }> {
  @state accessor orderId = this.input.orderId;
  @state accessor amount = this.input.amount;
  @state accessor status: "draft" | "pendingPayment" | "paid" | "declined" = "draft";
  @state accessor authorizationId: string | null = null;

  @action async checkout(): Promise<void> {
    if (this.status !== "draft") throw new Error(`cannot checkout from ${this.status}`);
    this.status = "pendingPayment";
    const gateway = await Actor.ofNamed(PaymentGateway, "default").orSpawn(() => ({}));
    gateway.authorize.runDetached(this.orderId, this.amount);
  }

  @action async applyPaymentResult(result: PaymentResult): Promise<void> {
    if (this.status !== "pendingPayment") return;
    if (result.status === "approved") {
      this.status = "paid";
      this.authorizationId = result.authorizationId;
    } else {
      this.status = "declined";
    }
  }
}

class PaymentGateway extends Actor<PaymentGateway, {}> {
  @action async authorize(orderId: string, amount: number): Promise<void> {
    const result = await paymentApi.authorize({ idempotencyKey: orderId, amount });
    const order = await Actor.ofNamed(Order, orderId).orNull();
    order?.applyPaymentResult.runDetached(result);
  }
}

const orderId = "order-123";
const amount = 2500;

await runtime.run(async () => {
  const order = await Actor.ofNamed(Order, orderId).orSpawn(() => ({ orderId, amount }));
  await order.checkout();
});
```

Orders are named by order ID so the payment gateway can find them in a later transaction. The authorization request leaves the outbox only after the checkout transaction commits. The payment result is applied in its own transaction. Using the order ID as an idempotency key makes redelivery safe for a runtime that supports it. `@mekakucity/days` attempts each detached message once; if its handler fails, it discards the delivery's uncommitted work, releases the message's references, and does not retry.

## Implement a runtime

Import `ActorRuntime` from `@mekakucity/actors` or the runtime-author entry point `@mekakucity/actors/runtime`. The contract uses Node's `node:async_hooks` module to scope the active runtime. Implement these abstract members:

- `run(work)` scopes the runtime and creates or joins its transaction context.
- `spawn(Type, input)` creates an anonymous actor in the active transaction.
- `named(Type, key)` looks up or creates a named actor.
- `refreshValues(ref)` refreshes a reference's snapshot values.
- `invokeRefAction(ref, actionName, args)` sends an action through a reference.
- `invokeLocalAction(instance, actionName, args, run)` invokes a decorated action on its owning actor.
- `runDetached(ref, actionName, args)` registers detached delivery with the transaction.
- `readSnapshotValue(ref, key)` reads cached state.

The `@mekakucity/actors/runtime` entry point also exports storage-independent building blocks for runtime implementations:

| Domain | Exports |
| --- | --- |
| Actor metadata | `metadataFor`, `actionNameOf` |
| References | `actorRefSurfaceFor`, `createActorRef`, `isActorDescriptor`, `hydrateActorRefs`, `collectActorRefIds` |
| State cloning | `cloneOrThrow`, `assertCloneableResultPrototypes` |
| State snapshots | `stateFields`, `cloneState`, `restoreState`, `createSnapshot`, `changedStateFields`, `restoreSnapshotData`, `deepFreeze` |
| Helper types | `ActorMetadata`, `ActorRefSurface`, `ActorRefHydration`, `ActorStateRecord`, `ActorSnapshot`, `StateData` |

These helpers operate only on supplied values, actor metadata, and callbacks. Runtime-owned storage, scheduling, reference registries, and delivery remain the runtime implementation's responsibility.

Runtime authors can validate the core implementation with `@mekakucity/verify`. Effect-specific conformance is separate so the core suite does not load the optional `effect` peer:

```ts
import { actorRuntimeConformance } from "@mekakucity/verify";
import { actorEffectConformance } from "@mekakucity/verify/effect";
import { MyActorRuntime } from "./my-actor-runtime.js";

const runtimeFactory = () => new MyActorRuntime();
actorRuntimeConformance(runtimeFactory);
actorEffectConformance(runtimeFactory);
```

The verification package requires `vitest`; its Effect suite also requires `effect`. Each test receives a fresh runtime from the factory and opens its own runtime scopes with `runtime.run(...)`. A runtime with a snapshot cache can optionally provide `evictSnapshotCache` to the core suite; runtimes without that capability need no hooks.

## Known limitations

- `ActorEffect.call` widens a generic action method's parameter and result types to the generic bound.
- An asynchronous method without `@action` is indistinguishable from an action at the type level, so it appears on `ActorRef` even though the runtime has not registered it as an action.
