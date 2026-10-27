import { DurableObject } from "cloudflare:workers";
import {
  ActorKilledError,
  ActorReentrancyError,
  ActorRuntimeError,
  ActorStateSerializationError,
  type ActorContextProvider,
  type ActorDescriptor,
} from "@mekakucity/actors";
import {
  ActorInvocationContext,
  actorHolder,
  applyHolderOp,
  changedStateFields,
  cloneOrThrow,
  cloneState,
  createSnapshot,
  diffHeldRefs,
  discardSpawnOps,
  frameHolder,
  messageReleaseOps,
  metadataFor,
  restoreState,
  resolveDueAt,
  settleSpawnOps,
  stateFields,
  recordTxHold,
  txReleaseOps,
  resolveActorMessage,
  type HolderOp,
} from "@mekakucity/actors/runtime";
import { capture } from "./errors.js";
import { Outbox } from "./outbox.js";
import { lookupType } from "./registry.js";
import {
  stubOf,
  type ActorHostRpc,
  type ActorView,
  type CreateRequest,
  type DeliveryAck,
  type InvokeRequest,
  type InvokeResult,
  type MessageOrigin,
  type DueOutboxMessage,
  type PendingOutboxMessage,
  type OutboxRow,
  type Outcome,
} from "./protocol.js";
import {
  createHostRuntimeCore,
  type ActionFrame,
  type RootTransaction,
  type RuntimeCore,
  type StateData,
} from "./runtime.js";

// Storage keys. Outbox rows live under `outbox:` (outbox.ts); detached
// messages waiting to run here live under `inbox:`.
const META = "meta";
const SNAPSHOT = "snapshot";
const VERSION = "version";
const HOLDERS = "holders";
const HELD_REFS = "heldRefs";
const COLLECTED = "collected";
const COLLECTED_RETRY_ATTEMPT = "collected-retry-attempt";
const COLLECTED_RETRY_AT = "collected-retry-at";
const RETRY_DELAYS_MS = [5_000, 8_000, 13_000, 21_000, 34_000] as const;
const INBOX_PREFIX = "inbox:";
const INBOX_SEQUENCE = "inbox-sequence";
const INBOX_BACKSTOP_PREFIX = "inbox-backstop:";
/** `seen:<sender>`: highest outbox sequence stored from that sender (deliverMessage dedupe). */
const SEEN_PREFIX = "seen:";
/**
 * `sent:<target>` on the sender: an actor that may hold a `seen:` watermark for it, forgotten when it is collected.
 * A "dead" ack deletes the key, so it is bounded by the targets this sender has messaged and not yet heard die.
 * Remaining growth: a target collected after its last message from this sender keeps its key until the sender
 * itself is collected, since nothing tells the sender.
 */
const SENT_PREFIX = "sent:";

interface ActorMeta {
  readonly scope: string;
  readonly type: string;
  readonly named: boolean;
  readonly input: unknown;
}

interface HostedActor {
  readonly id: string;
  readonly meta: ActorMeta;
  readonly core: RuntimeCore;
  readonly instance: object;
  readonly holders: Set<string>;
  heldRefs: Set<string>;
  version: number;
  snapshot: Readonly<StateData>;
}

interface InboxEntry {
  readonly key: string;
  readonly message: DueOutboxMessage;
}

interface StoredInboxMessage {
  readonly message: DueOutboxMessage;
  readonly dueAt: number;
  readonly sequence: number;
}

interface InboxBackstop {
  readonly attempt: number;
  readonly retryAt?: number;
}

const inboxBackstopKey = (inboxKey: string) => `${INBOX_BACKSTOP_PREFIX}${inboxKey.slice(INBOX_PREFIX.length)}`;

const isDueMessage = (value: unknown): value is DueOutboxMessage => {
  if (typeof value !== "object" || value === null) return false;
  if (!("target" in value) || typeof value.target !== "object" || value.target === null) return false;
  return "id" in value
    && typeof value.id === "string"
    && "type" in value.target
    && typeof value.target.type === "string"
    && "id" in value.target
    && typeof value.target.id === "string"
    && "action" in value
    && typeof value.action === "string"
    && "args" in value
    && Array.isArray(value.args)
    && "heldIds" in value
    && Array.isArray(value.heldIds)
    && "dueAt" in value
    && typeof value.dueAt === "number";
};

const readStoredInboxMessage = (value: unknown): StoredInboxMessage => {
  if (typeof value !== "object" || value === null || !("message" in value)) {
    throw new ActorRuntimeError(
      "Stored inbox message is incompatible: expected the scheduled-message storage format",
    );
  }
  if (!isDueMessage(value.message)
    || !("dueAt" in value)
    || typeof value.dueAt !== "number"
    || !("sequence" in value)
    || typeof value.sequence !== "number") {
    throw new ActorRuntimeError("Stored inbox message is invalid");
  }
  return { message: value.message, dueAt: value.dueAt, sequence: value.sequence };
};

interface Env {
  readonly ACTOR_HOST?: DurableObjectNamespace<ActorHost>;
}

/**
 * One actor per Durable Object. Its snapshot, version, holders, held refs and
 * outbox share the object's SQLite-backed storage, so a segment commit is one
 * `transactionSync`. Export it from the worker's main module and bind it as
 * `ACTOR_HOST` (a `new_sqlite_classes` class): actions it runs reach other
 * actors through that binding.
 */
export class ActorHost extends DurableObject<Env> {
  #actor: HostedActor | undefined;
  #killed = false;
  #mailbox: Promise<void> = Promise.resolve();
  #flushing: Promise<void> | undefined;
  #deliveryFailure: { seq: number; error: unknown } | undefined;
  #dispatching = false;
  /** Callers waiting until every outbox row through `seq` was acked (#awaitDelivered). */
  #deliveryWaiters: { seq: number; resolve: () => void; reject: (error: unknown) => void }[] = [];

  protected get actorContextProvider(): ActorContextProvider | undefined {
    return undefined;
  }

  get #id(): string {
    return this.ctx.id.toString();
  }

  get #kv(): SyncKvStorage {
    return this.ctx.storage.kv;
  }

  get #outbox(): Outbox {
    return new Outbox(this.ctx.storage.kv);
  }

  #binding(): DurableObjectNamespace<ActorHost> {
    const binding = this.env.ACTOR_HOST;
    if (!binding) throw new ActorRuntimeError("ActorHost needs its own namespace bound as ACTOR_HOST");
    return binding;
  }

  // ---- RPC surface ---------------------------------------------------------

  create(request: CreateRequest): Promise<Outcome<ActorView>> {
    return capture(async () => {
      const existing = this.#loadForWork();
      if (existing) {
        if (request.named) return viewOf(existing);
        throw new ActorRuntimeError(`Actor ${this.#id} already exists`);
      }
      const core = createHostRuntimeCore(this.#binding(), request.scope, this.actorContextProvider);
      const Type = lookupType(request.type);
      const meta: ActorMeta = { scope: request.scope, type: request.type, named: request.named, input: request.input };
      const actor: HostedActor = {
        id: this.#id,
        meta,
        core,
        instance: Type.construct(core.hydrate(structuredClone(request.input))),
        holders: new Set(request.holders),
        heldRefs: new Set(),
        version: 0,
        snapshot: {},
      };
      const first = createSnapshot(actor);
      actor.snapshot = first.data;
      actor.heldRefs = this.#stateRefs(actor, first.state);
      const holds = [...actor.heldRefs].map((target): HolderOp => ({ kind: "hold", target, holder: actorHolder(actor.id) }));
      const written = this.ctx.storage.transactionSync(() => {
        this.#kv.put(META, meta);
        this.#kv.put(SNAPSHOT, first.data);
        this.#kv.put(VERSION, 0);
        this.#kv.put(HOLDERS, [...actor.holders]);
        this.#kv.put(HELD_REFS, [...actor.heldRefs]);
        return this.#outbox.append(holds);
      });
      this.#attach(actor);
      await this.#afterWrite();
      try {
        await this.#awaitDelivered(written);
      } catch (error) {
        // The caller gets an error and never releases its holder, so this actor drops it itself; collecting
        // appends the releases of its own holds after them. A named actor keeps NAMED_ROOT: the next
        // orSpawn finds it.
        if (!request.named) {
          this.#applyOps(request.holders.map((holder): HolderOp => ({ kind: "release", target: this.#id, holder })));
          void this.#flush();
        }
        throw error;
      }
      return viewOf(actor);
    });
  }

  view(): Promise<Outcome<ActorView | null>> {
    return capture(async () => {
      const actor = this.#loadForWork();
      return actor ? viewOf(actor) : null;
    });
  }

  invoke(request: InvokeRequest): Promise<Outcome<InvokeResult>> {
    return capture(async () => {
      const actor = this.#loadForWork();
      if (!actor) throw new ActorKilledError(this.#id);
      if (request.context.chain.includes(actor.id)) throw new ActorReentrancyError(actor.id);
      const root = actor.core.newRoot(false, request.context.rootId, request.context.callId);
      const chain = new Set([...request.context.chain, actor.id]);
      let result: InvokeResult & { written: number };
      try {
        result = await this.#withMailbox(async () => {
          const { value, spawnedIds } = await this.#runTop(
            actor,
            root,
            chain,
            request.context.parentFrameId,
            request.action,
            [...request.args],
            request.context.carried,
            request.context.origin,
          );
          return { ...viewOf(actor), value, owned: [...root.owned.values()], spawnedIds, written: this.#outbox.append([]) };
        });
      } catch (error) {
        await this.#emit(txReleaseOps(root.owned.values()));
        throw error;
      }
      // The caller releases these holds directly once its root ends, so this commit's hold(tx) rows must
      // reach their targets first or a late hold re-adds a holder nobody releases. Waited outside the mailbox:
      // delivery never needs it.
      const { written, ...reply } = result;
      try {
        await this.#awaitDelivered(written);
      } catch (error) {
        // The rows remain pending, but the caller gets an error instead of owned and spawnedIds
        // and releases neither. Releases appended here leave after their holds (one sender, strict order), and
        // name only this call's tx holder (and those of calls it made), never another reply's in the same root.
        const { parentFrameId } = request.context;
        const handedUp = parentFrameId === undefined ? [] : reply.spawnedIds.map((target): HolderOp =>
          ({ kind: "release", target, holder: frameHolder(parentFrameId) }));
        this.ctx.storage.transactionSync(() => this.#outbox.append([...txReleaseOps(root.owned.values()), ...handedUp]));
        void this.#flush();
        throw error;
      }
      return reply;
    });
  }

  /** Target side of the holder protocol; resolving is the ack the sender's outbox waits for. */
  async applyHolderOps(ops: HolderOp[]): Promise<void> {
    this.#loadForWork();
    this.#applyOps(ops);
    await this.#flush();
  }

  /**
   * Stores a detached message in the inbox and acks; the action runs afterwards as its own root transaction.
   * A sender redelivers a row whose ack it lost, possibly after the action already ran and its inbox key is
   * gone. Its rows go out strictly in sequence order, so a row at or below the sender's `seen:` watermark was
   * stored before and is acked without queueing it again. That costs one key per live sender: a collected
   * sender's last rows are forget-seen (forgetSender). Sender ids are never reused (unique ids are fresh, named
   * actors are never collected), so a watermark never meets a restarted sequence. Messages sent from a client root carry no origin: they are sent once, never retried.
   */
  async deliverMessage(message: DueOutboxMessage, origin?: MessageOrigin): Promise<DeliveryAck> {
    if (typeof message.dueAt !== "number") {
      throw new ActorRuntimeError("Detached message must have a numeric dueAt before delivery");
    }
    resolveDueAt({ dueAt: message.dueAt }, Date.now());
    if (!this.#loadForWork()) return "dead";
    const key = `${INBOX_PREFIX}${message.id}`;
    const seenKey = `${SEEN_PREFIX}${origin?.sender}`;
    const duplicate = origin !== undefined && (this.#kv.get<number>(seenKey) ?? 0) >= origin.seq;
    if (!duplicate && this.#kv.get(key) === undefined) {
      this.ctx.storage.transactionSync(() => {
        const sequence = (this.#kv.get<number>(INBOX_SEQUENCE) ?? 0) + 1;
        this.#kv.put(INBOX_SEQUENCE, sequence);
        this.#kv.put(key, { message, dueAt: message.dueAt, sequence } satisfies StoredInboxMessage);
        if (origin) this.#kv.put(seenKey, origin.seq);
      });
    }
    this.#scheduleAlarm();
    void this.#dispatchInbox();
    return "queued";
  }

  /** Drops a collected sender's watermark: its forget-seen row is its last, so nothing it sent can arrive later. */
  async forgetSender(sender: string): Promise<void> {
    if (!this.#loadForWork()) return;
    this.#kv.delete(`${SEEN_PREFIX}${sender}`);
  }

  override async alarm(): Promise<void> {
    this.#advanceInboxBackstops(Date.now());
    if (this.#kv.get(COLLECTED)) {
      this.#kv.delete(COLLECTED_RETRY_AT);
      this.#deliveryFailure = undefined;
    } else {
      this.#loadForWork();
    }
    await this.#flush();
    await this.#dispatchInbox();
    this.#scheduleAlarm();
  }

  // ---- loading -------------------------------------------------------------

  #loadForWork(): HostedActor | undefined {
    const actor = this.#load();
    if (actor && this.#outbox.first()) {
      this.#deliveryFailure = undefined;
      void this.#flush();
    }
    return actor;
  }

  #load(): HostedActor | undefined {
    if (this.#killed) return undefined;
    if (this.#actor) return this.#actor;
    const meta = this.#kv.get<ActorMeta>(META);
    if (!meta) return undefined;
    if (this.#kv.get(COLLECTED)) {
      this.#killed = true;
      return undefined;
    }
    for (const [, value] of this.#kv.list<unknown>({ prefix: INBOX_PREFIX })) readStoredInboxMessage(value);
    const core = createHostRuntimeCore(this.#binding(), meta.scope, this.actorContextProvider);
    const Type = lookupType(meta.type);
    const snapshot = this.#kv.get<StateData>(SNAPSHOT) ?? {};
    const actor: HostedActor = {
      id: this.#id,
      meta,
      core,
      instance: Type.construct(core.hydrate(structuredClone(meta.input))),
      holders: new Set(this.#kv.get<string[]>(HOLDERS) ?? []),
      heldRefs: new Set(this.#kv.get<string[]>(HELD_REFS) ?? []),
      version: this.#kv.get<number>(VERSION) ?? 0,
      snapshot,
    };
    restoreState(actor, structuredClone(snapshot), (value) => core.hydrate(value));
    this.#attach(actor);
    return actor;
  }

  #attach(actor: HostedActor): void {
    this.#actor = actor;
    actor.core.local = {
      id: actor.id,
      type: actor.meta.type,
      instance: actor.instance,
      commitSegment: (frame, preserve) => this.#commit(actor, frame, { force: false, preserve }),
      invokeNested: (parent, actionName, run) => this.#runNested(actor, parent, actionName, run),
    };
  }

  #withMailbox<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#mailbox;
    const { promise: lock, resolve: unlock } = Promise.withResolvers<void>();
    this.#mailbox = previous.then(() => lock, () => lock);
    return (async () => {
      await previous;
      try {
        if (this.#killed) throw new ActorKilledError(this.#id);
        return await work();
      } finally {
        unlock();
      }
    })();
  }

  // ---- frames --------------------------------------------------------------

  #makeFrame(
    actor: HostedActor,
    root: RootTransaction,
    parent: ActionFrame | undefined,
    chain: Set<string>,
    carried: unknown,
    origin?: ActorDescriptor,
  ): ActionFrame {
    const state = cloneState(actor);
    return {
      id: `frame_${crypto.randomUUID()}`,
      root,
      parent,
      chain,
      invocation: new ActorInvocationContext(
        carried,
        actor.core.contextProvider,
        { type: actor.meta.type, id: actor.id },
        origin,
      ),
      startVersion: actor.version,
      initialState: structuredClone(state),
      baseline: state,
      spawnedIds: new Set(),
      outbox: [],
      pendingOps: [],
    };
  }

  #stateRefs(actor: HostedActor, state: StateData): Set<string> {
    const refs = new Set<string>();
    for (const key of stateFields(actor)) actor.core.collectRefs(state[key], refs);
    return refs;
  }

  #holdForTx(actor: HostedActor, root: RootTransaction, value: unknown): HolderOp[] {
    return [...actor.core.collectRefs(value)].map((target) => {
      recordTxHold(root.owned, target, root.holder);
      return { kind: "hold", target, holder: root.holder };
    });
  }

  /** The action entered through RPC or the inbox: this actor's outermost frame for the call. */
  #runTop(
    actor: HostedActor,
    root: RootTransaction,
    chain: Set<string>,
    parentFrameId: string | undefined,
    actionName: string,
    args: unknown[],
    carried: unknown,
    origin?: ActorDescriptor,
    options: { holdResult: boolean; settleInbox?: InboxEntry } = { holdResult: true },
  ): Promise<{ value: unknown; spawnedIds: string[] }> {
    const { core } = actor;
    const method = metadataFor(actor.instance).actions.get(actionName);
    if (!method) return Promise.reject(new ActorRuntimeError(`Unknown actor action ${actionName}`));
    const frame = this.#makeFrame(actor, root, undefined, chain, carried, origin);
    const { settleInbox } = options;
    return core.enter(() => core.execution.run({ root, frame, chain, carried }, async () => {
      let result: { value: unknown; spawnedIds: string[] };
      try {
        const callArgs = core.hydrate(structuredClone(args));
        const value = core.cloneResult(actor.id, actionName, await method.apply(actor.instance, callArgs));
        await this.#commit(actor, frame, {
          force: true,
          preserve: false,
          before: options.holdResult ? this.#holdForTx(actor, root, value) : [],
          after: settleSpawnOps(frame.spawnedIds, frame.id, parentFrameId),
          messages: frame.outbox.splice(0),
          inTransaction: settleInbox && (() => this.#settleInbox(settleInbox, root)),
        });
        result = { value, spawnedIds: parentFrameId ? [...frame.spawnedIds] : [] };
      } catch (error) {
        await this.#rollback(actor, frame, [...discardSpawnOps(frame.spawnedIds, frame.id), ...frame.outbox.flatMap((message) => messageReleaseOps(message))]);
        await frame.invocation.afterRollback(error);
        throw error;
      }
      /** Committed hooks are not durable; isolate failure after commit can skip them, so they are at-most-once. */
      try {
        const changed = Object.keys(changedStateFields(
          frame.initialState,
          cloneState(actor),
          actor,
        ));
        await frame.invocation.afterCommit(actor.version, changed);
      } catch (error) {
        if (parentFrameId !== undefined) {
          await this.#emit(result.spawnedIds.map((target): HolderOp => ({
            kind: "release",
            target,
            holder: frameHolder(parentFrameId),
          })));
        }
        throw error;
      }
      return result;
    }));
  }

  /** A same-actor call (local action or own ref) runs as a child frame that merges into its parent on success. */
  #runNested(actor: HostedActor, parent: ActionFrame, actionName: string, run: () => unknown): Promise<unknown> {
    const { core } = actor;
    const carried = parent.invocation.carried;
    const origin = parent.invocation.origin;
    const frame = this.#makeFrame(actor, parent.root, parent, new Set(parent.chain), carried, origin);
    return core.execution.run({ root: frame.root, frame, chain: frame.chain, carried }, async () => {
      let result: unknown;
      try {
        result = core.cloneResult(actor.id, actionName, await run());
        const holds = this.#holdForTx(actor, frame.root, result);
        parent.pendingOps.push(...frame.pendingOps);
        parent.outbox.push(...frame.outbox);
        const spawns = settleSpawnOps(frame.spawnedIds, frame.id, parent.id);
        for (const id of frame.spawnedIds) parent.spawnedIds.add(id);
        await this.#emit([...holds, ...spawns]);
      } catch (error) {
        await this.#rollback(actor, frame, [...discardSpawnOps(frame.spawnedIds, frame.id), ...frame.outbox.flatMap((message) => messageReleaseOps(message))]);
        await frame.invocation.afterRollback(error);
        throw error;
      }
      frame.invocation.mergeHooksInto(parent.invocation);
      return core.hydrate(result);
    });
  }

  /**
   * A segment commit: state, version, held refs and every outbox row it
   * produces (pending message holds, the held-ref diff, extra ops, detached
   * messages) are written in one transactionSync, then delivered.
   */
  async #commit(
    actor: HostedActor,
    frame: ActionFrame,
    options: {
      force: boolean;
      preserve: boolean;
      before?: HolderOp[];
      after?: HolderOp[];
      messages?: PendingOutboxMessage[];
      /** Runs inside the commit's transactionSync, after its rows were appended. */
      inTransaction?: () => void;
    },
  ): Promise<void> {
    const next = createSnapshot(actor);
    const changed = Object.keys(changedStateFields(frame.baseline, next.state, actor));
    if (!options.force && changed.length === 0) return;
    const { root } = frame;
    const version = actor.version + 1;
    const heldRefs = this.#stateRefs(actor, next.state);
    const diff = diffHeldRefs(actor.id, actor.heldRefs, heldRefs, options.preserve ? root.holder : undefined);
    for (const op of diff) if (op.holder === root.holder) recordTxHold(root.owned, op.target, root.holder);
    const ops = [...(options.before ?? []), ...frame.pendingOps.splice(0), ...diff, ...(options.after ?? [])];
    const committedAt = Date.now();
    this.ctx.storage.transactionSync(() => {
      const messages = options.messages?.map((message) => resolveActorMessage(message, committedAt));
      this.#kv.put(SNAPSHOT, next.data);
      this.#kv.put(VERSION, version);
      this.#kv.put(HELD_REFS, [...heldRefs]);
      this.#outbox.append(ops, messages);
      options.inTransaction?.();
    });
    actor.snapshot = next.data;
    actor.version = version;
    actor.heldRefs = heldRefs;
    frame.baseline = next.state;
    await this.#afterWrite();
  }

  async #rollback(actor: HostedActor, frame: ActionFrame, extra: HolderOp[]): Promise<void> {
    frame.pendingOps.length = 0;
    restoreState(actor, frame.initialState, (value) => actor.core.hydrate(value));
    if (actor.version <= frame.startVersion) {
      await this.#emit(extra);
      return;
    }
    const restored = createSnapshot(actor);
    const version = actor.version + 1;
    const data = cloneOrThrow(restored.data, (cause) => new ActorStateSerializationError(actor.id, cause));
    const heldRefs = this.#stateRefs(actor, restored.state);
    const diff = diffHeldRefs(actor.id, actor.heldRefs, heldRefs);
    this.ctx.storage.transactionSync(() => {
      this.#kv.put(SNAPSHOT, data);
      this.#kv.put(VERSION, version);
      this.#kv.put(HELD_REFS, [...heldRefs]);
      this.#outbox.append([...diff, ...extra]);
    });
    actor.snapshot = data;
    actor.version = version;
    actor.heldRefs = heldRefs;
    frame.baseline = restored.state;
    await this.#afterWrite();
  }

  async #emit(ops: HolderOp[]): Promise<void> {
    if (ops.length === 0) return;
    this.ctx.storage.transactionSync(() => this.#outbox.append(ops));
    await this.#afterWrite();
  }

  // ---- holder protocol -----------------------------------------------------

  #applyOps(ops: readonly HolderOp[]): void {
    const actor = this.#load();
    // A dead or never-created actor ignores ops: writing anything would resurrect its storage.
    if (!actor) return;
    let collect = false;
    for (const op of ops) {
      if (op.target !== actor.id) continue;
      if (applyHolderOp(actor.holders, op).collect) {
        collect = true;
        break;
      }
    }
    const releases = collect
      ? [...actor.heldRefs].map((target): HolderOp => ({ kind: "release", target, holder: actorHolder(actor.id) }))
      : [];
    this.ctx.storage.transactionSync(() => {
      this.#kv.put(HOLDERS, [...actor.holders]);
      if (!collect) return;
      this.#kv.put(COLLECTED, true);
      this.#outbox.append(releases);
    });
    if (collect) {
      this.#killed = true;
      // A live failure never armed a timer; collected delivery retries on its own schedule.
      this.#deliveryFailure = undefined;
    }
  }

  // ---- delivery ------------------------------------------------------------

  async #afterWrite(): Promise<void> {
    await this.#flush();
  }

  #scheduleAlarm(): void {
    const now = Date.now();
    const inboxDueAt = this.#earliestInboxAlarmAt(now);
    const retryAt = this.#kv.get(COLLECTED) ? this.#kv.get<number>(COLLECTED_RETRY_AT) : undefined;
    const dueAt = inboxDueAt === undefined
      ? retryAt
      : retryAt === undefined ? inboxDueAt : Math.min(inboxDueAt, retryAt);
    const alarm = dueAt !== undefined
      ? this.ctx.storage.setAlarm(Math.max(now, dueAt))
      : this.ctx.storage.deleteAlarm();
    void alarm.catch((error) => console.error(`ActorHost ${this.#id}: failed to update alarm`, error));
  }

  #earliestInboxAlarmAt(now: number): number | undefined {
    let earliest: number | undefined;
    for (const [key, value] of this.#kv.list<unknown>({ prefix: INBOX_PREFIX })) {
      const entry = readStoredInboxMessage(value);
      let alarmAt: number | undefined;
      if (entry.dueAt > now) {
        alarmAt = entry.dueAt;
      } else {
        const backstopKey = inboxBackstopKey(key);
        let backstop = this.#kv.get<InboxBackstop>(backstopKey);
        if (!backstop && this.#dispatching) {
          backstop = { attempt: 0, retryAt: now + RETRY_DELAYS_MS[0] };
          this.#kv.put(backstopKey, backstop);
        }
        alarmAt = backstop?.retryAt ?? (backstop ? undefined : now);
      }
      if (alarmAt !== undefined && (earliest === undefined || alarmAt < earliest)) earliest = alarmAt;
    }
    return earliest;
  }

  #advanceInboxBackstops(now: number): void {
    for (const [key, value] of this.#kv.list<unknown>({ prefix: INBOX_PREFIX })) {
      const backstopKey = inboxBackstopKey(key);
      const backstop = this.#kv.get<InboxBackstop>(backstopKey);
      if (!backstop?.retryAt || backstop.retryAt > now) continue;
      const attempt = backstop.attempt + 1;
      if (attempt >= RETRY_DELAYS_MS.length) {
        const { message } = readStoredInboxMessage(value);
        this.#kv.put(backstopKey, { attempt } satisfies InboxBackstop);
        console.error(
          `ActorHost ${this.#id}: inbox row ${key} message ${message.id} action ${message.action} remained in flight after 5 wake-ups; leaving it pending without another alarm`,
        );
      } else {
        this.#kv.put(backstopKey, {
          attempt,
          retryAt: now + RETRY_DELAYS_MS[attempt],
        } satisfies InboxBackstop);
      }
    }
  }

  /**
   * Delivers outbox rows in order and deletes each after its target acked;
   * once a collected actor's releases are out, deletes all of its storage.
   * A call made while a pass is running returns at once instead of waiting:
   * the running pass picks up the new rows, and waiting would deadlock a
   * cascade that loops back here (A delivers to B, B's collection releases a
   * ref back to A, A's applyHolderOps waits on A's own pass). Passing the
   * delivery chain along would not make waiting safe: two passes started
   * independently (A delivering to B while B delivers to A) would each wait
   * on the other with neither in the other's chain.
   */
  #flush(): Promise<void> {
    if (this.#flushing) return Promise.resolve();
    if (this.#deliveryFailure) return Promise.resolve();
    let finished!: () => void;
    // Marked busy before the pass starts: a pass that finds nothing to do completes synchronously,
    // and marking afterwards would leave the object busy forever.
    const pass = new Promise<void>((resolve) => { finished = resolve; });
    this.#flushing = pass;
    void (async () => {
      try {
        await this.#drainOutbox();
      } finally {
        this.#flushing = undefined;
        this.#scheduleAlarm();
        finished();
      }
    })();
    return pass;
  }

  /**
   * Resolves once every outbox row through `seq` was acked, and rejects when a delivery fails meanwhile. Never
   * waits on a running pass to finish, so it cannot join the loop-back deadlock #flush avoids.
   */
  #awaitDelivered(seq: number): Promise<void> {
    const pending = this.#outbox.first();
    if (!pending || pending.seq > seq) return Promise.resolve();
    if (this.#deliveryFailure && this.#deliveryFailure.seq <= seq) {
      return Promise.reject(this.#deliveryFailure.error);
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#deliveryWaiters.push({ seq, resolve, reject });
    void this.#flush();
    return promise;
  }

  #settleWaiters(error?: unknown): void {
    if (this.#deliveryWaiters.length === 0) return;
    const pendingSeq = this.#outbox.first()?.seq ?? Infinity;
    const waiting = [];
    for (const waiter of this.#deliveryWaiters) {
      if (waiter.seq < pendingSeq) waiter.resolve();
      else if (error !== undefined) waiter.reject(error);
      else waiting.push(waiter);
    }
    this.#deliveryWaiters = waiting;
  }

  /** Ends only right after a synchronous empty-outbox check, so a row appended while it awaited is never left behind. */
  async #drainOutbox(): Promise<void> {
    for (;;) {
      for (let next = this.#outbox.first(); next; next = this.#outbox.first()) {
        try {
          await this.#deliver(next);
        } catch (error) {
          const targetId = next.row.kind === "message" ? next.row.message.target.id : next.row.target;
          if (this.#kv.get(COLLECTED)) {
            const attempt = this.#kv.get<number>(COLLECTED_RETRY_ATTEMPT) ?? 0;
            const delay = RETRY_DELAYS_MS[attempt];
            if (delay === undefined) {
              this.#kv.delete(COLLECTED_RETRY_AT);
              console.error(
                `ActorHost ${this.#id}: outbox row ${next.seq} delivery to ${targetId} failed after 5 collected retries; actor storage and holds are left in place`,
                error,
              );
            } else {
              this.ctx.storage.transactionSync(() => {
                this.#kv.put(COLLECTED_RETRY_ATTEMPT, attempt + 1);
                this.#kv.put(COLLECTED_RETRY_AT, Date.now() + delay);
              });
              console.error(`ActorHost ${this.#id}: outbox row ${next.seq} delivery to ${targetId} failed`, error);
            }
          } else {
            console.error(`ActorHost ${this.#id}: outbox row ${next.seq} delivery to ${targetId} failed`, error);
          }
          this.#deliveryFailure = { seq: next.seq, error };
          this.#settleWaiters(error);
          return;
        }
        this.#outbox.remove(next.key);
        this.#settleWaiters();
      }
      if (this.#kv.get(COLLECTED)) {
        if (this.#queueForgetSeen()) continue;
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        this.#actor = undefined;
        this.#settleWaiters();
        return;
      }
      if (!this.#outbox.first()) {
        this.#scheduleAlarm();
        return;
      }
    }
  }

  /**
   * Once a collected actor's outbox is empty, queues a forget-seen row for every actor it sent messages to, so
   * a receiver keeps a `seen:` row only per live sender. Returns whether it queued any.
   */
  #queueForgetSeen(): boolean {
    const targets = [...this.#kv.list({ prefix: SENT_PREFIX })].map(([key]) => key.slice(SENT_PREFIX.length));
    if (targets.length === 0) return false;
    this.ctx.storage.transactionSync(() => {
      for (const target of targets) this.#kv.delete(`${SENT_PREFIX}${target}`);
      this.#outbox.append([], [], targets.map((target) => ({ kind: "forget-seen", target }) as const));
    });
    return true;
  }

  async #deliver({ seq, row }: { seq: number; row: OutboxRow }): Promise<void> {
    if (row.kind === "ops") {
      if (row.target === this.#id) this.#applyOps(row.ops);
      else await this.#stub(row.target).applyHolderOps([...row.ops]);
      return;
    }
    if (row.kind === "forget-seen") {
      await this.#stub(row.target).forgetSender(this.#id);
      return;
    }
    const { message } = row;
    const origin: MessageOrigin = { sender: this.#id, seq };
    // Recorded before sending: an eviction between the target's write and this one would otherwise lose it.
    if (message.target.id !== this.#id) this.#kv.put(`${SENT_PREFIX}${message.target.id}`, true);
    const ack = message.target.id === this.#id
      ? await this.deliverMessage(message, origin)
      : await this.#stub(message.target.id).deliverMessage(message, origin);
    if (ack === "dead") {
      // Nobody will run the message, so its holds on the other refs it carried are released here.
      // A dead target keeps no watermark, so there is nothing left to forget there either.
      const releases = messageReleaseOps(message, { exceptTarget: true });
      this.ctx.storage.transactionSync(() => {
        this.#kv.delete(`${SENT_PREFIX}${message.target.id}`);
        this.#outbox.append(releases);
      });
    }
  }

  #stub(id: string): ActorHostRpc {
    return stubOf(this.#binding(), id);
  }

  /** Removes a dispatched message and releases its root's tx: holds and its message: holds; call inside transactionSync. */
  #settleInbox({ key, message }: InboxEntry, root: RootTransaction): void {
    this.#kv.delete(key);
    this.#kv.delete(inboxBackstopKey(key));
    this.#outbox.append([...txReleaseOps(root.owned.values()), ...messageReleaseOps(message)]);
  }

  /** Runs inbox messages one at a time, each as its own root transaction, then releases the message's holds. */
  async #dispatchInbox(): Promise<void> {
    if (this.#dispatching) return;
    this.#dispatching = true;
    try {
      for (;;) {
        const actor = this.#load();
        if (!actor) return;
        let entry: [string, StoredInboxMessage] | undefined;
        const now = Date.now();
        for (const [key, value] of this.#kv.list<unknown>({ prefix: INBOX_PREFIX })) {
          const candidate = readStoredInboxMessage(value);
          if (candidate.dueAt > now) continue;
          if (!entry || candidate.dueAt < entry[1].dueAt
            || (candidate.dueAt === entry[1].dueAt && candidate.sequence < entry[1].sequence)) entry = [key, candidate];
        }
        if (!entry) return;
        const [key, { message }] = entry;
        this.#scheduleAlarm();
        // Derived from the message, so a run repeated after an eviction releases the same tx: holder.
        const root = actor.core.newRoot(true, `inbox_${message.id}`);
        const inbox: InboxEntry = { key, message };
        try {
          // Nobody receives a detached action's result, so it is not held for the root.
          await this.#withMailbox(() => this.#runTop(
            actor, root, new Set([actor.id]), undefined, message.action, [...message.args],
            undefined,
            message.target,
            { holdResult: false, settleInbox: inbox },
          ));
        } catch {
          // A failed detached action has no caller to report to; its frame already rolled back.
        }
        // A successful run settled the inbox inside its top commit; a failed one settles it here.
        if (this.#kv.get(key) !== undefined) {
          this.ctx.storage.transactionSync(() => this.#settleInbox(inbox, root));
          await this.#afterWrite();
        }
      }
    } finally {
      this.#dispatching = false;
      this.#scheduleAlarm();
    }
  }
}

const viewOf = (actor: HostedActor): ActorView => ({
  id: actor.id,
  type: actor.meta.type,
  version: actor.version,
  snapshot: actor.snapshot,
});

export interface ActorHostOptions {
  readonly contextProvider: ActorContextProvider;
}

/** Creates the Durable Object class that rebuilds application context inside each ActorHost isolate. */
export const createActorHost = (options: ActorHostOptions): typeof ActorHost => class extends ActorHost {
  protected override get actorContextProvider(): ActorContextProvider {
    return options.contextProvider;
  }
};
