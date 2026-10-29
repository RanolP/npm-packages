---
"@mekakucity/actors": minor
"@mekakucity/verify": patch
"@mekakucity/days": patch
"@mekakucity/durable-object": patch
---

Add `orThrow` to `Actor.ofNamed(...)`: it returns the existing ref, or throws the caller's error (default `ActorNotFoundError`) when the actor does not exist.

Runtimes now implement only `resolve` and keyed `spawn`, while the `ActorRefInit` class implements `orNull`, `orSpawn`, and `orThrow` once in core.
