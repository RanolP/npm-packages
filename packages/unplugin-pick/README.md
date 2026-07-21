# unplugin-pick

Selective imports for every bundler. Append `?pick=` or `?drop=` to an import
and get back a module with only the exports you asked for — the rest is deleted
before the bundler runs, so anything they alone pulled in tree-shakes away.

## Installation

```bash
pnpm add -D unplugin-pick
```

## Why

A route module often mixes server-only and client-only code:

```tsx
import fs from 'node:fs/promises';
import { useState } from 'react';

export const loader = () => fs.readFile('list.json', 'utf-8');

export default function Page() {
  const [filter, setFilter] = useState('');
  return <div>...</div>;
}
```

`fs` only exists on the server, `useState` only in the browser. Frameworks
(Next.js, vinxi, ...) solve this by splitting the file into per-environment
bundles. `unplugin-pick` gives you that split as a standalone import query:

```ts
const server = await import('./user.tsx?pick=loader&pick=meta');
const client = await import('./user.tsx?pick=default');
```

`?pick=loader&pick=meta` keeps `loader` and `meta` and drops everything else —
and then deletes every import and helper that only the dropped exports reached,
so `useState` (and anything it alone pulled in) is gone from the server module.
Use `?drop=` for the inverse — keep everything except the named exports.

`pick` and `drop` accept repeated params (`?pick=a&pick=b`) or a comma list
(`?pick=a,b`), but the two can't be combined on one import.

## Usage

The package ships an [unplugin](https://unplugin.unjs.io) instance, so every
bundler adapter is available.

```ts
// vite.config.ts
import unpluginPickVite from 'unplugin-pick/vite';

export default {
  plugins: [unpluginPickVite()],
};
```

```ts
// other bundlers
import { unplugin } from 'unplugin-pick';

unplugin.rollup();
unplugin.webpack();
unplugin.esbuild();
```

## Behavior

- Selection is by **export name**; `default` selects the default export.
- After stripping the unselected exports, a reachability sweep deletes every
  top-level import and non-exported declaration no longer reached by a surviving
  export or a top-level side effect. This is what removes server-only code from
  a client `pick` — the plugin doesn't wait for the bundler to tree-shake it.
- Bare side-effect imports (`import './styles.css'`) and top-level statements
  are always kept.
- Type-only exports/imports (`export type`, `import type`) are always kept; they
  are erased downstream regardless.
- `export * from '...'` is left untouched (individual names can't be resolved
  statically).

### Side-effect assumption

The sweep assumes an unused top-level binding is safe to delete — including an
import whose binding is never referenced. If you rely on a value import purely
for its module side effects (`import x from './registers-on-load'` where `x` is
never used), make it a bare `import './registers-on-load'` so it is preserved.

## License

MIT
