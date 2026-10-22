import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts', './src/effect.ts'],

  dts: {
    sourcemap: true,
  },

  external: ['vitest', 'effect'],
});
