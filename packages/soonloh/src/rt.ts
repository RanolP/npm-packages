import path from 'node:path';
import { Config } from './core/config.js';
import { readdir, stat } from 'fs/promises';

export function createSoonlohRuntime<TSegment = unknown>(
  config: Config<TSegment>,
) {
  const routerRoot = config.routerRoot;
  return {
    async routes() {
      const routes: Array<{
        fileRaw: string;
        filePosix: string;
        segments: TSegment[];
      }> = [];
      for (const fileRaw of await readdir(routerRoot, { recursive: true })) {
        const toSkip = await stat(path.join(routerRoot, fileRaw))
          .then((x) => x.isDirectory())
          .catch(() => true);
        if (toSkip) continue;

        const filePosix = fileRaw.replaceAll(path.win32.sep, path.posix.sep);
        const segments = config.parser(filePosix);
        if (segments) {
          routes.push({ fileRaw, filePosix, segments });
        }
      }

      return routes;
    },
  };
}
