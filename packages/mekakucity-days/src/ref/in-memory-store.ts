import type { OutboxMessage } from "../outbox/message.js";

export interface ActorRecord {
  readonly id: string;
  readonly type: string;
  readonly instance: object;
  readonly named: boolean;
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
  private deliveryHandler: ((message: OutboxMessage) => Promise<void>) | undefined;

  setDeliveryHandler(handler: (message: OutboxMessage) => Promise<void>): void {
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

  async deliver(message: OutboxMessage): Promise<void> {
    if (!this.deliveryHandler) throw new Error("No outbox delivery handler is configured");
    await this.deliveryHandler(message);
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
