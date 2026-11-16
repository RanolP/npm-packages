import { defineConfig } from "tsdown";
import { fileURLToPath } from "node:url";

const asyncHooksAlias = {
  "node:async_hooks": fileURLToPath(new URL("./src/async-local-storage.ts", import.meta.url)),
};

export default defineConfig([
  {
    entry: ["./src/index.ts"],
    dts: { sourcemap: true },
    external: ["@mekakucity/actors"],
  },
  {
    entry: { counter: "./.fixture-build/fixtures/counter/index.js" },
    outDir: "./fixtures/counter/dist",
    format: "iife",
    platform: "neutral",
    target: "es2022",
    dts: false,
    sourcemap: false,
    alias: asyncHooksAlias,
    noExternal: [/@mekakucity\/actors/],
  },
]);
