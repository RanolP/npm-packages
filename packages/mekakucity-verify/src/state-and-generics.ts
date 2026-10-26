import { Actor, action, derived, state } from "@mekakucity/actors";
import type { Cloneable } from "@mekakucity/actors";
import type { ActorRuntime } from "@mekakucity/actors/runtime";
import { describe, expect } from "vitest";
import { createRuntimeTestTools, type ActorRuntimeConformanceHooks } from "./runtime.js";

export const stateAndGenericsSuite = (factory: () => ActorRuntime, hooks?: ActorRuntimeConformanceHooks): void => {
  const { it } = createRuntimeTestTools(factory, hooks);
  describe("@mekakucity/actors state, derived values, and generics", () => {
  it("generic actor classes work when spawned with a pinned item type", async (runtime) => {
    class Queue<T extends Cloneable> extends Actor<Queue<T>, { items: T[] }> {
      @state accessor items: T[] = this.input.items;
      @action async push(item: T) { this.items = [...this.items, item]; }
      @action async pop(): Promise<T | undefined> {
        const [item, ...remaining] = this.items;
        this.items = remaining;
        return item;
      }
    }

    await runtime.run(async () => {
      const numbers = await Actor.spawn(Queue<number>, { items: [1, 2] });
      expect(numbers.items).toEqual([1, 2]);
      expect(await numbers.pop()).toBe(1);
      await numbers.push(3);
      expect(numbers.items).toEqual([2, 3]);

      const objects = await Actor.spawn(Queue<{ id: string }>, { items: [{ id: "one" }] });
      expect(objects.items).toEqual([{ id: "one" }]);
      expect(await objects.pop()).toEqual({ id: "one" });
      await objects.push({ id: "two" });
      expect(objects.items).toEqual([{ id: "two" }]);

      const named = await Actor.ofNamed(Queue<{ id: string }>, "queue-actors")
        .orSpawn(() => ({ items: [{ id: "named" }] }));
      expect(named.items).toEqual([{ id: "named" }]);
      expect(await named.pop()).toEqual({ id: "named" });
    });
  });

  it("generic action methods keep their call-site type on refs", async (runtime) => {
    class EchoActor extends Actor<EchoActor, {}> {
      @action async echo<T extends Cloneable>(value: T): Promise<T> { return value; }
    }

    await runtime.run(async () => {
      const ref = await Actor.spawn(EchoActor, {});
      expect(await ref.echo(5)).toBe(5);
      expect(await ref.echo("a")).toBe("a");
    });
  });
  });
};
