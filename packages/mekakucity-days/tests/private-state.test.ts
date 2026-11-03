import { Actor, action, actor, state } from "@mekakucity/actors";
import { expect, test } from "vitest";
import { InMemoryActorRuntime } from "../src/index.js";

@actor("days/private-state/TodoList")
class TodoList extends Actor<TodoList, {}> {
  @state accessor #items: string[] = [];

  @action async add(item: string): Promise<void> {
    this.#items = [...this.#items, item];
  }

  @action async addThenFail(item: string): Promise<void> {
    this.#items = [...this.#items, item];
    throw new Error("discard this item");
  }

  @action async items(): Promise<string[]> {
    return this.#items;
  }
}

// Regression: private state was omitted from snapshots, so a reload reset it and a failed action kept its write.
test("private state survives rehydration and rolls back after a failed action", async () => {
  const base = new InMemoryActorRuntime();
  await base.run(async () => {
    const list = await Actor.ofNamed(TodoList, "main").orSpawn(() => ({}));
    await list.add("kept");
  });

  const reloaded = base.fork();
  await reloaded.run(async () => {
    const list = await Actor.ofNamed(TodoList, "main").orThrow();
    expect(await list.items()).toEqual(["kept"]);
    await expect(list.addThenFail("discarded")).rejects.toThrow("discard this item");
    expect(await list.items()).toEqual(["kept"]);
  });
});

@actor("days/private-state/Counter")
class Counter extends Actor<Counter, {}> {
  @state accessor count = 10;
  @state accessor #count = 0;

  @action async incrementPrivate(): Promise<number> {
    this.#count += 1;
    return this.#count;
  }
}

// Regression: serializing a private field under its base name overwrote a public field with the same name.
test("public and private state with the same base name do not collide", async () => {
  const base = new InMemoryActorRuntime();
  await base.run(async () => {
    const counter = await Actor.ofNamed(Counter, "main").orSpawn(() => ({}));
    expect(await counter.incrementPrivate()).toBe(1);
    const readKeys: (string | undefined)[] = [];
    expect(Actor.observeReads(() => counter.count, ({ key }) => readKeys.push(key))).toBe(10);
    expect(readKeys).toEqual(["count"]);
  });

  await base.fork().run(async () => {
    const counter = await Actor.ofNamed(Counter, "main").orThrow();
    expect(await counter.incrementPrivate()).toBe(2);
    expect(counter.count).toBe(10);
  });
});
