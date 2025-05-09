import { BaseSegment } from '../segment.js';

interface ClassificationContext {
  index: number;
  length: number;
}
export interface ClassifierConfig<TPatternNames extends string, TSegment> {
  patterns: Record<TPatternNames, RegExp>;
  classify(
    token: TokenString<TPatternNames>,
    ctx: ClassificationContext,
  ): TSegment;
}
export type TokenString<TPatternNames extends string> = {
  text: string;
} & {
  [K in TPatternNames]: TokenString<TPatternNames> | null;
};
export type Classifier<TSegment> = (
  segment: string,
  index: number,
  array: string[],
) => TSegment | BaseSegment;
export function createClassifier<TPatternNames extends string, TSegment>({
  patterns,
  classify,
}: ClassifierConfig<TPatternNames, TSegment>): Classifier<TSegment> {
  const createToken = (text: string): TokenString<TPatternNames> => {
    const cache: Partial<
      Record<TPatternNames, TokenString<TPatternNames> | null>
    > = {};
    return new Proxy(
      {
        text,
      } as TokenString<TPatternNames>,
      {
        get(target, prop, _receiver) {
          if (prop in target) return (target as any)[prop];
          if (!(prop in patterns)) return undefined;
          const refinedProp = prop as TPatternNames;
          if (!(refinedProp in cache)) {
            const result = text && patterns[refinedProp].exec(text)?.[1];
            cache[refinedProp] = result ? createToken(result) : null;
          }
          return cache[refinedProp];
        },
      },
    );
  };
  return (segment, index, array) =>
    classify(createToken(segment), { index, length: array.length });
}
