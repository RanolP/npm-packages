---
"@mekakucity/actors": minor
---

Add the runtime-independent actor contract with AsyncLocalStorage-scoped `runtime.run`, typed references, and Effect integration. `@mekakucity/actors/runtime` exports the holder protocol (`actorHolder`, `messageHolder`, `txHolder`, `frameHolder`, `NAMED_ROOT`, `HolderOp`, `applyHolderOp`, `diffHeldRefs`) that runtimes use to track which holders keep an anonymous actor reference alive.
