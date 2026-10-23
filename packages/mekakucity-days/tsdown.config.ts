import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts", "./src/testing.ts"],
  dts: { sourcemap: true },
  external: ["@mekakucity/actors"],
});
