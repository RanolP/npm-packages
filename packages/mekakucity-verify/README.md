# @mekakucity/verify

`@mekakucity/verify` provides Vitest suites that a runtime implementation runs to verify that it meets the `@mekakucity/actors` contract.

## Install

Install the verification suite with the actor contract and Vitest. Install `effect` when the runtime supports the Effect integration.

```sh
pnpm add -D @mekakucity/actors @mekakucity/verify vitest effect
```

## Verify a runtime

Pass a factory that creates a fresh runtime to each suite. The core suite accepts optional hooks for runtime-specific test setup.

```ts
import { actorRuntimeConformance } from "@mekakucity/verify";
import { actorEffectConformance } from "@mekakucity/verify/effect";
import { MyActorRuntime } from "./my-actor-runtime.js";

const runtimeFactory = () => new MyActorRuntime();

actorRuntimeConformance(runtimeFactory, {
  evictSnapshotCache(ref) {
    // Remove ref from this runtime's snapshot cache.
  },
});

actorEffectConformance(runtimeFactory);
```

Omit `evictSnapshotCache` when the runtime does not expose snapshot-cache eviction. Omit `actorEffectConformance` and the `effect` dependency when the runtime does not implement the Effect integration.
