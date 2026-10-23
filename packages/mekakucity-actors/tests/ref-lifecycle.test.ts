import { Actor, ActorKilledError, ActorResultSerializationError, ActorSnapshotUnavailableError, defer, action, state } from "../src/index.js";
import type { ActorRef } from "../src/index.js";
import { __evictSnapshotCacheForTest } from "../src/runtime.js";
import { describe, expect, it } from "vitest";
import { deferred, turn } from "./helpers.js";

describe("@mekakucity/actors ref lifecycle", () => {
  it("keeps a ref dropped at a commit point alive when the action rolls back", async () => {
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

  it("commits detached messages to the outbox and drops them on rollback", async () => {
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

  it("kills an actor spawned by an action that later fails", async () => {
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

  it("collects unheld anonymous actors and retains refs stored in actor state", async () => {
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

  it("kills an anonymous ref returned from the top-level transaction", async () => {
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

  it("serializes refs as type/id data and refreshes a restored ref snapshot", async () => {
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

  it("clone-checks action results and rehydrates returned actor refs", async () => {
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
});
