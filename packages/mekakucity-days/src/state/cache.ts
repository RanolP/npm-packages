export interface SnapshotEntry {
  version: number;
  data?: Readonly<Record<string, unknown>>;
  references: number;
}

export class SnapshotCache {
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

  install(id: string, version: number, data: Readonly<Record<string, unknown>>): void {
    const entry = this.#ensure(id);
    entry.version = version;
    entry.data = structuredClone(data);
  }

  track(ref: object, id: string): void {
    this.#ensure(id).references += 1;
    this.#finalizer.register(ref, id);
  }

  delete(id: string): void {
    this.#entries.delete(id);
  }

  #ensure(id: string): SnapshotEntry {
    let entry = this.#entries.get(id);
    if (!entry) {
      entry = { version: -1, references: 0 };
      this.#entries.set(id, entry);
    }
    return entry;
  }
}
