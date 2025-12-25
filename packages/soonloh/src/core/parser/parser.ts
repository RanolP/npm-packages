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
}: ParserConfig<TSegment>): Parser<
  Exclude<TSegment, { kind: 'skip' } | { kind: 'error' }>
> {
  return (p) => {
    const { dir, base } = path.parse(p);
    const segments = segmenter(dir, base);
    if (segments.length === 0 || segments.some((s) => s.length === 0)) {
      throw new Error(`Invalid path; there is empty segment`);
    }
    const { classified, hasError } = segments.map(classifier).reduce(
      (acc, curr) => {
        if (curr == null) return acc;
        if (typeof curr !== 'object') return acc;
        if (!('kind' in curr)) return acc;
        if (curr.kind === 'skip') return acc;
        if (curr.kind === 'error') return { ...acc, hasError: true };
        return { ...acc, classified: [...acc.classified, curr] };
      },
      {
        classified: [] as Exclude<
          TSegment,
          { kind: 'skip' } | { kind: 'error' }
        >[],
        hasError: false,
      },
    );

    if (hasError) return null;

    return classified;
  };
}
