import { isDeepStrictEqual } from "node:util";
import { DurableObject } from "cloudflare:workers";
import {
  ActorKilledError,
  ActorReentrancyError,
  ActorRuntimeError,
  ActorStateSerializationError,
} from "@mekakucity/actors";
import {
  actorHolder,
  applyHolderOp,
  cloneOrThrow,
  cloneState,
  createSnapshot,
  diffHeldRefs,
  discardSpawnOps,
  frameHolder,
  messageReleaseOps,
  metadataFor,
  restoreState,
  settleSpawnOps,
  stateFields,
  recordTxHold,
  txReleaseOps,
  type HolderOp,
} from "@mekakucity/actors/runtime";
import { capture } from "./errors.js";
import { Outbox } from "./outbox.js";
import {
  stubOf,
  type ActorHostRpc,
  type ActorView,
  type CreateRequest,
  type DeliveryAck,
  type InvokeRequest,
  type InvokeResult,
  type MessageOrigin,
  type OutboxMessage,
  type OutboxRow,
  type Outcome,
} from "./protocol.js";
import {
  createHostRuntimeCore,
  lookupTypeOrThrow,
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
const INBOX_PREFIX = "inbox:";
/** `seen:<sender>`: highest outbox sequence stored from that sender (deliverMessage dedupe). */
const SEEN_PREFIX = "seen:";
/**
 * `sent:<target>` on the sender: an actor that may hold a `seen:` watermark for it, forgotten when it is collected.
 * A "dead" ack deletes the key, so it is bounded by the targets this sender has messaged and not yet heard die.
 * Remaining growth: a target collected after its last message from this sender keeps its key until the sender
 * itself is collected, since nothing tells the sender.
 */
const SENT_PREFIX = "sent:";

/** Backstop alarm for at-least-once delivery when an inline flush failed or the object was evicted mid-flush. */
const RETRY_MS = 5_000;

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
  readonly message: OutboxMessage;
}

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
  #dispatching = false;
  /** Callers waiting until every outbox row through `seq` was acked (#awaitDelivered). */
  #deliveryWaiters: { seq: number; resolve: () => void; reject: (error: unknown) => void }[] = [];

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
      const existing = this.#load();
      if (existing) {
        if (request.named) return viewOf(existing);
        throw new ActorRuntimeError(`Actor ${this.#id} already exists`);
      }
      const core = createHostRuntimeCore(this.#binding(), request.scope);
      const Type = lookupTypeOrThrow(request.type, request.scope);
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
      const actor = this.#load();
      return actor ? viewOf(actor) : null;
    });
  }

  invoke(request: InvokeRequest): Promise<Outcome<InvokeResult>> {
    return capture(async () => {
      const actor = this.#load();
      if (!actor) throw new ActorKilledError(this.#id);
      if (request.context.chain.includes(actor.id)) throw new ActorReentrancyError(actor.id);
      const root = actor.core.newRoot(false, request.context.rootId, request.context.callId);
      const chain = new Set([...request.context.chain, actor.id]);
      const result = await this.#withMailbox(async () => {
        const { value, spawnedIds } = await this.#runTop(
          actor,
          root,
          chain,
          request.context.parentFrameId,
          request.action,
          [...request.args],
        );
        return { ...viewOf(actor), value, owned: [...root.owned.values()], spawnedIds, written: this.#outbox.append([]) };
      });
      // The caller releases these holds directly once its root ends, so this commit's hold(tx) rows must
      // reach their targets first or a late hold re-adds a holder nobody releases. Waited outside the mailbox:
      // delivery never needs it.
      const { written, ...reply } = result;
      try {
        await this.#awaitDelivered(written);
      } catch (error) {
        // The rows still go out on the retry, but the caller gets an error instead of owned and spawnedIds
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
  async deliverMessage(message: OutboxMessage, origin?: MessageOrigin): Promise<DeliveryAck> {
    if (!this.#load()) return "dead";
    const key = `${INBOX_PREFIX}${message.id}`;
    const seenKey = `${SEEN_PREFIX}${origin?.sender}`;
    const duplicate = origin !== undefined && (this.#kv.get<number>(seenKey) ?? 0) >= origin.seq;
    if (!duplicate && this.#kv.get(key) === undefined) {
      this.ctx.storage.transactionSync(() => {
        this.#kv.put(key, message);
        if (origin) this.#kv.put(seenKey, origin.seq);
      });
    }
    this.#scheduleRetry();
    void this.#dispatchInbox();
    return "queued";
  }

  /** Drops a collected sender's watermark: its forget-seen row is its last, so nothing it sent can arrive later. */
  async forgetSender(sender: string): Promise<void> {
    if (!this.#load()) return;
    this.#kv.delete(`${SEEN_PREFIX}${sender}`);
  }

  override async alarm(): Promise<void> {
    await this.#flush();
    await this.#dispatchInbox();
  }

  // ---- loading -------------------------------------------------------------

  #load(): HostedActor | undefined {
    if (this.#killed) return undefined;
    if (this.#actor) return this.#actor;
    const meta = this.#kv.get<ActorMeta>(META);
    if (!meta) return undefined;
    if (this.#kv.get(COLLECTED)) {
      this.#killed = true;
      return undefined;
    }
    const core = createHostRuntimeCore(this.#binding(), meta.scope);
    const Type = lookupTypeOrThrow(meta.type, meta.scope);
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

  #makeFrame(actor: HostedActor, root: RootTransaction, parent: ActionFrame | undefined, chain: Set<string>): ActionFrame {
    const state = cloneState(actor);
    return {
      id: `frame_${crypto.randomUUID()}`,
      root,
      parent,
      chain,
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
    options: { holdResult: boolean; settleInbox?: InboxEntry } = { holdResult: true },
  ): Promise<{ value: unknown; spawnedIds: string[] }> {
    const { core } = actor;
    const method = metadataFor(actor.instance).actions.get(actionName);
    if (!method) return Promise.reject(new ActorRuntimeError(`Unknown actor action ${actionName}`));
    const frame = this.#makeFrame(actor, root, undefined, chain);
    const { settleInbox } = options;
    return core.enter(() => core.execution.run({ root, frame, chain }, async () => {
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
        return { value, spawnedIds: parentFrameId ? [...frame.spawnedIds] : [] };
      } catch (error) {
        await this.#rollback(actor, frame, [...discardSpawnOps(frame.spawnedIds, frame.id), ...frame.outbox.flatMap((message) => messageReleaseOps(message))]);
        throw error;
      }
    }));
  }

  /** A same-actor call (local action or own ref) runs as a child frame that merges into its parent on success. */
  #runNested(actor: HostedActor, parent: ActionFrame, actionName: string, run: () => unknown): Promise<unknown> {
    const { core } = actor;
    const frame = this.#makeFrame(actor, parent.root, parent, new Set(parent.chain));
    return core.execution.run({ root: frame.root, frame, chain: frame.chain }, async () => {
      try {
        const value = core.cloneResult(actor.id, actionName, await run());
        const holds = this.#holdForTx(actor, frame.root, value);
        parent.pendingOps.push(...frame.pendingOps);
        parent.outbox.push(...frame.outbox);
        const spawns = settleSpawnOps(frame.spawnedIds, frame.id, parent.id);
        for (const id of frame.spawnedIds) parent.spawnedIds.add(id);
        await this.#emit([...holds, ...spawns]);
        return core.hydrate(value);
      } catch (error) {
        await this.#rollback(actor, frame, [...discardSpawnOps(frame.spawnedIds, frame.id), ...frame.outbox.flatMap((message) => messageReleaseOps(message))]);
        throw error;
      }
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
      messages?: OutboxMessage[];
      /** Runs inside the commit's transactionSync, after its rows were appended. */
      inTransaction?: () => void;
    },
  ): Promise<void> {
    const next = createSnapshot(actor);
    const changed = stateFields(actor).some((key) => !isDeepStrictEqual(frame.baseline[key], next.state[key]));
    if (!options.force && !changed) return;
    const { root } = frame;
    const version = actor.version + 1;
    const heldRefs = this.#stateRefs(actor, next.state);
    const diff = diffHeldRefs(actor.id, actor.heldRefs, heldRefs, options.preserve ? root.holder : undefined);
    for (const op of diff) if (op.holder === root.holder) recordTxHold(root.owned, op.target, root.holder);
    const ops = [...(options.before ?? []), ...frame.pendingOps.splice(0), ...diff, ...(options.after ?? [])];
    this.ctx.storage.transactionSync(() => {
      this.#kv.put(SNAPSHOT, next.data);
      this.#kv.put(VERSION, version);
      this.#kv.put(HELD_REFS, [...heldRefs]);
      this.#outbox.append(ops, options.messages);
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
    if (collect) this.#killed = true;
  }

  // ---- delivery ------------------------------------------------------------

  async #afterWrite(): Promise<void> {
    this.#scheduleRetry();
    await this.#flush();
  }

  #scheduleRetry(): void {
    void this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
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
          console.error(`ActorHost ${this.#id}: outbox delivery failed, retrying in ${RETRY_MS}ms`, error);
          this.#scheduleRetry();
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
      if (this.#hasInbox()) return;
      await this.ctx.storage.deleteAlarm();
      if (!this.#outbox.first()) return;
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

  #hasInbox(): boolean {
    for (const _ of this.#kv.list({ prefix: INBOX_PREFIX, limit: 1 })) return true;
    return false;
  }

  /** Removes a dispatched message and releases its root's tx: holds and its message: holds; call inside transactionSync. */
  #settleInbox({ key, message }: InboxEntry, root: RootTransaction): void {
    this.#kv.delete(key);
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
        let entry: [string, OutboxMessage] | undefined;
        for (const item of this.#kv.list<OutboxMessage>({ prefix: INBOX_PREFIX, limit: 1 })) entry = item;
        if (!entry) return;
        const [key, message] = entry;
        // Derived from the message, so a run repeated after an eviction releases the same tx: holder.
        const root = actor.core.newRoot(true, `inbox_${message.id}`);
        const inbox: InboxEntry = { key, message };
        try {
          // Nobody receives a detached action's result, so it is not held for the root.
          await this.#withMailbox(() => this.#runTop(
            actor, root, new Set([actor.id]), undefined, message.action, [...message.args],
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
    }
  }
}

const viewOf = (actor: HostedActor): ActorView => ({
  id: actor.id,
  type: actor.meta.type,
  version: actor.version,
  snapshot: actor.snapshot,
});
