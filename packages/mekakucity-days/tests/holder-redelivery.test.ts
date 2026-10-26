import { actorHolder, messageHolder, type HolderOp } from "@mekakucity/actors/runtime";
import { expect, it } from "vitest";
import { InMemoryStore, type ActorRecord } from "../src/ref/in-memory-store.js";

const record = (id: string, holders: string[], heldRefs: string[] = []): ActorRecord => ({
  id,
  type: "T",
  instance: {},
  mailbox: { tail: Promise.resolve() },
  holders: new Set(holders),
  heldRefs: new Set(heldRefs),
  version: 0,
  snapshot: {},
  killed: false,
});

// A committed op may be delivered twice (at-least-once); redelivery must neither collect early nor leak.
it("redelivered hold/release entries neither collect the target early nor leak it", async () => {
  const store = new InMemoryStore();
  await store.register(record("target", [messageHolder("m1")], ["child"]));
  await store.register(record("child", [actorHolder("target")]));
  const deliver = async (op: HolderOp) => { await store.applyHolderOp(op); return store.applyHolderOp(op); };

  await deliver({ kind: "hold", target: "target", holder: actorHolder("a") });
  await deliver({ kind: "release", target: "target", holder: messageHolder("m1") });
  expect(await store.route("target")).toBeDefined();

  const first = await store.applyHolderOp({ kind: "release", target: "target", holder: actorHolder("a") });
  expect(await store.route("target")).toBeUndefined();
  const cascade = first[0]!;
  expect(first).toEqual([{ kind: "release", target: "child", holder: actorHolder("target") }]);
  expect(await store.applyHolderOp({ kind: "release", target: "target", holder: actorHolder("a") })).toEqual([]);

  expect(await store.applyHolderOp(cascade)).toEqual([]);
  expect(await store.route("child")).toBeUndefined();
  expect(await store.applyHolderOp(cascade)).toEqual([]);
});
