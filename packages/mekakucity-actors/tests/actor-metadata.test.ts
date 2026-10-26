import { expect, test } from "vitest";
import { Actor, action, actor, state } from "../src/index.js";
import { metadataFor } from "../src/runtime/index.js";

// Regression: @state and @action registered through addInitializer, which runs only when an instance is
// constructed. A worker calling an actor hosted elsewhere never constructs it, so its refs had no actions.
test("metadataFor(Counter).actions contains add before any new Counter", () => {
  @actor("actor-metadata/Counter")
  class Counter extends Actor<Counter, {}> {
    @state accessor value = 0;
    @action async add(amount: number): Promise<number> {
      this.value += amount;
      return this.value;
    }
  }

  const metadata = metadataFor(Counter);
  expect([...metadata.actions.keys()]).toEqual(["add"]);
  expect([...metadata.state]).toEqual(["value"]);
});
