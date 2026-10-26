import { actorHolder, applyHolderOp, type HolderOp } from "@mekakucity/actors/runtime";
import type { DueOutboxMessage } from "../outbox/message.js";

export interface ActorRecord {
  readonly id: string;
  readonly type: string;
  readonly instance: object;
  readonly mailbox: { tail: Promise<void> };
  readonly holders: Set<string>;
  readonly heldRefs: Set<string>;
  version: number;
  snapshot: Readonly<Record<string, unknown>>;
  killed: boolean;
}

export class InMemoryStore {
  private readonly actors = new Map<string, ActorRecord>();
  private readonly named = new Map<string, string>();
  private deliveryHandler: ((message: DueOutboxMessage) => Promise<void>) | undefined;

  setDeliveryHandler(handler: (message: DueOutboxMessage) => Promise<void>): void {
    this.deliveryHandler = handler;
  }

  async route(id: string): Promise<ActorRecord | undefined> {
    const record = this.actors.get(id);
    return record && !record.killed ? record : undefined;
  }

  async register(record: ActorRecord): Promise<void> {
    this.actors.set(record.id, record);
  }

  async persist(id: string, snapshot: Readonly<Record<string, unknown>>, version: number): Promise<void> {
    const record = this.actors.get(id);
    if (!record || record.killed) throw new Error(`Cannot persist missing actor ${id}`);
    record.snapshot = snapshot;
    record.version = version;
  }

  async bindNamed(type: string, key: string, id: string): Promise<void> {
    this.named.set(`${type}\0${key}`, id);
  }

  async lookupNamed(type: string, key: string): Promise<string | undefined> {
    return this.named.get(`${type}\0${key}`);
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
    const record = this.actors.get(id);
    if (!record) return;
    record.killed = true;
    this.actors.delete(id);
    for (const [key, actorId] of this.named) {
      if (actorId === id) this.named.delete(key);
    }
  }
}
