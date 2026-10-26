# @mekakucity/actors

## 0.1.0

### Minor Changes

- 3b6e7c9: Add the runtime-independent actor contract with AsyncLocalStorage-scoped `runtime.run`, typed references, and Effect integration. `@mekakucity/actors/runtime` exports the holder protocol (`actorHolder`, `messageHolder`, `txHolder`, `frameHolder`, `NAMED_ROOT`, `HolderOp`, `applyHolderOp`, `diffHeldRefs`) that runtimes use to track which holders keep an anonymous actor reference alive.
