import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { build } from 'tsdown';
import { randomUUID } from 'crypto';

async function withTestDir(fn: (testDir: string) => Promise<void>) {
  const testDir = join(tmpdir(), 'unplugin-pick-test', randomUUID());
  mkdirSync(testDir, { recursive: true });
  try {
    await fn(testDir);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
}

describe('unplugin-pick e2e with tsdown', { concurrent: true }, () => {
  describe('pick mode - server/client code splitting', () => {
    it('should build server bundle with pick mode', () =>
      withTestDir(async (testDir) => {
        const testFile = join(testDir, 'server-client.ts');
        writeFileSync(testFile, `
import fs from 'node:fs/promises';
export async function loader() {
  return fs.readFile('data.json', 'utf-8');
}
export default function Page() {
  return '<div>Page</div>';
}
export function unused() {
  return 'unused';
}
`);

        const outDir = join(testDir, 'dist-pick');
        await build({ entry: testFile, outDir, format: 'esm' });

        expect(existsSync(join(outDir, 'server-client.js'))).toBe(true);
        expect(existsSync(join(outDir, 'server-client.d.ts'))).toBe(true);
        expect(readFileSync(join(outDir, 'server-client.js'), 'utf-8').length).toBeGreaterThan(0);
      }));

    it('should build client bundle with multiple picks', () =>
      withTestDir(async (testDir) => {
        const testFile = join(testDir, 'multi-export.ts');
        writeFileSync(testFile, `
export function a() { return 'a'; }
export function b() { return 'b'; }
export function c() { return 'c'; }
export function d() { return 'd'; }
`);

        const outDir = join(testDir, 'dist-multi');
        await build({ entry: testFile, outDir, format: 'esm' });

        const jsFile = join(outDir, 'multi-export.js');
        expect(existsSync(jsFile)).toBe(true);
        expect(readFileSync(jsFile, 'utf-8')).toMatch(/export/);
      }));
  });

  describe('drop mode - excluding debug code', () => {
    it('should build production bundle without debug exports', () =>
      withTestDir(async (testDir) => {
        const testFile = join(testDir, 'debug-api.ts');
        writeFileSync(testFile, `
export const config = { debug: true };
export function api() { return 'api'; }
export function debugLog() { console.log('[DEBUG]', 'debug'); }
export function debugMetrics() { return { mem: 0 }; }
`);

        const outDir = join(testDir, 'dist-drop');
        await build({ entry: testFile, outDir, format: 'esm' });

        const jsFile = join(outDir, 'debug-api.js');
        expect(existsSync(jsFile)).toBe(true);
        expect(readFileSync(jsFile, 'utf-8')).toContain('api');
      }));
  });

  describe('plugin integration with tsdown', () => {
    it('should preserve internal helpers during build', () =>
      withTestDir(async (testDir) => {
        const testFile = join(testDir, 'with-helpers.ts');
        writeFileSync(testFile, `
const internalHelper = () => 'help';
export function publicAPI() { return internalHelper(); }
export function unused() { return 'unused'; }
`);

        const outDir = join(testDir, 'dist-helpers');
        await build({ entry: testFile, outDir, format: 'esm' });

        const jsFile = join(outDir, 'with-helpers.js');
        const content = readFileSync(jsFile, 'utf-8');
        expect(content).toContain('internalHelper');
        expect(content).toContain('publicAPI');
      }));

    it('should handle TypeScript types correctly in build', () =>
      withTestDir(async (testDir) => {
        const testFile = join(testDir, 'typed-module.ts');
        writeFileSync(testFile, `
export interface User { id: string; name: string; }
export type Config = { debug: boolean; };
export function getUser(id: string): User { return { id, name: 'John' }; }
export function debugMode(): boolean { return true; }
`);

        const outDir = join(testDir, 'dist-types');
        await build({ entry: testFile, outDir, format: 'esm' });

        const dtsFile = join(outDir, 'typed-module.d.ts');
        const dtsContent = readFileSync(dtsFile, 'utf-8');
        expect(dtsContent).toContain('User');
        expect(dtsContent).toContain('Config');
      }));

    it('should handle default exports in build', () =>
      withTestDir(async (testDir) => {
        const testFile = join(testDir, 'default-export.ts');
        writeFileSync(testFile, `
export default function Component() { return '<div>Component</div>'; }
export function helper() { return 'help'; }
`);

        const outDir = join(testDir, 'dist-default');
        await build({ entry: testFile, outDir, format: 'esm' });

        const jsFile = join(outDir, 'default-export.js');
        expect(readFileSync(jsFile, 'utf-8')).toMatch(/export/);
      }));

    it('should build with mixed imports and exports', () =>
      withTestDir(async (testDir) => {
        const testFile = join(testDir, 'mixed-module.ts');
        writeFileSync(testFile, `
import { readFileSync } from 'fs';
import type { Stats } from 'fs';
export function readConfig(path: string): string { return readFileSync(path, 'utf-8'); }
export function getStats(): Stats { return {} as Stats; }
export function unused(): void { console.log('unused'); }
`);

        const outDir = join(testDir, 'dist-mixed');
        await build({ entry: testFile, outDir, format: 'esm' });

        const jsFile = join(outDir, 'mixed-module.js');
        const dtsFile = join(outDir, 'mixed-module.d.ts');
        expect(existsSync(jsFile)).toBe(true);
        expect(existsSync(dtsFile)).toBe(true);
      }));
  });

  describe('error handling and edge cases', () => {
    it('should handle empty files during build', () =>
      withTestDir(async (testDir) => {
        const testFile = join(testDir, 'empty.ts');
        writeFileSync(testFile, '');
        const outDir = join(testDir, 'dist-empty');
        await build({ entry: testFile, outDir, format: 'esm' });
        expect(existsSync(join(outDir, 'empty.js'))).toBe(true);
      }));

    it('should handle import-only files during build', () =>
      withTestDir(async (testDir) => {
        const testFile = join(testDir, 'imports-only.ts');
        writeFileSync(testFile, `
import { readFileSync } from 'fs';
import type { Stats } from 'fs';
`);
        const outDir = join(testDir, 'dist-imports');
        await build({ entry: testFile, outDir, format: 'esm' });
        expect(existsSync(join(outDir, 'imports-only.js'))).toBe(true);
      }));

    it('should build complex nested exports', () =>
      withTestDir(async (testDir) => {
        const testFile = join(testDir, 'complex.ts');
        writeFileSync(testFile, `
export const utils = { a: () => 'a', b: () => 'b' };
export function useUtils() { return utils.a(); }
export async function asyncOperation() { return Promise.resolve('done'); }
export class Service { constructor(name: string) { this.name = name; } name: string; }
`);

        const outDir = join(testDir, 'dist-complex');
        await build({ entry: testFile, outDir, format: 'esm' });

        expect(existsSync(join(outDir, 'complex.js'))).toBe(true);
        expect(existsSync(join(outDir, 'complex.d.ts'))).toBe(true);
      }));

    it('should handle arrow function exports', () =>
      withTestDir(async (testDir) => {
        const testFile = join(testDir, 'arrow-exports.ts');
        writeFileSync(testFile, `
export const handler = async () => { return { status: 'ok' }; };
export const validator = (input: string) => { return input.length > 0; };
`);

        const outDir = join(testDir, 'dist-arrow');
        await build({ entry: testFile, outDir, format: 'esm' });

        const jsFile = join(outDir, 'arrow-exports.js');
        expect(readFileSync(jsFile, 'utf-8')).toContain('export');
      }));
  });
});
