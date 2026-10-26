import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts"],
  dts: { sourcemap: true },
  external: ["@mekakucity/actors", /^cloudflare:/],
});
