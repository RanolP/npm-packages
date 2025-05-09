import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    './src',
    './src/builtin-parsers',
    './src/builtin-generators',
    './src/vite',
  ],

  dts: {
    sourcemap: true,
  },
});
