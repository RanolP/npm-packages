---
"@mekakucity/actors": minor
"@mekakucity/verify": minor
"@mekakucity/days": minor
"@mekakucity/durable-object": minor
---

Add `schedule({ after: { ms } })` and `schedule({ at: Date })` to actor-reference and self-reference actions; the returned object exposes only `runDetached`. A plain `runDetached` is the same as `schedule({ after: { ms: 0 } }).runDetached`. The delay counts from the commit that confirms the message, a rolled-back sender discards it, and messages to one target run by due time, then send order.

`@mekakucity/days` now runs detached messages to different targets concurrently, keeping per-target order.

`@mekakucity/durable-object` storage from 0.1.0 is incompatible when it contains queued inbox or outbox messages; drain queued detached messages before upgrading.

Failed durable-object detached deliveries from a live actor are not retried automatically; the sending actor resends them when it next runs, and one failed row blocks its later rows. A collected actor retries its remaining release messages up to five times after 5, 8, 13, 21, and 34 seconds, then leaves its storage and holds in place if every retry fails.

An in-flight durable-object inbox action uses per-message backstop alarms after 5, 8, 13, 21, and 34 seconds; after five wakes the runtime logs and leaves the inbox row without another alarm.
