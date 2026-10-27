import type { Actor, ActorContextProvider, ActorRef } from "@mekakucity/actors";
import { ActorRuntime } from "@mekakucity/actors/runtime";
import { it as vitestIt, type TestContext } from "vitest";

export interface ActorRuntimeConformanceHooks {
  // Lets the runtime suite model a restored reference after its cache entry was finalized.
  readonly evictSnapshotCache?: (ref: ActorRef<Actor<unknown, unknown>>) => void;
  /** Constructs a runtime with the provider used by the shared actor-context cases. */
  readonly createWithContext?: (provider: ActorContextProvider) => ActorRuntime;
}

export const createRuntimeTestTools = (
  factory: () => ActorRuntime,
  hooks?: ActorRuntimeConformanceHooks,
) => ({
  factory,
  it: (name: string, test: (runtime: ActorRuntime) => unknown | Promise<unknown>): void => {
    vitestIt(name, () => test(factory()));
  },
  itOutsideRuntime: (
    name: string,
    test: () => unknown | Promise<unknown>,
  ): void => vitestIt(name, test),
  itWithSnapshotCacheEviction: (
    name: string,
    test: (
      runtime: ActorRuntime,
      evict: NonNullable<ActorRuntimeConformanceHooks["evictSnapshotCache"]>,
    ) => unknown | Promise<unknown>,
  ): void => {
    vitestIt(name, (context: TestContext) => {
      const evict = hooks?.evictSnapshotCache;
      if (!evict) return context.skip();
      return test(factory(), evict);
    });
  },
});
