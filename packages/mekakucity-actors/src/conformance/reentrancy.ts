import { Actor, ActorReentrancyError, action, state } from "../index.js";
import type { ActorRef } from "../index.js";
import type { ActorRuntime } from "../runtime/actor-runtime.js";
import { describe, expect } from "vitest";
import { createRuntimeTestTools, type ActorRuntimeConformanceHooks } from "./runtime.js";

export const reentrancySuite = (factory: () => ActorRuntime, hooks?: ActorRuntimeConformanceHooks): void => {
  const { it } = createRuntimeTestTools(factory, hooks);
  describe("@mekakucity/actors reentrancy", () => {
  it("rejects A to B to A reentrancy but allows another instance of the same class", async (runtime) => {
    class RingActor extends Actor<RingActor, { peer?: ActorRef<RingActor> }> {
      @state accessor peer = this.input.peer ?? null as ActorRef<RingActor> | null;
      @action async callPeer(): Promise<string> { return this.peer?.callPeer() ?? "done"; }
      @action async setPeer(peer: ActorRef<RingActor>) { this.peer = peer; }
      @action async leaf() { return "leaf"; }
      @action async callLeaf(): Promise<string> { return this.peer!.leaf(); }
      @action async sendPeerDetached(): Promise<string> { this.peer!.callPeer.runDetached(); return "sent"; }
    }

    await runtime.run(async () => {
      const a = await Actor.spawn(RingActor, {});
      const b = await Actor.spawn(RingActor, { peer: a });
      await a.setPeer(b);
      await expect(a.callPeer()).rejects.toBeInstanceOf(ActorReentrancyError);
      expect(await a.sendPeerDetached()).toBe("sent");
      const first = await Actor.spawn(RingActor, {});
      const second = await Actor.spawn(RingActor, { peer: first });
      expect(await second.callLeaf()).toBe("leaf");
    });
  });
  });
};
