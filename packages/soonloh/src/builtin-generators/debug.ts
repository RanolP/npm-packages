import { CommonSegment } from '../builtin-common-segment.js';
import { CodeGenerator } from '../core/config.js';

export const debug: CodeGenerator<CommonSegment> = {
  name: 'soonloh:debug',
  targetPath: () => '',
  generate(paths) {
    for (const { filePosix, segments } of paths) {
      console.log('     > ' + filePosix);
      for (const segment of segments) {
        console.log('       | ' + JSON.stringify(segment));
      }
    }

    // intentionally don't generate a file
    return null;
  },
};
