import path from 'node:path';
import { NonemptyArray } from '../util.js';

export interface SegmenterConfig {
  escape?: RegExp;
  separator: NonemptyArray<'/' | '.'>;
}
export type Segmenter = (dir: string, file: string) => string[];
export const createSegmenter = ({
  escape,
  separator,
}: SegmenterConfig): Segmenter => {
  const regexp = new RegExp(
    '(?:' +
      (escape ? escape.source + '|' : '') +
      `(.+?))(?:[${Array.from(new Set(separator)).join('')}]|$)(.*)`,
  );
  function trySplit(s: string): [string | undefined, string] {
    const result = regexp.exec(s)?.slice(1);
    if (result == null) return [undefined, s];
    else
      return [
        result.find((x) => x != null),
        result.findLast((x) => x != null)!,
      ];
  }
  return (dir, file) => {
    const result = [];
    while (dir.length > 0) {
      const [segment, rest] = trySplit(dir);
      if (segment == null) {
        console.error(
          `[soonloh] There is an error while segmenting path: ${dir}`,
        );
        break;
      }
      result.push(segment);
      dir = rest;
    }
    let { name, ext } = path.parse(file);
    while (name.length > 0) {
      const [segment, rest] = trySplit(name);
      if (segment == null) {
        console.error(
          `[soonloh] There is an error while segmenting path: ${name}`,
        );
        break;
      }
      result.push(segment);
      name = rest;
    }
    result[result.length - 1] += ext;
    return result;
  };
};
