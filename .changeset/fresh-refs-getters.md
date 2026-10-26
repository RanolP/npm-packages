---
"@mekakucity/actors": minor
"@mekakucity/days": patch
"@mekakucity/durable-object": patch
"@mekakucity/verify": minor
---

Remove the `derived` decorator and expose actor class getters directly through references, where they recompute from the reference's current state snapshot. Update both runtime implementations and the conformance suite for the new getter surface.
