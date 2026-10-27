import { AsyncLocalStorage } from "node:async_hooks";
import type { Actor, ActorConstructor, ActorContextProvider } from "@mekakucity/actors";
import type { ActionReply } from "../action/reply.js";
import { InMemoryStore } from "../ref/in-memory-store.js";
import { SnapshotCache } from "../state/cache.js";
import type { ExecutionContext } from "../transaction/context.js";

export interface RuntimeMemory {
  readonly backend: InMemoryStore;
  readonly snapshotCache: SnapshotCache;
  readonly knownTypes: Map<string, ActorConstructor<Actor<unknown, unknown>>>;
  readonly namedCreations: Map<string, Promise<unknown>>;
  readonly instanceIds: WeakMap<object, string>;
  readonly refs: WeakSet<object>;
  readonly execution: AsyncLocalStorage<ExecutionContext>;
  readonly contextProvider: ActorContextProvider | undefined;
  readonly sequence: { actor: number; frame: number; transaction: number; message: number };
  lastReplyForTest?: ActionReply;
}

export const createRuntimeMemory = (contextProvider?: ActorContextProvider): RuntimeMemory => ({
  backend: new InMemoryStore(),
  snapshotCache: new SnapshotCache(),
  knownTypes: new Map(),
  namedCreations: new Map(),
  instanceIds: new WeakMap(),
  refs: new WeakSet(),
  execution: new AsyncLocalStorage<ExecutionContext>(),
  contextProvider,
  sequence: { actor: 0, frame: 0, transaction: 0, message: 0 },
});
