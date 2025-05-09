import path from 'node:path';
import { CommonSegment } from '../builtin-common-segment.js';
import { CodeGenerator } from '../core/config.js';

export const debug: CodeGenerator<CommonSegment> = {
  name: 'soonloh:debug',
  targetPath: () => '',
  generate(paths) {
    for (const { file, segments } of paths) {
      console.log('     > ' + file.replaceAll(path.win32.sep, path.posix.sep));
      for (const segment of segments) {
        console.log('       | ' + JSON.stringify(segment));
      }
    }

    // intentionally don't generate a file
    return null;
  },
};
