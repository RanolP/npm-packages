import { Actor, ActorReentrancyError, action, state } from "../src/index.js";
import type { ActorRef } from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("@mekakucity/actors reentrancy", () => {
  it("rejects A to B to A reentrancy but allows another instance of the same class", async () => {
    class RingActor extends Actor<RingActor, { peer?: ActorRef<RingActor> }> {
      @state accessor peer = this.input.peer ?? null as ActorRef<RingActor> | null;
      @action async callPeer(): Promise<string> { return this.peer?.callPeer() ?? "done"; }
      @action async setPeer(peer: ActorRef<RingActor>) { this.peer = peer; }
      @action async leaf() { return "leaf"; }
      @action async callLeaf(): Promise<string> { return this.peer!.leaf(); }
      @action async sendPeerDetached(): Promise<string> { this.peer!.callPeer.runDetached(); return "sent"; }
    }

    await Actor.transaction(async () => {
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
