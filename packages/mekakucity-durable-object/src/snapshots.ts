type StateData = Record<string, unknown>;

interface SnapshotEntry {
  version: number;
  data?: Readonly<StateData>;
  /** Live refs to the actor in this isolate; the entry goes when the last one is finalized. */
  references: number;
}

/**
 * Views of actors that RPC replies delivered to this isolate, shared by its
 * runtimes. A ref reads the newest view that reached the isolate, which may be
 * older than the actor's latest commit; `Actor.refreshValues` fetches a newer one.
 */
class SnapshotCache {
  readonly #entries = new Map<string, SnapshotEntry>();
  readonly #finalizer = new FinalizationRegistry<string>((id) => {
    const entry = this.#entries.get(id);
    if (!entry) return;
    entry.references -= 1;
    if (entry.references <= 0) this.#entries.delete(id);
  });

  get(id: string): SnapshotEntry | undefined {
    return this.#entries.get(id);
  }

  /** Records a view an RPC returned; the caller tracks the ref it hands out for it. */
  install(id: string, version: number, data: Readonly<StateData>): void {
    let entry = this.#entries.get(id);
    if (!entry) {
      entry = { version: -1, references: 0 };
      this.#entries.set(id, entry);
    }
    this.#update(entry, version, data);
  }

  track(ref: object, id: string): void {
    let entry = this.#entries.get(id);
    if (!entry) {
      entry = { version: -1, references: 0 };
      this.#entries.set(id, entry);
    }
    entry.references += 1;
    this.#finalizer.register(ref, id);
  }

  delete(id: string): void {
    this.#entries.delete(id);
  }

  // Replies can arrive out of order; an older version never replaces a newer one.
  #update(entry: SnapshotEntry, version: number, data: Readonly<StateData>): void {
    if (entry.data && version < entry.version) return;
    entry.version = version;
    entry.data = structuredClone(data);
  }
}

export const snapshots = new SnapshotCache();
