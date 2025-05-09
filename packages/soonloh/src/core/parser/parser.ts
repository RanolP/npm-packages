import path from 'node:path';
import { Classifier } from './classifier.js';
import { Segmenter } from './segmenter.js';

interface ParserConfig<TSegment> {
  segmenter: Segmenter;
  classifier: Classifier<TSegment>;
}
export type Parser<TSegment> = (path: string) => TSegment[] | null;
export function createParser<TSegment>({
  segmenter,
  classifier,
}: ParserConfig<TSegment>): Parser<TSegment> {
  return (p) => {
    const { dir, base } = path.parse(p);
    const segments = segmenter(dir, base);
    if (segments.length === 0 || segments.some((s) => s.length === 0)) {
      throw new Error(`Invalid path; there is empty segment`);
    }
    const classified = segments
      .map(classifier)
      .filter(
        (x) =>
          x == null ||
          typeof x !== 'object' ||
          !('kind' in x) ||
          x.kind !== 'skip',
      );
    if (
      classified.some(
        (x) =>
          x != null &&
          typeof x === 'object' &&
          'kind' in x &&
          x.kind === 'error',
      )
    ) {
      return null;
    }

    return classified as TSegment[];
  };
}
