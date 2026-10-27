import {
  Actor,
  action,
  actor,
  state,
  type ActorReadInfo,
} from "@mekakucity/actors";
import type { ActorRuntime } from "@mekakucity/actors/runtime";
import { describe, expect } from "vitest";
import { createRuntimeTestTools, type ActorRuntimeConformanceHooks } from "./runtime.js";

@actor("verify/observation/Counter")
class ObservationCounter extends Actor<ObservationCounter, {}> {
  @state accessor count = 0;

  @action async noop(): Promise<void> {}
}

export const observationSuite = (
  factory: () => ActorRuntime,
  hooks?: ActorRuntimeConformanceHooks,
): void => {
  const { it } = createRuntimeTestTools(factory, hooks);
  describe("@mekakucity/actors observation", () => {
    it("reports value, action, and refresh reads with their snapshot versions", async (runtime) => {
      const reads: ActorReadInfo[] = [];
      const ref = await Actor.observeReads(
        () => runtime.run(async () => {
          const ref = await Actor.spawn(ObservationCounter, {});
          expect(ref.count).toBe(0);
          await ref.noop();
          await Actor.refreshValues(ref);
          return ref;
        }),
        (read) => reads.push(read),
      );

      const actor = { type: ref.type, id: ref.id };
      expect(reads).toEqual([
        { actor, version: 0 },
        { actor, version: 1 },
        { actor, version: 1 },
      ]);
    });
  });
};
