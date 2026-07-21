import { describe, it, expect } from 'vitest';
import { transform } from './transform.js';
import { parseId, isIncluded } from './query.js';
import type { Selection } from './types.js';

const pick = (...names: string[]): Selection => ({
  mode: 'pick',
  names: new Set(names),
});
const drop = (...names: string[]): Selection => ({
  mode: 'drop',
  names: new Set(names),
});

function run(code: string, selection: Selection): string {
  return transform('module.ts', code, selection)?.code ?? code;
}

describe('transform — the export forms the rotted PR missed', () => {
  const routeModule = `import fs from 'node:fs/promises';
import { useState } from 'react';

const helper = () => 'internal';

export async function loader() {
  return fs.readFile('list.json', 'utf-8');
}

export const meta = () => ({ title: 'Page' });

export default function Page() {
  useState('');
  return helper();
}`;

  it('pick keeps only picked exports (exported declarations are handled)', () => {
    const out = run(routeModule, pick('loader', 'meta'));
    expect(out).toContain('export async function loader');
    expect(out).toContain('export const meta');
    // default export removed...
    expect(out).not.toContain('export default');
    expect(out).not.toContain('function Page');
    // ...along with the helper only the removed default export used.
    expect(out).not.toContain('helper');
    // Imports still reached by a surviving export stay.
    expect(out).toContain("import fs from 'node:fs/promises'");
  });

  it('pick default keeps only the default export', () => {
    const out = run(routeModule, pick('default'));
    expect(out).toContain('export default function Page');
    expect(out).not.toContain('export async function loader');
    expect(out).not.toContain('export const meta');
  });

  it('drop removes the named export and leaves the rest', () => {
    const out = run(routeModule, drop('loader'));
    expect(out).not.toContain('export async function loader');
    expect(out).toContain('export const meta');
    expect(out).toContain('export default function Page');
  });

  it('handles exported class declarations', () => {
    const out = run(
      `export class Kept {}\nexport class Gone {}`,
      pick('Kept'),
    );
    expect(out).toContain('class Kept');
    expect(out).not.toContain('class Gone');
  });
});

describe('transform — reachability sweep (server code off the client)', () => {
  const module = `import fs from 'node:fs/promises';
import { useState } from 'react';
import './styles.css';

const readList = () => fs.readFile('list.json', 'utf-8');
const useFilter = () => useState('');

export async function loader() {
  return readList();
}

export default function Page() {
  useFilter();
  return null;
}`;

  it('removes server-only imports and helpers when picking the client export', () => {
    const out = run(module, pick('default'));
    // Server-only chain (loader -> readList -> fs) is gone entirely.
    expect(out).not.toContain('node:fs/promises');
    expect(out).not.toContain('readList');
    expect(out).not.toContain('function loader');
    // Client chain survives.
    expect(out).toContain("import { useState } from 'react'");
    expect(out).toContain('useFilter');
    expect(out).toContain('export default function Page');
    // Bare side-effect import is never dropped.
    expect(out).toContain("import './styles.css'");
  });

  it('removes client-only imports and helpers when picking the server export', () => {
    const out = run(module, pick('loader'));
    expect(out).toContain("import fs from 'node:fs/promises'");
    expect(out).toContain('readList');
    expect(out).not.toContain("from 'react'");
    expect(out).not.toContain('useFilter');
    expect(out).not.toContain('function Page');
  });

  it('keeps an import shared by a surviving and a removed export', () => {
    const out = run(
      `import { log } from 'logger';
export const server = () => log('server');
export const client = () => log('client');`,
      pick('client'),
    );
    expect(out).toContain("import { log } from 'logger'");
    expect(out).toContain('client');
    expect(out).not.toContain('server');
  });
});

describe('transform — declarator and specifier lists', () => {
  it('splits a multi-declarator export, re-emitting survivors', () => {
    const out = run(`export const a = 1, b = 2, c = 3;`, pick('a', 'c'));
    expect(out).toBe('export const a = 1, c = 3;');
  });

  it('drops the whole statement when every declarator is excluded', () => {
    const out = run(`export const a = 1, b = 2;`, drop('a', 'b'));
    expect(out.trim()).toBe('');
  });

  it('prunes an `export { ... }` specifier list', () => {
    const out = run(
      `const a = 1, b = 2;\nexport { a, b };`,
      pick('a'),
    );
    expect(out).toContain('export { a };');
    expect(out).not.toMatch(/export \{ a, b \}/);
  });

  it('rewrites the exported (aliased) name, not the local one', () => {
    const out = run(
      `const x = 1;\nexport { x as keep };`,
      drop('other'),
    );
    // `keep` is not dropped, so the statement survives unchanged.
    expect(out).toContain('export { x as keep };');
  });
});

describe('transform — leaves things alone', () => {
  it('returns null when nothing is excluded', () => {
    expect(transform('m.ts', `export const a = 1;`, pick('a'))).toBeNull();
  });

  it('preserves type-only exports', () => {
    const out = run(
      `export type T = number;\nexport const value = 1;`,
      pick('value'),
    );
    expect(out).toContain('export type T = number;');
  });
});

describe('parseId', () => {
  it('parses repeated and comma-separated pick params', () => {
    expect(parseId('a.js?pick=x&pick=y')).toEqual({
      path: 'a.js',
      selection: { mode: 'pick', names: new Set(['x', 'y']) },
    });
    expect(parseId('a.js?pick=x,y')).toEqual({
      path: 'a.js',
      selection: { mode: 'pick', names: new Set(['x', 'y']) },
    });
  });

  it('returns a null selection when no query is present', () => {
    expect(parseId('a.js')).toEqual({ path: 'a.js', selection: null });
  });

  it('throws when pick and drop are combined', () => {
    expect(() => parseId('a.js?pick=x&drop=y')).toThrow(/cannot be used/);
  });
});

describe('isIncluded', () => {
  it('is the set membership for pick and its complement for drop', () => {
    expect(isIncluded(pick('a'), 'a')).toBe(true);
    expect(isIncluded(pick('a'), 'b')).toBe(false);
    expect(isIncluded(drop('a'), 'a')).toBe(false);
    expect(isIncluded(drop('a'), 'b')).toBe(true);
  });
});
