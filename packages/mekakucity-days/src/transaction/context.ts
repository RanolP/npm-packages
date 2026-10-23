import type { Compensation } from "../compensation/model.js";
import type { OutboxMessage } from "../outbox/message.js";
import type { ActorRecord, InMemoryStore } from "../ref/in-memory-store.js";
import { NoActiveTransactionError } from "@mekakucity/actors";
import type { RuntimeMemory } from "../runtime/memory.js";

export type StateData = Record<string, unknown>;

export interface RootTransaction {
  readonly id: string;
  readonly backend: InMemoryStore;
  readonly compensations: Compensation[];
  readonly outbox: OutboxMessage[];
  readonly pendingHolds: Promise<void>[];
  readonly ownedIds: Set<string>;
}

export interface ActionFrame {
  readonly record: ActorRecord;
  readonly root: RootTransaction;
  readonly parent?: ActionFrame;
  readonly chain: Set<string>;
  readonly startVersion: number;
  readonly initialState: StateData;
  readonly compensations: Compensation[];
  readonly outbox: OutboxMessage[];
  baseline: StateData;
}

export interface ExecutionContext {
  readonly root: RootTransaction;
  readonly frame?: ActionFrame;
  readonly chain: Set<string>;
  readonly compensation?: { readonly outbox: OutboxMessage[] };
}

export const currentExecution = (memory: RuntimeMemory, operation: string): ExecutionContext => {
  const context = memory.execution.getStore();
  if (!context) throw new NoActiveTransactionError(operation);
  return context;
};
