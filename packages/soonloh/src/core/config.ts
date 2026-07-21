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
    paths: Array<Route<TSegment>>,
    resolvedTargetPath: string,
  ) => string | null | Promise<string | null>;
}

export const config = <TSegment>(value: Config<TSegment>): Config<TSegment> =>
  value;

/**
 * Checks that a value loaded at runtime (config file default export or inline
 * config) actually has the shape of a {@link Config}, so a malformed config
 * surfaces as one readable diagnostic instead of a TypeError mid-codegen.
 */
export function validateConfig<TSegment = unknown>(
  value: unknown,
  source: string,
): Config<TSegment> {
  const problems: string[] = [];
  if (typeof value !== 'object' || value == null) {
    problems.push(
      'the default export is not a config object — `export default config({ ... })`',
    );
  } else {
    const v = value as Partial<Config<TSegment>>;
    if (typeof v.routerRoot !== 'string')
      problems.push('`routerRoot` must be a string path');
    if (typeof v.parser !== 'function')
      problems.push('`parser` must be a function');
    if (!Array.isArray(v.generators))
      problems.push('`generators` must be an array');
  }
  if (problems.length > 0) {
    throw new Error(
      `invalid config (${source}):\n${problems
        .map((p) => `  - ${p}`)
        .join('\n')}`,
    );
  }
  return value as Config<TSegment>;
}
