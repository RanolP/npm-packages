---
"@mekakucity/actors": patch
"@mekakucity/days": patch
"@mekakucity/durable-object": patch
---

Declare `sideEffects` so bundlers can drop unused imports of these packages. `@mekakucity/days` and `@mekakucity/durable-object` have none; `@mekakucity/actors` lists `./dist/action/decorators.js`, which installs the `Symbol.metadata` polyfill at module top level.
