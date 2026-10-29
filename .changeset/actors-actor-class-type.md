---
"@mekakucity/actors": patch
---

`actorClassOrThrow` from `@mekakucity/actors/runtime` now returns `ActorConstructor<Actor<unknown, unknown>>` instead of `Function`, so callers construct the class without a cast.
