import { Actor, action, actor } from "@mekakucity/actors";
import { expect, test } from "vitest";
import { InMemoryActorRuntime } from "../src/index.js";

@actor("days/tests/EventActor")
class EventActor extends Actor<EventActor, Record<string, never>> {
  declare events: { typing: { userId: string } };

  @action async announceTyping(userId: string): Promise<void> {
    this.emit("typing", { userId });
  }

  @action async announceTypingThenThrow(userId: string): Promise<never> {
    this.emit("typing", { userId });
    throw new Error("action failed");
  }
}

test("delivers an event from a committed action after the commit", async () => {
  const runtime = new InMemoryActorRuntime();
  const received: unknown[] = [];
  runtime.onEvent((event) => { received.push(event); });

  await runtime.run(async () => {
    const actor = await Actor.spawn(EventActor, {});
    await actor.announceTyping("user-1");
  });

  expect(received).toEqual([{
    actor: { type: "days/tests/EventActor", id: "actor_1" },
    name: "typing",
    payload: { userId: "user-1" },
  }]);
});

test("does not deliver an event from a throwing action", async () => {
  const runtime = new InMemoryActorRuntime();
  const received: unknown[] = [];
  runtime.onEvent((event) => { received.push(event); });

  await expect(runtime.run(async () => {
    const actor = await Actor.spawn(EventActor, {});
    await actor.announceTypingThenThrow("user-2");
  })).rejects.toThrow("action failed");

  expect(received).toEqual([]);
});
