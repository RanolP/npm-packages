# unplugin-pick

Selective imports for all

## Installation

```bash
npm install -D unplugin-pick
```

```bash
pnpm add -D unplugin-pick
```

```bash
yarn add -D unplugin-pick
```

## Overview

unplugin-pick allows the `?pick` and `?drop` queries on the import statement.
It's especially useful for automagically splitting server/client bundle for the framework developers.
For example:

```tsx
import fs from 'node:fs/promises';
import { useState } from 'react';

export const loader = () => fs.readFile('list.json', { encoding: 'utf-8' });

export default function Page({ loaderData }: Route.ComponentProps) {
  const filter = useState('');

  return <div>...</div>;
}
```

the `fs` available in Node, and `useState` available in Browser.
You must split the bundle to use it properly. However it could worse the DX.
Here's the solution: The framework to handle this.

```ts
const serverBundle = import('user.js?pick=loader&pick=meta&...');
```

```ts
const clientBundle = import('user.js?pick=default&pick=clientLoader&...');
```

Originally the idea happens from major frameworks like Next.js, vinxi, etc. I made it as a independent package.
