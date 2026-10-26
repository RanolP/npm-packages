---
"@mekakucity/actors": minor
"@mekakucity/verify": minor
"@mekakucity/days": patch
"@mekakucity/durable-object": patch
---

Add detached-only actor self references and conformance coverage for both runtimes.

Fix the durable-object runtime throwing `ReferenceError: metadataFor is not defined` when an actor awaits an action on its own reference.
