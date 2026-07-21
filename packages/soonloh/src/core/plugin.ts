import path from 'node:path';
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { Config, validateConfig } from './config.js';
import { AbortableTask, AbortedError, runAbortable } from 'p-abort';
import { createSoonlohRuntime } from '../rt.js';

export interface Options {
  config?:
    | {
        path: string;
      }
    | Config;
}

export class SoonlohPlugin {
  // region Constructor
  #options: Options;
  constructor(options: Options) {
    this.#options = options;
    if (this.#options.config && !('path' in this.#options.config)) {
      this.#config = Promise.resolve(this.#options.config);
    }
  }
  // endregion

  // region Paths
  get #root() {
    return process.cwd();
  }
  routerRoot: string | null = null;
  get configPath(): string | null {
    if (!this.#options.config || 'path' in this.#options.config) {
      return path.join(
        this.#root,
        this.#options.config?.path ?? 'soonloh.config.ts',
      );
    } else {
      return null;
    }
  }
  // endregion

  // region Config
  #config: Promise<Config> | null = null;

  hasConfigResolved: boolean = false;

  async loadConfig() {
    const file = this.configPath;
    if (typeof file !== 'string') {
      // Inline config: nothing to import, just resolve the router root from it.
      if (this.#config) {
        try {
          const config = validateConfig(await this.#config, 'inline config');
          this.routerRoot = path.join(this.#root, config.routerRoot);
          this.hasConfigResolved = true;
        } catch (e) {
          this.#config = null;
          logError(e);
        }
      }
      return;
    }
    let mtime: Date;
    try {
      mtime = (await stat(file)).mtime;
    } catch {
      console.error(
        `[soonloh] config file not found: ${file}\n` +
          '          create it (or pass an inline config); codegen is paused until then',
      );
      return;
    }
    if (isFileTs(file)) {
      if (!isDeno() && !isBun() && !isNodeSupportNativeTypeScript()) {
        console.error(
          '[soonloh] this runtime cannot import a TypeScript config file; use Node with native TS support (>= 22.6), Deno, or Bun',
        );
        return;
      }
    }
    const href = pathToFileURL(file).href;
    const promise = import(`${href}?t=${mtime}`).then((module) =>
      validateConfig(module.default, file),
    );
    // Publish the in-flight promise on first load so an early generate() can
    // await it instead of skipping the initial codegen.
    const isFirstLoad = this.#config == null;
    if (isFirstLoad) {
      this.#config = promise;
    }
    try {
      const config = await promise;
      this.#config = Promise.resolve(config);
      this.hasConfigResolved = true;
      this.routerRoot = path.join(this.#root, config.routerRoot);
      console.log(`[soonloh] config loaded: ${file}`);
    } catch (e) {
      if (isFirstLoad) {
        this.#config = null;
      } else {
        console.error('[soonloh] failed to reload config, keep previous one...');
      }
      logError(e);
    }
  }
  // endregion

  // region Generate
  #generateTask: AbortableTask<void> | undefined;
  generate(): AbortableTask<void> {
    this.#generateTask?.abort();
    this.#generateTask = runAbortable(async ($) => {
      const begin = Date.now();
      this.#generateTask?.abort();

      // debounce
      await $(setTimeout(10));

      if (!this.hasConfigResolved) {
        console.log('[soonloh] waiting for the config to be loaded...');
      }
      // The in-flight promise may reject on a broken first load; the failure
      // is already diagnosed in loadConfig, so just skip codegen here.
      const config = await $(this.#config).catch(() => null);
      if (!config) return;

      const rt = createSoonlohRuntime(config);
      let routes;
      try {
        routes = await $(rt.routes());
      } catch (e) {
        if (e instanceof AbortedError) return;
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
          console.error(
            `[soonloh] router root not found: ${path.join(this.#root, config.routerRoot)}\n` +
              '          create the directory or fix `routerRoot` in your config',
          );
        } else {
          logError(e);
        }
        return;
      }
      await $.all(
        config.generators.map(async (generator) => {
          try {
            const generatorBegin = Date.now();
            /** @todo support per-branch generation */
            const file = path.join(this.#root, generator.targetPath('main'));
            const old = await readFile(file, { encoding: 'utf-8' }).catch(
              () => '',
            );
            const content = await $(generator.generate(routes, file));
            // it is intentionally not generating
            if (content == null) return;
            if (old === content) {
              // do not save
              return;
            }
            await $(mkdir(path.dirname(file), { recursive: true }));
            await $(writeFile(file, content));
            console.log(
              `[soonloh] ${generator.name} done in ${
                Date.now() - generatorBegin
              } ms`,
            );
          } catch (e) {
            if (e instanceof AbortedError) return;
            console.log(
              `[soonloh] ${e}\n                   while generating ${generator.name}`,
            );
          }
        }),
      );
      console.log(`[soonloh] full codegen in ${Date.now() - begin} ms`);
    });
    return this.#generateTask;
  }
  // endregion

  // region Watch
  /**
   * React to a changed file path. Reloads the config (and regenerates) when
   * the config file itself changed, otherwise regenerates when the change is
   * inside the router root. Shared by every build-tool integration.
   */
  onFileChange(id: string) {
    if (
      this.configPath &&
      path.normalize(this.configPath) == path.normalize(id)
    ) {
      console.log('[soonloh] config file changed, reloading...');
      this.loadConfig().then(() => this.generate());
      return;
    }
    if (
      !this.routerRoot ||
      path.normalize(id).startsWith(path.normalize(this.routerRoot))
    ) {
      this.generate();
    }
  }
  // endregion
}

const logError = (e: unknown) =>
  console.error(e instanceof Error ? `[soonloh] ${e.message}` : e);

// ref: https://github.com/eslint/eslint/blob/60c3e2cf9256f3676b7934e26ff178aaf19c9e97/lib/config/config-loader.js#L85-L129
const isFileTs = (file: string) => /^\.[mc]?ts$/.test(path.extname(file));
const isBun = () => !!(globalThis as any).Bun;
const isDeno = () => !!(globalThis as any).Deno;
const isNodeSupportNativeTypeScript = () =>
  ['strip', 'transform'].includes(process.features.typescript || '');
