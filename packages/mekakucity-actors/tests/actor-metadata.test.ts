import { expect, test } from "vitest";
import { Actor, action, actor, ActorRuntimeError, state } from "../src/index.js";
import { actorRefSurfaceFor, createActorRef, metadataFor } from "../src/runtime/index.js";

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

// Regression: private durable state must not become a readable ActorRef key.
test("private state stays off the actor ref surface", () => {
  @actor("actor-metadata/PrivateState")
  class PrivateState extends Actor<PrivateState, {}> {
    @state accessor visible = 0;
    @state accessor #items: string[] = [];

    @action async itemCount(): Promise<number> {
      return this.#items.length;
    }
  }

  const surface = actorRefSurfaceFor(PrivateState);
  const ref = createActorRef<PrivateState>({ type: "actor-metadata/PrivateState", id: "private" }, surface);

  expect([...surface.values]).toEqual(["visible"]);
  expect("visible" in ref).toBe(true);
  expect("#items" in ref).toBe(false);
  expect("items" in ref).toBe(false);
});

// Regression: inherited private state accessors with the same source name cannot share a snapshot key.
test("duplicate private state keys across a class chain throw at class definition", () => {
  class Base extends Actor<Base, {}> {
    @state accessor #count = 0;
  }

  expect(() => {
    class Sub extends Base {
      @state accessor #count = 1;
    }
    return Sub;
  }).toThrowError(
    new ActorRuntimeError(
      "Private state key #count conflicts with an inherited key; private state keys must be unique across the class chain",
    ),
  );
});

// Regression: ActorRef getters use the ref as `this`, which cannot satisfy a private-field brand check.
test("actor ref getters cannot read private state", () => {
  @actor("actor-metadata/PrivateStateGetter")
  class PrivateStateGetter extends Actor<PrivateStateGetter, {}> {
    @state accessor #items: string[] = [];

    get itemCount(): number {
      return this.#items.length;
    }
  }

  const surface = actorRefSurfaceFor(PrivateStateGetter);
  const ref = createActorRef<PrivateStateGetter>(
    { type: "actor-metadata/PrivateStateGetter", id: "private-getter" },
    surface,
  );

  expect(() => ref.itemCount).toThrowError(TypeError);
});
