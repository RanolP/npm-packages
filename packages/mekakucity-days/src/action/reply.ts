export interface ActionReply {
  readonly value: unknown;
  readonly baseVersion: number;
  readonly startVersion: number;
  readonly version: number;
  readonly isDiff: boolean;
  readonly snapshot: Readonly<Record<string, unknown>>;
}
