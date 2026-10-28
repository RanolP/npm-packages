---
"@mekakucity/actors": minor
"@mekakucity/days": patch
"@mekakucity/durable-object": patch
---

Declare `sideEffects` so bundlers can drop unused imports of these packages. `@mekakucity/days` and `@mekakucity/durable-object` have none. `@mekakucity/actors` no longer installs `Symbol.metadata` when imported; TypeScript `tsc` users can opt in through `@mekakucity/actors/polyfill`.
