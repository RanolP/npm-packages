---
"@mekakucity/days": patch
"@mekakucity/durable-object": patch
"@mekakucity/verify": patch
---

An action that leaves an actor's state unchanged no longer raises its version or emits an `onCommit` event, so a read-only call no longer makes later reads observe a new version. Holder, outbox and inbox bookkeeping for that action is still written, and `afterCommit` hooks still run with the current version and an empty `changed`.
