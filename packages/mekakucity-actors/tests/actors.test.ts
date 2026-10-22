import { Actor, ActorCompensationError, ActorKilledError, ActorReentrancyError, ActorResultSerializationError, ActorSnapshotUnavailableError, ActorStateSerializationError, NoActiveTransactionError, defer, action, derived, state } from "../src/index.js";
import type { ActorRef } from "../src/index.js";
import type { Cloneable } from "../src/index.js";
import { __evictSnapshotCacheForTest, __lastActionReplyForTest } from "../src/runtime.js";
import { describe, expect, it } from "vitest";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function completesBeforeTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("operation timed out")), 500);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class SyncActorActionMustFailTypecheck extends Actor<SyncActorActionMustFailTypecheck, {}> {
  // @ts-expect-error actor actions must return a Promise.
  @action sync() { return 1; }
}
void SyncActorActionMustFailTypecheck;

describe("@mekakucity/actors design rules", () => {
  it("1 — rejects non-structured-cloneable state at commit and rolls back", async () => {
    class SerializableActor extends Actor<SerializableActor, {}> {
      @state accessor value: unknown = "safe";
      @action async breakState() { this.value = () => "not cloneable"; }
    }

    await Actor.transaction(async () => {
      const ref = await Actor.spawn(SerializableActor, {});
      await expect(ref.breakState()).rejects.toBeInstanceOf(ActorStateSerializationError);
      expect(ref.value).toBe("safe");
    });
  });

  it("2 — serializes each actor mailbox and keeps request order", async () => {
    const releaseFirst = deferred();
    const firstStarted = deferred();
    const events: string[] = [];
    class MailboxActor extends Actor<MailboxActor, {}> {
      @action async work(label: string) {
        events.push(`start:${label}`);
        if (label === "first") {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        events.push(`end:${label}`);
      }
    }

    await Actor.transaction(async () => {
      const ref = await Actor.spawn(MailboxActor, {});
      const first = ref.work("first");
      await firstStarted.promise;
      const second = ref.work("second");
      await turn();
      expect(events).toEqual(["start:first"]);
      releaseFirst.resolve();
      await Promise.all([first, second]);
      expect(events).toEqual(["start:first", "end:first", "start:second", "end:second"]);
    });
  });

  it("3 — rolls back an action and isolates caught same-actor sub-transaction failures", async () => {
    class NestedActor extends Actor<NestedActor, {}> {
      @state accessor count = 0;
      @action async childFailure() { this.count += 10; throw new Error("child"); }
      @action async parent() {
        this.count += 1;
        try { await this.childFailure(); } catch { /* parent continues */ }
        this.count += 1;
      }
      @action async fail() { this.count = 99; throw new Error("parent"); }
    }

    await Actor.transaction(async () => {
      const ref = await Actor.spawn(NestedActor, {});
      await ref.parent();
      expect(ref.count).toBe(2);
      await expect(ref.fail()).rejects.toThrow("parent");
      expect(ref.count).toBe(2);
    });
  });

  it("4 — commits before a cross-actor await and holds the caller mailbox until the reply", async () => {
    const entered = deferred();
    const release = deferred();
    class GateActor extends Actor<GateActor, {}> {
      @action async pause() { entered.resolve(); await release.promise; }
    }
    class WaitingActor extends Actor<WaitingActor, { gate: ActorRef<GateActor> }> {
      @state accessor value = 0;
      @state accessor gate = this.input.gate;
      @action async waitAcrossActor() { this.value = 1; await this.gate.pause(); this.value = 2; }
      @action async increment() { this.value += 1; }
      @action async spawnChild() { this.value = 4; await Actor.spawn(GateActor, {}); }
    }

    await Actor.transaction(async () => {
      const gate = await Actor.spawn(GateActor, {});
      const ref = await Actor.spawn(WaitingActor, { gate });
      const first = ref.waitAcrossActor();
      await entered.promise;
      expect(ref.value).toBe(1);
      const second = ref.increment();
      await turn();
      expect(ref.value).toBe(1);
      release.resolve();
      await Promise.all([first, second]);
      expect(ref.value).toBe(3);
      await ref.spawnChild();
      expect(ref.value).toBe(4);
    });
  });

  it("5 — runs the orchestrator's A and B compensations in reverse order when C fails", async () => {
    const undoOrder: string[] = [];
    class AActor extends Actor<AActor, {}> {
      @action async run() { defer(this.undo); }
      @action async undo() { undoOrder.push("A"); }
    }
    class BActor extends Actor<BActor, {}> {
      @action async run() { defer(this.undo); }
      @action async undo() { undoOrder.push("B"); }
    }
    class CActor extends Actor<CActor, {}> {
      @action async run() { throw new Error("C failed"); }
    }
    class DActor extends Actor<DActor, { a: ActorRef<AActor>; b: ActorRef<BActor>; c: ActorRef<CActor> }> {
      @state accessor a = this.input.a;
      @state accessor b = this.input.b;
      @state accessor c = this.input.c;
      @action async orchestrate() { await this.a.run(); await this.b.run(); await this.c.run(); }
    }

    await Actor.transaction(async () => {
      const a = await Actor.spawn(AActor, {});
      const b = await Actor.spawn(BActor, {});
      const c = await Actor.spawn(CActor, {});
      const d = await Actor.spawn(DActor, { a, b, c });
      await expect(d.orchestrate()).rejects.toThrow("C failed");
      expect(undoOrder).toEqual(["B", "A"]);
    });
  });

  it("5a — runs a direct self-targeting compensation without reacquiring the actor mailbox", async () => {
    const undoOrder: string[] = [];
    class SelfCompensatingActor extends Actor<SelfCompensatingActor, {}> {
      @state accessor undoCount = 0;
      @action async run() { defer(this.undo); throw new Error("abort"); }
      @action async undo() { this.undoCount += 1; undoOrder.push("self"); }
    }

    await Actor.transaction(async () => {
      const ref = await Actor.spawn(SelfCompensatingActor, {});
      await expect(completesBeforeTimeout(ref.run())).rejects.toThrow("abort");
      expect(undoOrder).toEqual(["self"]);
      await Actor.refreshValues(ref);
      expect(ref.undoCount).toBe(0);
    });
  });

  it("5b — runs a self-targeting compensation registered by a nested action without deadlocking", async () => {
    const undoOrder: string[] = [];
    class NestedSelfCompensatingActor extends Actor<NestedSelfCompensatingActor, {}> {
      @action async step() { defer(this.undo); }
      @action async run() { await this.step(); throw new Error("abort"); }
      @action async undo() { undoOrder.push("nested-self"); }
    }

    await Actor.transaction(async () => {
      const ref = await Actor.spawn(NestedSelfCompensatingActor, {});
      await expect(completesBeforeTimeout(ref.run())).rejects.toThrow("abort");
      expect(undoOrder).toEqual(["nested-self"]);
    });
  });

  it("5c — preserves reverse order when one compensation targets its waiting actor", async () => {
    const undoOrder: string[] = [];
    class RemoteUndoActor extends Actor<RemoteUndoActor, {}> {
      @action async run() { defer(this.undo); }
      @action async undo() { undoOrder.push("remote"); }
    }
    class MixedUndoActor extends Actor<MixedUndoActor, { remote: ActorRef<RemoteUndoActor> }> {
      @state accessor remote = this.input.remote;
      @action async run() {
        defer(this.undo);
        await this.remote.run();
        throw new Error("abort");
      }
      @action async undo() { undoOrder.push("self"); }
    }

    await Actor.transaction(async () => {
      const remote = await Actor.spawn(RemoteUndoActor, {});
      const ref = await Actor.spawn(MixedUndoActor, { remote });
      await expect(completesBeforeTimeout(ref.run())).rejects.toThrow("abort");
      expect(undoOrder).toEqual(["remote", "self"]);
    });
  });

  it("5d — runs self-compensation before restoring the failed action's start state", async () => {
    class SelfUndoStateActor extends Actor<SelfUndoStateActor, {}> {
      @state accessor n = 0;
      @action async step() { this.n += 1; defer(this.dec); }
      @action async run() { await this.step(); throw new Error("abort after step"); }
      @action async dec() { this.n -= 1; }
    }

    await Actor.transaction(async () => {
      const ref = await Actor.spawn(SelfUndoStateActor, {});
      await expect(ref.run()).rejects.toThrow("abort after step");
      await Actor.refreshValues(ref);
      expect(ref.n).toBe(0);
    });
  });

  it("5e — delivers detached messages from compensation and releases their receiver holder", async () => {
    const processed = deferred();
    let hits = 0;
    class Receiver extends Actor<Receiver, {}> {
      @action async hit() { hits += 1; processed.resolve(); }
    }
    class Sender extends Actor<Sender, { receiver: ActorRef<Receiver> }> {
      @state accessor receiver: ActorRef<Receiver> | null = this.input.receiver;
      @action async run() { defer(this.undo); throw new Error("rollback sender"); }
      @action async undo() { this.receiver!.hit.runDetached(); }
      @action async drop() { this.receiver = null; }
    }

    let receiver!: ActorRef<Receiver>;
    let sender!: ActorRef<Sender>;
    await Actor.transaction(async () => {
      receiver = await Actor.spawn(Receiver, {});
      sender = await Actor.ofNamed(Sender, "compensation-outbox-sender").orSpawn(() => ({ receiver }));
      await expect(sender.run()).rejects.toThrow("rollback sender");
    });

    await processed.promise;
    await turn();
    expect(hits).toBe(1);
    await Actor.transaction(() => sender.drop());
    await expect(Actor.transaction(() => receiver.hit())).rejects.toBeInstanceOf(ActorKilledError);
  });

  it("5f — compensation mode does not leak into concurrent sibling branches", async () => {
    const compensationStarted = deferred();
    const releaseCompensation = deferred();
    let hits = 0;
    let senderUndos = 0;
    class Receiver extends Actor<Receiver, {}> {
      @action async hit() { hits += 1; }
    }
    class Slow extends Actor<Slow, {}> {
      @action async run() { defer(this.undo); throw new Error("slow failed"); }
      @action async undo() { compensationStarted.resolve(); await releaseCompensation.promise; }
    }
    class Sender extends Actor<Sender, { receiver: ActorRef<Receiver> }> {
      @state accessor receiver = this.input.receiver;
      @action async send() { this.receiver.hit.runDetached(); defer(this.undo); }
      @action async undo() { senderUndos += 1; }
    }

    let slowOutcome!: Promise<unknown>;
    await expect(Actor.transaction(async () => {
      const slow = await Actor.ofNamed(Slow, "compensation-sibling-probe").orSpawn(() => ({}));
      const receiver = await Actor.spawn(Receiver, {});
      const sender = await Actor.spawn(Sender, { receiver });
      slowOutcome = slow.run().then(() => null, (error: unknown) => error);
      await compensationStarted.promise;
      await sender.send();
      throw new Error("outer rollback");
    })).rejects.toThrow("outer rollback");

    expect(senderUndos).toBe(1);
    expect(hits).toBe(0);
    releaseCompensation.resolve();
    expect(await slowOutcome).toMatchObject({ message: "slow failed" });
  });

  it("5g — compensation calling back into the failing orchestrator fails fast instead of hanging", async () => {
    let undoRuns = 0;
    let notifyRuns = 0;
    const originalFailure = new Error("original orchestration failure");
    class Compensator extends Actor<Compensator, {}> {
      @action async run(orchestrator: ActorRef<Orchestrator>) { defer(this.undo, orchestrator); }
      @action async undo(orchestrator: ActorRef<Orchestrator>) {
        undoRuns += 1;
        await orchestrator.notify();
      }
    }
    class Orchestrator extends Actor<Orchestrator, { compensator: ActorRef<Compensator> }> {
      @state accessor compensator = this.input.compensator;
      @action async orchestrate(self: ActorRef<Orchestrator>) {
        await this.compensator.run(self);
        throw originalFailure;
      }
      @action async notify() { notifyRuns += 1; }
    }

    const failure = await completesBeforeTimeout(Actor.transaction(async () => {
      const compensator = await Actor.spawn(Compensator, {});
      const orchestrator = await Actor.spawn(Orchestrator, { compensator });
      await orchestrator.orchestrate(orchestrator);
    })).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ActorCompensationError);
    if (!(failure instanceof ActorCompensationError)) throw new Error("Expected ActorCompensationError");
    expect(failure.cause).toBe(originalFailure);
    expect(failure.errors).toHaveLength(1);
    expect(failure.errors[0]).toBeInstanceOf(ActorReentrancyError);
    expect(undoRuns).toBe(1);
    expect(notifyRuns).toBe(0);
  });

  it("5h — collects root compensation failures in execution order and retains the original cause", async () => {
    const calls: string[] = [];
    const originalFailure = new Error("transaction failure");
    class Compensator extends Actor<Compensator, {}> {
      @action async run() { defer(this.undo, "first"); defer(this.undo, "second"); }
      @action async undo(label: string) { calls.push(label); throw new Error(`undo ${label} failed`); }
    }

    const failure = await Actor.transaction(async () => {
      const ref = await Actor.spawn(Compensator, {});
      await ref.run();
      throw originalFailure;
    }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ActorCompensationError);
    if (!(failure instanceof ActorCompensationError)) throw new Error("Expected ActorCompensationError");
    expect(failure.cause).toBe(originalFailure);
    expect(calls).toEqual(["second", "first"]);
    expect(failure.errors.map((error) => (error as Error).message)).toEqual(["undo second failed", "undo first failed"]);
  });

  it("5i — flattens nested compensation failures while preserving the original action cause", async () => {
    const originalFailure = new Error("nested action failed");
    const innerFailure = new Error("inner undo failed");
    const outerFailure = new Error("outer undo failed");
    class NestedCompensationActor extends Actor<NestedCompensationActor, {}> {
      @action async run() {
        defer(this.undoOuter);
        await this.inner();
      }
      @action async inner() {
        defer(this.undoInner);
        throw originalFailure;
      }
      @action async undoInner() { throw innerFailure; }
      @action async undoOuter() { throw outerFailure; }
    }

    await Actor.transaction(async () => {
      const ref = await Actor.spawn(NestedCompensationActor, {});
      const failure = await ref.run().then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(ActorCompensationError);
      if (!(failure instanceof ActorCompensationError)) throw new Error("Expected ActorCompensationError");
      expect(failure.cause).toBe(originalFailure);
      expect(failure.errors).toEqual([innerFailure, outerFailure]);
    });
  });

  it("3a — re-persists the action start snapshot after a nested cross-actor commit then failure", async () => {
    class CommitPointActor extends Actor<CommitPointActor, {}> {
      @action async ping() { return "pong"; }
    }
    class RollbackAfterCommitActor extends Actor<RollbackAfterCommitActor, { peer: ActorRef<CommitPointActor> }> {
      @state accessor n = 0;
      @state accessor peer = this.input.peer;
      @action async inner() { this.n = 5; await this.peer.ping(); }
      @action async run() { await this.inner(); throw new Error("abort after commit point"); }
    }

    await Actor.transaction(async () => {
      const peer = await Actor.spawn(CommitPointActor, {});
      const ref = await Actor.spawn(RollbackAfterCommitActor, { peer });
      await expect(ref.run()).rejects.toThrow("abort after commit point");
      await Actor.refreshValues(ref);
      expect(ref.n).toBe(0);
    });
  });

  it("3b — keeps a ref dropped at a commit point alive when the action rolls back", async () => {
    class Boundary extends Actor<Boundary, {}> {
      @action async ping() { return "boundary"; }
    }
    class Child extends Actor<Child, {}> {
      @action async ping() { return "alive"; }
    }
    class RefHolder extends Actor<RefHolder, { boundary: ActorRef<Boundary>; child: ActorRef<Child> }> {
      @state accessor boundary = this.input.boundary;
      @state accessor child: ActorRef<Child> | null = this.input.child;
      @action async dropThenFail() {
        this.child = null;
        await this.boundary.ping();
        throw new Error("rollback ref drop");
      }
      @action async pingChild() { return this.child!.ping(); }
    }

    await Actor.transaction(async () => {
      const boundary = await Actor.spawn(Boundary, {});
      const child = await Actor.spawn(Child, {});
      const holder = await Actor.spawn(RefHolder, { boundary, child });
      await expect(holder.dropThenFail()).rejects.toThrow("rollback ref drop");
      await Actor.refreshValues(holder);
      expect(holder.child?.id).toBe(child.id);
      expect(await holder.pingChild()).toBe("alive");
    });
  });

  it("6 — rejects A to B to A reentrancy but allows another instance of the same class", async () => {
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

  it("7 — commits detached messages to the outbox and drops them on rollback", async () => {
    const processed = deferred();
    class Receiver extends Actor<Receiver, {}> {
      @state accessor count = 0;
      @action async hit() { this.count += 1; processed.resolve(); }
    }
    class Sender extends Actor<Sender, { receiver: ActorRef<Receiver> }> {
      @state accessor receiver = this.input.receiver;
      @action async sendThenFail() { this.receiver.hit.runDetached(); throw new Error("rollback"); }
      @action async send() { this.receiver.hit.runDetached(); }
    }

    let receiver!: ActorRef<Receiver>;
    let sender!: ActorRef<Sender>;
    await Actor.transaction(async () => {
      receiver = await Actor.spawn(Receiver, {});
      sender = await Actor.ofNamed(Sender, "detached-outbox-sender").orSpawn(() => ({ receiver }));
      await expect(sender.sendThenFail()).rejects.toThrow("rollback");
    });
    await turn();
    await Actor.transaction(async () => { expect(receiver.count).toBe(0); });

    await Actor.transaction(() => sender.send());
    await processed.promise;
    await Actor.transaction(async () => { expect(receiver.count).toBe(1); });
  });

  it("8 — kills an actor spawned by an action that later fails", async () => {
    let child!: ActorRef<SpawnedChild>;
    class SpawnedChild extends Actor<SpawnedChild, {}> {
      @action async ping() { return "alive"; }
    }
    class Spawner extends Actor<Spawner, {}> {
      @action async spawnThenFail() { child = await Actor.spawn(SpawnedChild, {}); throw new Error("abort"); }
    }

    await Actor.transaction(async () => {
      const spawner = await Actor.spawn(Spawner, {});
      await expect(spawner.spawnThenFail()).rejects.toThrow("abort");
      await expect(child.ping()).rejects.toBeInstanceOf(ActorKilledError);
    });
  });

  it("9 — collects unheld anonymous actors and retains refs stored in actor state", async () => {
    let child!: ActorRef<LifeActor>;
    class LifeActor extends Actor<LifeActor, {}> {
      @action async ping() { return "alive"; }
    }
    class Holder extends Actor<Holder, {}> {
      @state accessor child: ActorRef<LifeActor> | null = null;
      @action async keep(ref: ActorRef<LifeActor>) { this.child = ref; }
      @action async drop() { this.child = null; }
    }

    let holder!: ActorRef<Holder>;
    await Actor.transaction(async () => {
      child = await Actor.spawn(LifeActor, {});
      holder = await Actor.ofNamed(Holder, "lifetime-holder").orSpawn(() => ({}));
      await holder.keep(child);
      expect(await child.ping()).toBe("alive");
    });
    await Actor.transaction(() => holder.drop());
    await expect(Actor.transaction(() => child.ping())).rejects.toBeInstanceOf(ActorKilledError);

    const messageStarted = deferred();
    const releaseMessage = deferred();
    const messageFinished = deferred();
    class MessageRecipient extends Actor<MessageRecipient, {}> {
      @action async holdReference(ref: ActorRef<LifeActor>) {
        messageStarted.resolve();
        await releaseMessage.promise;
        await ref.ping();
        messageFinished.resolve();
      }
    }
    class MessageSender extends Actor<MessageSender, { recipient: ActorRef<MessageRecipient> }> {
      @state accessor recipient = this.input.recipient;
      @action async send(ref: ActorRef<LifeActor>) { this.recipient.holdReference.runDetached(ref); }
    }
    let inFlightChild!: ActorRef<LifeActor>;
    await Actor.transaction(async () => {
      inFlightChild = await Actor.spawn(LifeActor, {});
      const recipient = await Actor.spawn(MessageRecipient, {});
      const sender = await Actor.spawn(MessageSender, { recipient });
      await sender.send(inFlightChild);
    });
    await messageStarted.promise;
    await Actor.transaction(async () => { expect(await inFlightChild.ping()).toBe("alive"); });
    releaseMessage.resolve();
    await messageFinished.promise;
    await turn();
    await expect(Actor.transaction(() => inFlightChild.ping())).rejects.toBeInstanceOf(ActorKilledError);
  });

  it("9a — kills an anonymous ref returned from the top-level transaction", async () => {
    class ReturnedActor extends Actor<ReturnedActor, {}> {
      @state accessor value = "cached";
      @action async ping() { return "alive"; }
    }

    const ref = await Actor.transaction(() => Actor.spawn(ReturnedActor, {}));
    await Actor.transaction(async () => {
      expect(ref.value).toBe("cached");
      await expect(ref.ping()).rejects.toBeInstanceOf(ActorKilledError);
    });
  });

  it("10 — serializes refs as type/id data and refreshes a restored ref snapshot", async () => {
    class SnapshotActor extends Actor<SnapshotActor, {}> {
      @state accessor value = 7;
    }
    class SnapshotHolder extends Actor<SnapshotHolder, { child: ActorRef<SnapshotActor> }> {
      @state accessor child = this.input.child;
    }

    let holder!: ActorRef<SnapshotHolder>;
    await Actor.transaction(async () => {
      const ref = await Actor.spawn(SnapshotActor, {});
      const wire = structuredClone(ref);
      expect(wire).toEqual({ type: "SnapshotActor", id: ref.id });
      expect(Object.keys(ref)).toEqual(["type", "id"]);
      holder = await Actor.ofNamed(SnapshotHolder, "snapshot-holder").orSpawn(() => ({ child: ref }));
    });
    await Actor.transaction(async () => {
      const restored = holder.child;
      __evictSnapshotCacheForTest(restored);
      expect(() => restored.value).toThrow(ActorSnapshotUnavailableError);
      await Actor.refreshValues(restored);
      expect(restored.value).toBe(7);
    });
  });

  it("11 — updates state and derived values from a field-level action reply (NimGame)", async () => {
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

    await Actor.transaction(async () => {
      const game = await Actor.spawn(NimGame, { players: [] });
      await game.enter("alice");
      await game.enter("bob");
      await expect(game.enter("charlie")).rejects.toThrow("game full");
      expect(game.currentPlayer).toBe("alice");
      expect(game.isOver).toBe(false);
      await expect(game.take("bob", 1)).rejects.toThrow("not your turn");
      await expect(game.take("alice", 0)).rejects.toThrow("invalid take");
      expect(await game.take("alice", 3)).toBe(8);
      const diffReply = __lastActionReplyForTest()!;
      expect(diffReply.isDiff).toBe(true);
      expect(diffReply.baseVersion).toBe(diffReply.startVersion);
      expect(Object.keys(diffReply.snapshot).sort()).toEqual(["currentPlayer", "isOver", "loser", "started", "stonesLeft", "turn", "winner"].sort());
      expect(game.stonesLeft).toBe(8);
      expect(game.currentPlayer).toBe("bob");
      await expect(game.enter("charlie")).rejects.toThrow("game already started");
      __evictSnapshotCacheForTest(game);
      expect(await game.take("bob", 1)).toBe(7);
      const fullReply = __lastActionReplyForTest()!;
      expect(fullReply.isDiff).toBe(false);
      expect(Object.keys(fullReply.snapshot).sort()).toEqual(["currentPlayer", "isOver", "loser", "players", "started", "stonesLeft", "turn", "winner"].sort());
      await game.take("alice", 3);
      await game.take("bob", 3);
      await game.take("alice", 1);
      expect(game.isOver).toBe(true);
      expect(game.winner).toBe("alice");
      expect(game.loser).toBe("bob");
      await expect(game.take("bob", 1)).rejects.toThrow("game over");
    });
  });

  it("12 — clone-checks action results and rehydrates returned actor refs", async () => {
    const resultSymbol = Symbol("result");
    class ResultChild extends Actor<ResultChild, {}> {
      @action async ping() { return "alive"; }
    }
    class ClassWithMethod {
      value = 1;
      method() { return this.value; }
    }
    let undoRuns = 0;
    let originalResult!: { nested: { value: number } };
    class ResultActor extends Actor<ResultActor, {}> {
      @state accessor value = 0;
      @action async badFunction() {
        this.value = 1;
        defer(this.undo);
        return (() => 1) as unknown as undefined;
      }
      @action async badClass() { return new ClassWithMethod() as unknown as { value: number }; }
      @action async badSymbolKey() {
        return { a: 1, [resultSymbol]: () => 1 } as unknown as { a: number };
      }
      @action async badSymbolData() {
        return { a: 1, [resultSymbol]: 2 } as unknown as { a: number };
      }
      @action async plainObject() {
        originalResult = { nested: { value: 3 } };
        return originalResult;
      }
      @action async makeChild() { return await Actor.spawn(ResultChild, {}); }
      @action async undo() { undoRuns += 1; }
    }

    await Actor.transaction(async () => {
      const ref = await Actor.spawn(ResultActor, {});
      await expect(ref.badFunction()).rejects.toBeInstanceOf(ActorResultSerializationError);
      await Actor.refreshValues(ref);
      expect(ref.value).toBe(0);
      expect(undoRuns).toBe(1);
      await expect(ref.badClass()).rejects.toBeInstanceOf(ActorResultSerializationError);
      await expect(ref.badSymbolKey()).rejects.toBeInstanceOf(ActorResultSerializationError);
      await expect(ref.badSymbolData()).rejects.toBeInstanceOf(ActorResultSerializationError);

      const result = await ref.plainObject();
      expect(result).toEqual(originalResult);
      expect(result).not.toBe(originalResult);
      expect(result.nested).not.toBe(originalResult.nested);

      const child = await ref.makeChild();
      expect(await child.ping()).toBe("alive");
    });
  });

  it("13 — generic actor classes work when spawned with a pinned item type", async () => {
    class Queue<T extends Cloneable> extends Actor<Queue<T>, { items: T[] }> {
      @state accessor items: T[] = this.input.items;
      @action async push(item: T) { this.items = [...this.items, item]; }
      @action async pop(): Promise<T | undefined> {
        const [item, ...remaining] = this.items;
        this.items = remaining;
        return item;
      }
    }

    await Actor.transaction(async () => {
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

  it("14 — generic action methods keep their call-site type on refs", async () => {
    class EchoActor extends Actor<EchoActor, {}> {
      @action async echo<T extends Cloneable>(value: T): Promise<T> { return value; }
      @action async selfy(this: EchoActor): Promise<number> { return 42; }
    }

    await Actor.transaction(async () => {
      const ref = await Actor.spawn(EchoActor, {});
      expect(await ref.echo(5)).toBe(5);
      expect(await ref.echo("a")).toBe("a");
      expect(await ref.selfy()).toBe(42);
    });
  });

  it("named actors reuse one rooted instance and actor operations require a transaction", async () => {
    class NamedCounter extends Actor<NamedCounter, { count: number }> {
      @state accessor count = this.input.count;
    }
    expect(() => Actor.ofNamed(NamedCounter, "singleton")).toThrow(NoActiveTransactionError);
    await expect(Actor.spawn(NamedCounter, { count: 0 })).rejects.toBeInstanceOf(NoActiveTransactionError);

    await Actor.transaction(async () => {
      const named = Actor.ofNamed(NamedCounter, "singleton");
      expect(await named.orNull()).toBeNull();
      const [first, second] = await Promise.all([
        named.orSpawn(() => ({ count: 1 })),
        named.orSpawn(() => ({ count: 2 })),
      ]);
      expect(first.id).toBe(second.id);
      expect(first.count).toBe(1);
    });

    await Actor.transaction(async () => {
      const existing = await Actor.ofNamed(NamedCounter, "singleton").orSpawn(() => ({ count: 3 }));
      expect(existing.count).toBe(1);
    });
  });
});
