import { defineConfig } from 'tsdown';

export default defineConfig({
  // Package-specific entry points
  entry: [
    './src',
    './src/builtin-parsers',
    './src/builtin-generators',
    './src/vite',
    './src/rt',
  ],

  // Package-specific DTS configuration
  dts: {
    sourcemap: true,
  },

  // Package-specific externals (in addition to global ones)
  external: ['unplugin', 'fast-check', 'vitest'],

  // Override output format if needed (inherits from root config)
  // format: ['esm', 'cjs'],

  // Package-specific target if different from root
  // target: 'node18',
});
