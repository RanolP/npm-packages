import { createUnplugin } from 'unplugin';
import { parseId } from './query.js';
import { transform as pickTransform } from './transform.js';

/**
 * The unplugin instance. Use its per-bundler adapters — `unplugin.vite`,
 * `unplugin.rollup`, `unplugin.webpack`, `unplugin.esbuild`, etc.
 */
export const unplugin = createUnplugin(() => ({
  name: 'unplugin-pick',
  enforce: 'pre',
  transform(code, id) {
    const { path, selection } = parseId(id);
    if (!selection) return;
    return pickTransform(path, code, selection) ?? undefined;
  },
}));
