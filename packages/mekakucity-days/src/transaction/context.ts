import type { ActorInvocationContext, HolderOp, TxHold } from "@mekakucity/actors/runtime";
import type { OutboxMessage, PendingOutboxMessage } from "../outbox/message.js";
import type { ActorRecord, InMemoryStore } from "../ref/in-memory-store.js";
import { NoActiveTransactionError } from "@mekakucity/actors";
import type { RuntimeMemory } from "../runtime/memory.js";

export type StateData = Record<string, unknown>;

export interface RootTransaction {
  readonly id: string;
  readonly backend: InMemoryStore;
  readonly outbox: OutboxMessage[];
  readonly holderQueue: HolderOp[];
  draining?: Promise<void>;
  /** (target, holder) tx holds this root owns, released when it ends. */
  readonly owned: Map<string, TxHold>;
}

export interface ActionFrame {
  readonly id: string;
  readonly record: ActorRecord;
  readonly root: RootTransaction;
  readonly parent?: ActionFrame;
  readonly chain: Set<string>;
  readonly invocation: ActorInvocationContext;
  /**
   * The tx holder for refs this call hands to the root: minted per cross-actor call, the same key the DO adapter
   * gets from its caller's callId. A same-actor nested frame shares its parent's key.
   */
  readonly txHolder: string;
  readonly startVersion: number;
  readonly initialState: StateData;
  readonly spawnedIds: Set<string>;
  readonly outbox: PendingOutboxMessage[];
  readonly pendingOps: HolderOp[];
  baseline: StateData;
}

export interface ExecutionContext {
  readonly root: RootTransaction;
  readonly frame?: ActionFrame;
  readonly chain: Set<string>;
}

export const currentExecution = (memory: RuntimeMemory, operation: string): ExecutionContext => {
  const context = memory.execution.getStore();
  if (!context) throw new NoActiveTransactionError(operation);
  return context;
};
