import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import withSoonloh from './metro.js';
import { config as defineConfig } from './core/config.js';
import { snzrwm } from './builtin-parsers/index.js';
import { genLink } from './builtin-generators/index.js';

describe('withSoonloh (metro)', () => {
  const cwd = process.cwd();
  afterEach(() => process.chdir(cwd));

  it('returns the same config object and generates routes on load', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'soonloh-metro-'));
    try {
      // Scaffold a minimal router root with one page.
      await mkdir(path.join(dir, 'src/app/home'), { recursive: true });
      await writeFile(path.join(dir, 'src/app/home/page.tsx'), '');
      process.chdir(dir);

      const metroConfig = { transformer: { marker: 1 } };
      const returned = withSoonloh(metroConfig, {
        watch: false,
        config: defineConfig({
          routerRoot: 'src/app/',
          parser: snzrwm.parser({}),
          generators: [genLink({})],
        }),
      });

      // Config is passed through untouched.
      expect(returned).toBe(metroConfig);

      // Codegen ran to disk. loadConfig + generate + 10ms debounce are async,
      // so poll briefly for the generated file.
      const target = path.join(dir, 'src/generated/link.ts');
      let generated = '';
      for (let i = 0; i < 50 && !generated; i++) {
        generated = await readFile(target, 'utf-8').catch(() => '');
        if (!generated) await new Promise((r) => setTimeout(r, 20));
      }

      expect(generated).toContain('export interface LinkMap');
      expect(generated).toContain('"/home"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
