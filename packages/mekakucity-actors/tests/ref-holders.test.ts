import { describe, expect, it } from "vitest";
import { actorHolder, applyHolderOp, messageHolder } from "../src/runtime/index.js";

describe("holder protocol", () => {
  it("a release arriving before its hold does not collect while a temporary holder exists", () => {
    const holders = new Set([messageHolder("m1")]);
    expect(applyHolderOp(holders, { kind: "release", target: "a", holder: actorHolder("b") }).collect).toBe(false);
    applyHolderOp(holders, { kind: "hold", target: "a", holder: actorHolder("b") });
    expect(applyHolderOp(holders, { kind: "release", target: "a", holder: messageHolder("m1") }).collect).toBe(false);
  });
});
