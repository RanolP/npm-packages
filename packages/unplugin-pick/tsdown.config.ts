import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src', './src/vite'],
  dts: {
    sourcemap: true,
  },
  external: ['unplugin', 'oxc-parser', 'magic-string', 'vitest'],
});
