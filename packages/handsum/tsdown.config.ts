import { defineConfig } from 'tsdown';

export default defineConfig({
  // Package-specific entry point
  entry: './src/index.ts',

  // Package-specific DTS configuration
  dts: {
    sourcemap: true,
  },

  // Package-specific externals (in addition to global ones)
  external: ['vitest'],

  // Inherit format from root config (esm, cjs)
  // format: ['esm', 'cjs'],

  // Package-specific target if different from root
  // target: 'node18',
});