import { Selection, Transformer } from '../types';
import { parseSync, Program } from 'oxc-parser';
import MagicString from 'magic-string';

export const transformOxc = ((filename, code, selection) => {
  const result = parseSync(filename, code, {
    astType: 'ts',
    lang: 'tsx',
    range: true,
    sourceType: 'module',
  });
  const ms = new MagicString(code);
  for (const range of visitEstree(result.program, selection)) {
    ms.remove(range.start, range.end);
  }
  return ms.toString();
}) satisfies Transformer;

export function visitEstree(
  program: Program,
  selection: Selection,
): DeleteRange[] {
  if (program.sourceType === 'script')
    throw new Error('Script is not supported');
  const shouldInclude = (name: string) => {
    switch (selection.mode) {
      case 'pick':
        return selection.items.includes(name);
      case 'drop':
        return !selection.items.includes(name);
    }
  };
  const result: DeleteRange[] = [];
  for (const item of program.body) {
    switch (item.type) {
      case 'FunctionDeclaration':
        if (item.id?.name && !shouldInclude(item.id.name)) result.push(item);
        break;
      case 'VariableDeclaration':
        for (const declarator of item.declarations) {
          switch (declarator.id.type) {
            case 'Identifier':
              if (declarator.id.name && !shouldInclude(declarator.id.name))
                result.push(declarator);
              break;
            /**
             * @TODO
             * other patterns aren't supported yet
             */
            default:
              break;
          }
        }
        break;
      default:
        break;
    }
  }

  return result;
}

type DeleteRange = { start: number; end: number };
