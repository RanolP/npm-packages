import { BaseSegment } from './segment.js';
import type { StandardSchemaV1 } from '@standard-schema/spec';

export type PickPredicate =
  | 'type'
  | 'type?'
  | 'function'
  | 'function?'
  | StandardSchemaV1;

export type PickResult<P extends PickPredicate> = P extends 'type'
  ? { importHere(): string }
  : P extends 'type?'
    ? { importHere(): string } | undefined
    : P extends 'function'
      ? (...args: never[]) => unknown
      : P extends 'function?'
        ? ((...args: never[]) => unknown) | undefined
        : P extends StandardSchemaV1<unknown, infer R>
          ? R
          : unknown;

export interface Route<TSegment> {
  fileRaw: string;
  filePosix: string;
  segments: Exclude<TSegment, BaseSegment>[];
  pick<TPicks extends Record<string, PickPredicate>>(
    picks: TPicks,
  ): Promise<{ [K in keyof TPicks]: PickResult<TPicks[K]> }>;
}
