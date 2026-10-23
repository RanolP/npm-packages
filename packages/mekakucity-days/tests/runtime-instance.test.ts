import { expect, it } from "vitest";
import { InMemoryActorRuntime } from "../src/index.js";

it("runs a transaction directly against its owning runtime instance", async () => {
  const runtime = new InMemoryActorRuntime();
  await expect(runtime.transaction(() => 1)).resolves.toBe(1);
});
