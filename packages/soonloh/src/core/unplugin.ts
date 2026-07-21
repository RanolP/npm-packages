import { createUnplugin } from 'unplugin';
import { Options, SoonlohPlugin } from './plugin.js';

export type { Options };

export const unplugin = createUnplugin<Options | undefined>((options = {}) => {
    const instance = new SoonlohPlugin(options);
    instance.loadConfig();

    return {
      name: 'soonloh',
      buildStart() {
        instance.generate();
      },
      watchChange(id) {
        instance.onFileChange(id);
      },
    };
  });
