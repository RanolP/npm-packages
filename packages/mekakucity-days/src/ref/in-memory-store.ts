import { actorHolder, applyHolderOp, type HolderOp } from "@mekakucity/actors/runtime";
import type { DueOutboxMessage } from "../outbox/message.js";

export interface ActorRecord {
  readonly id: string;
  readonly type: string;
  /** The spawn input as a structured clone, so a fork can construct the actor again; see recordInput. */
  readonly input: RecordedInput;
  readonly instance: object;
  readonly mailbox: { tail: Promise<void> };
  readonly holders: Set<string>;
  readonly heldRefs: Set<string>;
  version: number;
  snapshot: Readonly<Record<string, unknown>>;
  killed: boolean;
}

export type RecordedInput = { readonly value: unknown } | { readonly unclonable: unknown };

/** Spawning keeps accepting inputs structuredClone rejects; only a fork touching that actor fails on them. */
export const recordInput = (input: unknown): RecordedInput => {
  try {
    return { value: structuredClone(input) };
  } catch (cause) {
    return { unclonable: cause };
  }
};

/**
 * Actor records and named bindings. A fork's store owns only what it touched: `route` copies a live record
 * from `base` through `materialize` on first touch, and `tombstones` hide base records the fork killed.
 */
export class InMemoryStore {
  private readonly actors = new Map<string, ActorRecord>();
  private readonly named = new Map<string, string>();
  private readonly tombstones = new Set<string>();
  private deliveryHandler: ((message: DueOutboxMessage) => Promise<void>) | undefined;

  constructor(
    private readonly base?: InMemoryStore,
    private readonly materialize?: (record: ActorRecord) => ActorRecord,
  ) {}

  setDeliveryHandler(handler: (message: DueOutboxMessage) => Promise<void>): void {
    this.deliveryHandler = handler;
  }

  /** Live record visible to this store without copying it; a base record is returned as is. */
  private peek(id: string): ActorRecord | undefined {
    const record = this.actors.get(id);
    if (record) return record.killed ? undefined : record;
    if (this.tombstones.has(id)) return undefined;
    return this.base?.peek(id);
  }

  private own(id: string): ActorRecord | undefined {
    const owned = this.actors.get(id);
    if (owned) return owned.killed ? undefined : owned;
    const found = this.peek(id);
    if (!found || !this.materialize) return undefined;
    const record = this.materialize(found);
    this.actors.set(id, record);
    return record;
  }

  async route(id: string): Promise<ActorRecord | undefined> {
    return this.own(id);
  }

  async register(record: ActorRecord): Promise<void> {
    this.actors.set(record.id, record);
  }

  async persist(id: string, snapshot: Readonly<Record<string, unknown>>, version: number): Promise<void> {
    const record = this.own(id);
    if (!record) throw new Error(`Cannot persist missing actor ${id}`);
    record.snapshot = snapshot;
    record.version = version;
  }

  async bindNamed(type: string, key: string, id: string): Promise<void> {
    this.named.set(`${type}\0${key}`, id);
  }

  async lookupNamed(type: string, key: string): Promise<string | undefined> {
    return this.peekNamed(`${type}\0${key}`);
  }

  private peekNamed(bindingKey: string): string | undefined {
    const local = this.named.get(bindingKey);
    if (local !== undefined) return local;
    const inherited = this.base?.peekNamed(bindingKey);
    return inherited !== undefined && !this.tombstones.has(inherited) ? inherited : undefined;
  }

  async deliver(message: DueOutboxMessage): Promise<void> {
    if (!this.deliveryHandler) throw new Error("No outbox delivery handler is configured");
    await this.deliveryHandler(message);
  }

  /** Target-side half of the holder protocol: applies one op to this actor's own holders and, on collection, returns the releases for the refs it held. */
  async applyHolderOp(op: HolderOp): Promise<HolderOp[]> {
    const record = await this.route(op.target);
    if (!record || !applyHolderOp(record.holders, op).collect) return [];
    await this.kill(record.id);
    return [...record.heldRefs].map((target) => ({ kind: "release", target, holder: actorHolder(record.id) }));
  }

  async kill(id: string): Promise<void> {
    if (this.base) this.tombstones.add(id);
    const record = this.actors.get(id);
    if (record) {
      record.killed = true;
      this.actors.delete(id);
    }
    for (const [key, actorId] of this.named) {
      if (actorId === id) this.named.delete(key);
    }
  }
}
