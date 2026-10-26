---
"@mekakucity/actors": minor
"@mekakucity/durable-object": minor
"@mekakucity/days": minor
"@mekakucity/verify": minor
---

Add the `@actor(id)` class decorator and make it required on every actor class. The id is the stable actor type id and replaces the class name (`@mekakucity/days`) and the `defineActorHost` key (`@mekakucity/durable-object`). Two classes with the same id throw `ActorRuntimeError` when the second is defined; spawning, looking up or referencing an unregistered class or id throws `ActorRuntimeError` instead of building a reference without actions.

`@state` and `@action` now record their members in decorator metadata when the class is defined, so `metadataFor(Type)` no longer needs an instance. This fixes Durable Object worker refs that had no action methods (`counter.add is not a function`) because the worker never constructs the actors it calls.

Breaking: `@mekakucity/durable-object` removes `defineActorHost` and the test-only `allowUnregisteredTypes`; export `ActorHost` from the worker entry with `export { ActorHost } from "@mekakucity/durable-object"`. The verify suites decorate their actor classes, so they assert the new type ids.
