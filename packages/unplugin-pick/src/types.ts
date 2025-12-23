export type Selection =
  | { mode: 'pick'; items: string[] }
  | { mode: 'drop'; items: string[] };

export type Transformer = (
  filename: string,
  code: string,
  selection: Selection,
) => string;
