import { TypelevelError } from './util.js';

type SegmentMap = {
  skip?: TypelevelError<'You cannot use `skip` as a name of a Segment'> & {};
  error?: TypelevelError<'You cannot use `error` as a name of a Segment'> & {};
} & Record<
  string,
  {
    kind?: TypelevelError<'You cannot use `kind` as a property of a Segment'> & {};
    raw?: TypelevelError<'You cannot use `raw` as a property of a Segment'> & {};
  } & Record<string, PrimitiveTypenames>
>;

export function createSegment<TSegmentMap extends SegmentMap>(
  segmentMap: TSegmentMap
): SegmentBuilder<TSegmentMap> {
  return {
    ...Object.fromEntries(
      Object.keys(segmentMap).map((key) => [
        key,
        (options: Record<string, PrimitiveTypenames>) => ({
          kind: key,
          ...options,
        }),
      ])
    ),
    skip: () => ({ kind: 'skip', raw: '$SKIPPED' }),
    error: () => ({ kind: 'error', raw: '$ERROR' }),
  } as SegmentBuilder<TSegmentMap>;
}

export type inferSegment<TBuilder extends SegmentBuilder> =
  TBuilder[keyof TBuilder] extends (...params: never[]) => unknown
    ? ReturnType<TBuilder[keyof TBuilder]>
    : never;

type SegmentBuilder<TSegmentMap extends SegmentMap = {}> = {
  skip(): { kind: 'skip'; raw: '$SKIPPED' };
  error(): { kind: 'error'; raw: '$ERROR' };
} & {
  [K in keyof TSegmentMap]: (
    props: TransformProperties<TSegmentMap[K]> & {
      raw: string;
    } extends infer TProps
      ? // type simplify trick
        {
          [K in keyof TProps]: TProps[K];
        }
      : never
  ) => {
    kind: K;
  } & TransformProperties<TSegmentMap[K]> & {
      raw: string;
    } extends infer TSegment
    ? // type simplify trick
      {
        [K in keyof TSegment]: TSegment[K];
      }
    : never;
};

type TransformProperties<T extends Record<string, PrimitiveTypenames>> = {
  [K in keyof T]: {
    string: string;
    number: number;
    boolean: boolean;
    bigint: bigint;
  }[T[K]];
};

export type BaseSegment = { kind: 'skip' } | { kind: 'error' };

type PrimitiveTypenames = 'string' | 'number' | 'boolean' | 'bigint';
