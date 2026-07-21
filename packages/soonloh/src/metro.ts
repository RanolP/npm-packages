import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { Options, SoonlohPlugin } from './core/plugin.js';

export interface MetroOptions extends Options {
  /**
   * Watch the router root and config file, regenerating on change.
   *
   * Defaults to `true` unless `NODE_ENV === 'production'`, so `metro` dev
   * servers regenerate live while one-shot bundle/export builds do not leave a
   * watcher handle open.
   */
  watch?: boolean;
}

/**
 * Wrap a Metro config so soonloh generates routes before the first bundle and,
 * in dev, keeps them in sync as files change.
 *
 * Metro has no unplugin adapter, so unlike the Vite integration this hooks
 * nothing inside Metro: soonloh writes real files to disk, so the config is
 * returned untouched and codegen runs as a side effect of loading it.
 *
 * ```js
 * // metro.config.js
 * const { getDefaultConfig } = require('expo/metro-config');
 * const withSoonloh = require('soonloh/metro').default;
 *
 * module.exports = withSoonloh(getDefaultConfig(__dirname));
 * ```
 */
export default function withSoonloh<T extends object>(
  config: T,
  options: MetroOptions = {},
): T {
  const { watch: shouldWatch = process.env.NODE_ENV !== 'production', ...rest } =
    options;
  const instance = new SoonlohPlugin(rest);

  // Load the config and run the first codegen before any bundle is requested.
  // Metro reads generated files lazily, so awaiting the initial task avoids a
  // cold-start race where a route module does not exist yet.
  const ready = instance.loadConfig().then(() => instance.generate());

  if (shouldWatch) {
    ready.then(() => startWatching(instance));
  }

  return config;
}

function startWatching(instance: SoonlohPlugin) {
  const watchers: FSWatcher[] = [];

  const watchDir = (dir: string) => {
    try {
      watchers.push(
        watch(dir, { recursive: true }, (_event, filename) => {
          if (filename == null) return;
          instance.onFileChange(path.join(dir, filename));
        }),
      );
    } catch (e) {
      console.error(`[soonloh] failed to watch ${dir}`);
      console.error(e);
    }
  };

  if (instance.routerRoot) watchDir(instance.routerRoot);

  // The config file lives outside the router root, so watch its directory and
  // filter to the exact file inside onFileChange.
  const configPath = instance.configPath;
  if (configPath) {
    try {
      watchers.push(
        watch(configPath, () => instance.onFileChange(configPath)),
      );
    } catch (e) {
      console.error(`[soonloh] failed to watch ${configPath}`);
      console.error(e);
    }
  }

  const close = () => {
    for (const w of watchers) w.close();
  };
  process.once('exit', close);
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
