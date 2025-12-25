import { createUnplugin } from 'unplugin';
import { Selection } from './types';
import { transformOxc } from './transformer/oxc';

export const unplugin = createUnplugin((_, meta) => {
  return {
    name: 'unplugin-pick',
    enforce: 'pre',
    transform(code, id) {
      let path: string | undefined;
      let selection: Selection | undefined;
      try {
        let qs: string;
        [path, qs] = id.split('?');
        const query = new URLSearchParams(qs);
        const pick = query.getAll('pick');
        const drop = query.getAll('drop');
        if (pick.length > 0 && drop.length > 0) {
          throw new Error('pick and drop cannot be used together');
        }
        if (pick.length > 0) {
          selection = {
            mode: 'pick',
            items: pick,
          };
        } else if (drop.length > 0) {
          selection = {
            mode: 'drop',
            items: drop,
          };
        }
      } catch {}
      if (!path || !selection) return;

      return transformOxc(path, code, selection);
    },
  };
});
