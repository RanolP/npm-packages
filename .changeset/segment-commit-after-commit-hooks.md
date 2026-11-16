---
"@mekakucity/actors": patch
"@mekakucity/days": patch
"@mekakucity/durable-object": patch
"@mekakucity/verify": patch
---

Run after-commit hooks registered before a segment commit once, right after that segment commits, so notifications emitted before a call to another actor, a spawn, a named lookup or a refresh reach subscribers before the action returns instead of all at once after its final commit.

`@mekakucity/days`, `@mekakucity/durable-object` and `@mekakucity/verify` now require `@mekakucity/actors` 0.7.2 or later, because the runtimes call the new `ActorInvocationContext.afterSegmentCommit`.
