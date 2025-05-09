import { Parser } from './parser/parser.js';

export interface Config<TSegment = unknown> {
  routerRoot: string;
  parser: Parser<TSegment>;
  generators: CodeGenerator<TSegment>[];
}

export interface CodeGenerator<TSegment> {
  name: string;
  targetPath: (pathSafeBranch: string) => string;
  generate: (
    paths: Array<{
      fileRaw: string;
      filePosix: string;
      segments: Exclude<TSegment, { kind: 'error' | 'skip' }>[];
    }>,
  ) => string | null | Promise<string | null>;
}

export const config = <TSegment>(value: Config<TSegment>): Config<TSegment> =>
  value;
