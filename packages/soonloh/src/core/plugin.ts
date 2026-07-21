import path from 'node:path';
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { Config } from './config.js';
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
        const config = await this.#config;
        this.routerRoot = path.join(this.#root, config.routerRoot);
        this.hasConfigResolved = true;
      }
      return;
    }
    const href = pathToFileURL(file).href;
    const mtime = (await stat(file)).mtime;
    if (isFileTs(file)) {
      if (!isDeno() && !isBun() && !isNodeSupportNativeTypeScript()) {
        throw new Error('[soonloh] We cannot handle TypeScript file');
      }
    }
    const promise = import(`${href}?t=${mtime}`).then(
      (module) => module.default as Config,
    );
    promise.then((config) => {
      this.hasConfigResolved = true;
      this.routerRoot = path.join(this.#root, config.routerRoot);
      console.log('[soonloh] config loaded: ', this.routerRoot, {
        cfg: config.routerRoot,
      });
    });
    if (this.#config == null) {
      this.#config = promise;
    } else {
      try {
        this.#config = Promise.resolve(await promise);
      } catch (e) {
        console.error(
          '[soonloh] failed to reload config, keep previous one...',
        );
        console.error(e);
      }
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
      const routerRoot = this.routerRoot;
      const config = await $(this.#config);
      if (!routerRoot || !config) return;

      const rt = createSoonlohRuntime(config);
      const routes = await rt.routes();
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

// ref: https://github.com/eslint/eslint/blob/60c3e2cf9256f3676b7934e26ff178aaf19c9e97/lib/config/config-loader.js#L85-L129
const isFileTs = (file: string) => /^\.[mc]?ts$/.test(path.extname(file));
const isBun = () => !!(globalThis as any).Bun;
const isDeno = () => !!(globalThis as any).Deno;
const isNodeSupportNativeTypeScript = () =>
  ['strip', 'transform'].includes(process.features.typescript || '');
