# @mekakucity/days

## 0.1.0

### Minor Changes

- bdbd5c7: Add the in-memory development runtime for `@mekakucity/actors` with segment-committing runtime runs, detached delivery, snapshot caching, and holder-protocol actor reference lifecycle management. Outbox entries become durable once their segment commits, so a spawn in a failed action survives if another actor committed a ref to it, and root-context sends are dropped when the root fails.
