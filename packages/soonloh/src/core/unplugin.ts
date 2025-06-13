import path from 'node:path';
import { createUnplugin } from 'unplugin';
import { stat, readdir, mkdir, writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { Config } from './config.js';

export interface Options {
  config?:
    | {
        path: string;
      }
    | Config;
}
class SoonlohPlugin {
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
        this.#options.config?.path ?? 'soonloh.config.ts'
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
    if (typeof file !== 'string') return;
    const href = pathToFileURL(file).href;
    const mtime = (await stat(file)).mtime;
    if (isFileTs(file)) {
      if (!isDeno() && !isBun() && !isNodeSupportNativeTypeScript()) {
        throw new Error('[soonloh] We cannot handle TypeScript file');
      }
    }
    const promise = import(`${href}?t=${mtime}`).then(
      (module) => module.default as Config
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
          '[soonloh] failed to reload config, keep previous one...'
        );
        console.error(e);
      }
    }
  }
  // endregion

  // region Generate
  #controller = new AbortController();

  async generate() {
    const begin = Date.now();
    this.#controller.abort();
    this.#controller = new AbortController();
    const signal = this.#controller.signal;

    // debounce
    await setTimeout(10);
    if (signal.aborted) return;

    if (!this.hasConfigResolved) {
      console.log('[soonloh] waiting for the config to be loaded...');
    }
    const routerRoot = this.routerRoot;
    const config = await this.#config;
    if (!routerRoot || !config || signal.aborted) return;

    const parsedPaths: Array<{
      fileRaw: string;
      filePosix: string;
      segments: unknown[];
    }> = [];
    let hasError = false;
    for (const fileRaw of await readdir(routerRoot, { recursive: true })) {
      if (signal.aborted) break;
      if ((await stat(path.join(routerRoot, fileRaw))).isDirectory()) continue;

      const filePosix = fileRaw.replaceAll(path.win32.sep, path.posix.sep);
      try {
        const segments = config.parser(filePosix);
        if (segments) {
          parsedPaths.push({ fileRaw, filePosix, segments });
        }
      } catch (e) {
        hasError = true;
        console.log(
          `[soonloh] ${e}\n                   ${path.join(
            config.routerRoot,
            fileRaw
          )}`
        );
      }
    }
    if (hasError || signal.aborted) return;
    await Promise.all(
      config.generators.map(async (generator) => {
        try {
          const generatorBegin = Date.now();
          /** @todo support per-branch generation */
          const file = path.join(this.#root, generator.targetPath('main'));
          const old = await readFile(file, { encoding: 'utf-8' });
          if (signal.aborted) return;
          const content = await generator.generate(parsedPaths);
          if (signal.aborted) return;
          // it is intentionally not generating
          if (content == null) return;
          if (old === content) {
            // do not save
            return;
          }
          await mkdir(path.dirname(file), { recursive: true });
          if (signal.aborted) return;
          await writeFile(file, content);
          console.log(
            `[soonloh] ${generator.name} done in ${
              Date.now() - generatorBegin
            } ms`
          );
        } catch (e) {
          console.log(
            `[soonloh] ${e}\n                   while generating ${generator.name}`
          );
        }
      })
    );
    if (signal.aborted) return;
    console.log(`[soonloh] full codegen in ${Date.now() - begin} ms`);
  }
  // endregion
}
export const unplugin = createUnplugin<Options | undefined>(
  (options = {}, meta) => {
    const instance = new SoonlohPlugin(options);
    instance.loadConfig();

    return {
      name: 'soonloh',
      buildStart() {
        instance.generate();
      },
      watchChange(id, change) {
        if (
          instance.configPath &&
          path.normalize(instance.configPath) == path.normalize(id)
        ) {
          console.log('[soonloh] config file changed, reloading...');
          instance.loadConfig().then(() => instance.generate());
          return;
        }
        if (
          !instance.routerRoot ||
          path.normalize(id).startsWith(path.normalize(instance.routerRoot))
        )
          instance.generate();
      },
    };
  }
);

// ref: https://github.com/eslint/eslint/blob/60c3e2cf9256f3676b7934e26ff178aaf19c9e97/lib/config/config-loader.js#L85-L129
const isFileTs = (file: string) => /^\.[mc]?ts$/.test(path.extname(file));
const isBun = () => !!(globalThis as any).Bun;
const isDeno = () => !!(globalThis as any).Deno;
const isNodeSupportNativeTypeScript = () =>
  ['strip', 'transform'].includes(process.features.typescript || '');
