import type { HolderOp } from "@mekakucity/actors/runtime";
import type { DueOutboxMessage, OutboxRow } from "./protocol.js";

const ROW_PREFIX = "outbox:";
const SEQUENCE_KEY = "outbox-sequence";

/** Consecutive ops for one target share a row; row order is delivery order, so hold(tx) still precedes release(actor). */
export const groupOps = (ops: readonly HolderOp[]): OutboxRow[] => {
  const rows: { kind: "ops"; target: string; ops: HolderOp[] }[] = [];
  for (const op of ops) {
    const last = rows.at(-1);
    if (last?.target === op.target) last.ops.push(op);
    else rows.push({ kind: "ops", target: op.target, ops: [op] });
  }
  return rows;
};

/**
 * The actor's durable outbox in its own SQLite-backed KV. Every method is
 * synchronous so callers can put it inside the same `transactionSync` as the
 * state write it belongs to.
 */
export class Outbox {
  constructor(private readonly kv: SyncKvStorage) {}

  /** Returns the sequence of the last row written so far, this append's rows included. */
  append(ops: readonly HolderOp[], messages: readonly DueOutboxMessage[] = [], extra: readonly OutboxRow[] = []): number {
    const rows: OutboxRow[] = [...groupOps(ops), ...messages.map((message) => ({ kind: "message", message }) as const), ...extra];
    let sequence = this.kv.get<number>(SEQUENCE_KEY) ?? 0;
    if (rows.length === 0) return sequence;
    for (const row of rows) this.kv.put(`${ROW_PREFIX}${String(++sequence).padStart(12, "0")}`, row);
    this.kv.put(SEQUENCE_KEY, sequence);
    return sequence;
  }

  first(): { key: string; seq: number; row: OutboxRow } | undefined {
    for (const [key, row] of this.kv.list<OutboxRow>({ prefix: ROW_PREFIX, limit: 1 })) {
      return { key, seq: Number(key.slice(ROW_PREFIX.length)), row };
    }
    return undefined;
  }

  remove(key: string): void {
    this.kv.delete(key);
  }
}
