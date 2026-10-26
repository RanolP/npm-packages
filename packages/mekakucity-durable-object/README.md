# @mekakucity/durable-object

`@mekakucity/durable-object` runs `@mekakucity/actors` actors on Cloudflare Durable Objects. Each actor lives in its own SQLite-backed Durable Object, which stores its state, holders and outbox, so one segment commit is one storage transaction. The worker marks its actor classes with `@actor(id)`, re-exports `ActorHost`, and talks to actors through `DurableObjectActorRuntime`.

## Install the runtime

Install it next to the actor contract.

```sh
pnpm add @mekakucity/actors @mekakucity/durable-object
```

## Bind the host in wrangler.jsonc

The host class must be bound as `ACTOR_HOST`: actions running inside one actor reach every other actor through that binding. It must be a SQLite-backed class, declared under `new_sqlite_classes` in a migration, and the worker needs `nodejs_compat` because the contract scopes transactions with `node:async_hooks`.

```jsonc
{
  "name": "my-worker",
  "main": "src/worker.ts",
  "compatibility_date": "2026-10-19",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "name": "ACTOR_HOST", "class_name": "ActorHost" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ActorHost"] }]
}
```

## Register actor classes in the worker entry

Decorate every actor class with `@actor(id)` and re-export `ActorHost` from the worker entry under the `class_name` from wrangler.jsonc. `@actor` registers the class when its module is evaluated, so the worker entry must import every module that defines an actor class: a Durable Object can wake in an isolate where no caller has run yet, and it finds its class only through that registration.

```ts
// src/worker.ts
import { Actor, action, actor, state } from "@mekakucity/actors";
import { DurableObjectActorRuntime, type ActorHost } from "@mekakucity/durable-object";

export { ActorHost } from "@mekakucity/durable-object";

@actor("counter")
class Counter extends Actor<Counter, { initial: number }> {
  @state accessor value = this.input.initial;

  @action async add(amount: number): Promise<number> {
    this.value += amount;
    return this.value;
  }
}

interface Env {
  ACTOR_HOST: DurableObjectNamespace<ActorHost>;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const runtime = new DurableObjectActorRuntime(env.ACTOR_HOST, { scope: "app" });
    const value = await runtime.run(async () => {
      const counter = await Actor.ofNamed(Counter, "visits").orSpawn(() => ({ initial: 0 }));
      return counter.add(1);
    });
    return new Response(String(value));
  },
};
```

Spawning or looking up a class without `@actor` throws `ActorRuntimeError` in the caller, and the error names the class. A reference or a host lookup for a type id that no loaded class carries throws `ActorRuntimeError` too, instead of producing a reference without actions.

`scope` separates named actors: runtimes with the same scope share `Actor.ofNamed(Counter, "visits")`, and runtimes with different scopes each get their own. It defaults to `"default"`. Registered classes are shared by the whole worker regardless of scope.

## Keep actor ids stable

The `@actor` id is the type id stored with every actor of that class. Changing an id orphans the actors already stored under the old one: their Durable Objects can no longer find a class. Renaming the class itself, or minifying the bundle, is safe as long as the id stays the same.

```ts
// Renamed the class, kept the stored id.
@actor("counter")
class VisitCounter extends Actor<VisitCounter, { initial: number }> {
  // ...
}
```

When two classes are defined under the same id, the later one wins and `console.warn` names the id and both classes.

## Scheduled detached delivery

The runtime stores each scheduled detached message in the target actor's SQLite inbox with an absolute due time. The target's Durable Object alarm wakes at the earliest inbox due time, so scheduled delivery survives Durable Object eviction and restart. Eligible inbox messages run by due time and retain their send order when their due times match.

Failed detached deliveries from a live actor are not retried automatically. The sending actor resends them when it next runs; if it never runs again, they remain pending. One failed row blocks every later row from the same sender. A collected actor instead retries its remaining release messages up to five times, after 5, 8, 13, 21, and 34 seconds. If all five retries fail, its storage and holds remain in place.

An inbox action that remains in flight uses the same five alarm delays as a durable backstop. Its per-message wake count survives eviction; after the fifth wake finds the inbox row still present, the runtime logs the stuck action and leaves the row without another alarm.
