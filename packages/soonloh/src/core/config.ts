import { Parser } from './parser/parser.js';
import { Route } from './types.js';

export interface Config<TSegment = unknown> {
  routerRoot: string;
  parser: Parser<TSegment>;
  generators: CodeGenerator<TSegment>[];
}

export interface CodeGenerator<TSegment> {
  name: string;
  targetPath: (pathSafeBranch: string) => string;
  generate: (
    paths: Array<Route<TSegment>>
  ) => string | null | Promise<string | null>;
}

export const config = <TSegment>(value: Config<TSegment>): Config<TSegment> =>
  value;
