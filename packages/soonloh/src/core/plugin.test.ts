import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SoonlohPlugin } from './plugin.js';
import { config as defineConfig, Config } from './config.js';

describe('SoonlohPlugin hardening', () => {
  const cwd = process.cwd();
  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
  });

  it('missing soonloh.config.ts is diagnosed without rejecting (#8)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'soonloh-hardening-'));
    try {
      process.chdir(dir);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const plugin = new SoonlohPlugin({});
      await expect(plugin.loadConfig()).resolves.toBeUndefined();
      await expect(plugin.generate()).resolves.toMatchObject({ ok: true });
      expect(errors.mock.calls.flat().join('\n')).toContain(
        'config file not found',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('config missing properties is diagnosed without throwing (#9)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const plugin = new SoonlohPlugin({
      config: { routerRoot: 'src/app/' } as Config,
    });
    await expect(plugin.loadConfig()).resolves.toBeUndefined();
    await expect(plugin.generate()).resolves.toMatchObject({ ok: true });
    const diagnostic = errors.mock.calls.flat().join('\n');
    expect(diagnostic).toContain('`parser` must be a function');
    expect(diagnostic).toContain('`generators` must be an array');
  });

  it('missing router root directory is diagnosed without rejecting (#10)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'soonloh-hardening-'));
    try {
      process.chdir(dir);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const plugin = new SoonlohPlugin({
        config: defineConfig({
          routerRoot: 'does-not-exist/',
          parser: () => null,
          generators: [],
        }),
      });
      await plugin.loadConfig();
      await expect(plugin.generate()).resolves.toMatchObject({ ok: true });
      expect(errors.mock.calls.flat().join('\n')).toContain(
        'router root not found',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
