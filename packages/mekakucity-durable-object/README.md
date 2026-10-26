# @mekakucity/durable-object

`@mekakucity/durable-object` runs `@mekakucity/actors` actors on Cloudflare Durable Objects. Each actor lives in its own SQLite-backed Durable Object, which stores its state, holders and outbox, so one segment commit is one storage transaction. The worker registers its actor classes once with `defineActorHost` and talks to actors through `DurableObjectActorRuntime`.

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

Call `defineActorHost` at module load with every actor class the worker uses, and export the class it returns under the `class_name` from wrangler.jsonc. A Durable Object can wake in an isolate where no caller has run yet; it finds its class only through this registration.

```ts
// src/worker.ts
import { Actor, action, state } from "@mekakucity/actors";
import { defineActorHost, DurableObjectActorRuntime } from "@mekakucity/durable-object";

class Counter extends Actor<Counter, { initial: number }> {
  @state accessor value = this.input.initial;

  @action async add(amount: number): Promise<number> {
    this.value += amount;
    return this.value;
  }
}

export const ActorHost = defineActorHost({ Counter });

interface Env {
  ACTOR_HOST: DurableObjectNamespace<InstanceType<typeof ActorHost>>;
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

Spawning or looking up a class that was not passed to `defineActorHost` throws in the caller, and the error names the class.

`scope` separates named actors: runtimes with the same scope share `Actor.ofNamed(Counter, "visits")`, and runtimes with different scopes each get their own. It defaults to `"default"`. Registered classes are shared by the whole worker regardless of scope.

## Keep registration keys stable

Each key in the object passed to `defineActorHost` is the type name stored with every actor of that class. Renaming a key orphans the actors already stored under the old name: their Durable Objects can no longer find a class. Renaming the class itself, or minifying the bundle, is safe as long as the key stays the same.

```ts
// Renamed the class, kept the stored name.
export const ActorHost = defineActorHost({ Counter: VisitCounter });
```

A key bound to two different classes, or one class registered under two keys, throws when `defineActorHost` runs.
