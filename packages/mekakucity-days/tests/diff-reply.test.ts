import { Actor, action, derived, state } from "@mekakucity/actors";
import { describe, expect, it } from "vitest";
import { InMemoryActorRuntime } from "../src/index.js";
import { inMemoryActorRuntimeTestHooks } from "../src/testing.js";

describe("@mekakucity/days diff replies", () => {
  it("updates state and derived values from a field-level action reply (NimGame)", async () => {
    class NimGame extends Actor<NimGame, { players: string[] }> {
      @state accessor players: string[] = this.input.players;
      @state accessor turn: 0 | 1 = 0;
      @state accessor stonesLeft = 11;
      @state accessor started = false;
      @derived get currentPlayer() { return this.players[this.turn] ?? null; }
      @derived get isOver() { return this.started && this.stonesLeft === 0; }
      @derived get winner() { return this.isOver ? this.players[this.turn === 0 ? 1 : 0] : null; }
      @derived get loser() { return this.isOver ? this.players[this.turn] : null; }
      @action async enter(player: string) {
        if (this.started) throw new Error("game already started");
        if (this.players.length >= 2) throw new Error("game full");
        this.players = [...this.players, player];
      }
      @action async take(player: string, stones: number) {
        if (this.players.length < 2) throw new Error("need two players");
        if (this.isOver) throw new Error("game over");
        if (player !== this.currentPlayer) throw new Error("not your turn");
        if (!Number.isInteger(stones) || stones < 1 || stones > 3 || stones > this.stonesLeft) {
          throw new Error("invalid take");
        }
        this.started = true;
        this.stonesLeft -= stones;
        this.turn = this.turn === 0 ? 1 : 0;
        return this.stonesLeft;
      }
    }

    const runtime = new InMemoryActorRuntime();
    await runtime.run(() => Actor.transaction(async () => {
      const game = await Actor.spawn(NimGame, { players: [] });
      await game.enter("alice");
      await game.enter("bob");
      await expect(game.enter("charlie")).rejects.toThrow("game full");
      expect(game.currentPlayer).toBe("alice");
      expect(game.isOver).toBe(false);
      await expect(game.take("bob", 1)).rejects.toThrow("not your turn");
      await expect(game.take("alice", 0)).rejects.toThrow("invalid take");
      expect(await game.take("alice", 3)).toBe(8);
      const diffReply = runtime[inMemoryActorRuntimeTestHooks]().lastActionReply()!;
      expect(diffReply.isDiff).toBe(true);
      expect(diffReply.baseVersion).toBe(diffReply.startVersion);
      expect(Object.keys(diffReply.snapshot).sort()).toEqual(["currentPlayer", "isOver", "loser", "started", "stonesLeft", "turn", "winner"].sort());
      expect(game.stonesLeft).toBe(8);
      expect(game.currentPlayer).toBe("bob");
      await expect(game.enter("charlie")).rejects.toThrow("game already started");
      runtime[inMemoryActorRuntimeTestHooks]().evictSnapshotCache(game);
      expect(await game.take("bob", 1)).toBe(7);
      const fullReply = runtime[inMemoryActorRuntimeTestHooks]().lastActionReply()!;
      expect(fullReply.isDiff).toBe(false);
      expect(Object.keys(fullReply.snapshot).sort()).toEqual(["currentPlayer", "isOver", "loser", "players", "started", "stonesLeft", "turn", "winner"].sort());
      await game.take("alice", 3);
      await game.take("bob", 3);
      await game.take("alice", 1);
      expect(game.isOver).toBe(true);
      expect(game.winner).toBe("alice");
      expect(game.loser).toBe("bob");
      await expect(game.take("bob", 1)).rejects.toThrow("game over");
    }));
  });
});
