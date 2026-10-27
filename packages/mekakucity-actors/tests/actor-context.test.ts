import { Actor, ActorContextUnavailableError } from "../src/index.js";
import { expect, test } from "vitest";

class ContextReader extends Actor<ContextReader, {}> {
  readContext() {
    return this.ctx;
  }
}

test("Actor.ctx rejects reads outside an active action", () => {
  const actor = new ContextReader({});
  expect(() => actor.readContext()).toThrow(ActorContextUnavailableError);
});
