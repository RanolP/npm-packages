export type SelectionMode = 'pick' | 'drop';

/**
 * Which top-level exports of a module to keep.
 *
 * - `pick`: keep only the exports whose name is in {@link Selection.names}.
 * - `drop`: keep every export except the ones in {@link Selection.names}.
 */
export interface Selection {
  mode: SelectionMode;
  names: ReadonlySet<string>;
}
