import type { Selection } from './types.js';

export interface ParsedId {
  /** The module path with the `?pick`/`?drop` query stripped off. */
  path: string;
  /** `null` when the id carries no `pick`/`drop` query. */
  selection: Selection | null;
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Split a module id into its path and its {@link Selection}.
 *
 * Both `?pick=a&pick=b` and `?pick=a,b` are accepted (and may be mixed).
 * Combining `pick` and `drop` on the same import throws.
 */
export function parseId(id: string): ParsedId {
  const questionMark = id.indexOf('?');
  if (questionMark === -1) return { path: id, selection: null };

  const path = id.slice(0, questionMark);
  const params = new URLSearchParams(id.slice(questionMark + 1));
  const pick = params.getAll('pick').flatMap(splitList);
  const drop = params.getAll('drop').flatMap(splitList);

  if (pick.length > 0 && drop.length > 0) {
    throw new Error(
      "unplugin-pick: 'pick' and 'drop' cannot be used on the same import",
    );
  }
  if (pick.length > 0) {
    return { path, selection: { mode: 'pick', names: new Set(pick) } };
  }
  if (drop.length > 0) {
    return { path, selection: { mode: 'drop', names: new Set(drop) } };
  }
  return { path, selection: null };
}

/** Whether an export named `name` survives the given {@link Selection}. */
export function isIncluded(selection: Selection, name: string): boolean {
  return selection.mode === 'pick'
    ? selection.names.has(name)
    : !selection.names.has(name);
}
