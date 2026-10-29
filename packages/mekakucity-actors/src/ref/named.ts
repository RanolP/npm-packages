import type { Actor } from "../core/actor.js";
import { actorTypeIdOrThrow } from "../core/actor-type.js";
import type { ActorConstructor } from "../runtime/actor-runtime.js";
import type { ActorRuntime } from "../runtime/actor-runtime.js";
import { ActorNotFoundError } from "./errors.js";
import type { ActorInput, ActorRef } from "./types.js";

const namedCreations = new WeakMap<ActorRuntime, Map<string, Promise<ActorRef<any>>>>();

export class ActorRefInit<T extends Actor<unknown, unknown>> {
  readonly #runtime: ActorRuntime;
  readonly #Type: ActorConstructor<T>;
  readonly #key: string;

  constructor(runtime: ActorRuntime, Type: ActorConstructor<T>, key: string) {
    this.#runtime = runtime;
    this.#Type = Type;
    this.#key = key;
  }

  async orSpawn(factory: () => ActorInput<T> | Promise<ActorInput<T>>): Promise<ActorRef<T>> {
    let creations = namedCreations.get(this.#runtime);
    if (!creations) {
      creations = new Map<string, Promise<ActorRef<any>>>();
      namedCreations.set(this.#runtime, creations);
    }
    const id = `${actorTypeIdOrThrow(this.#Type)}\0${this.#key}`;
    const pending = creations.get(id);
    if (pending) return await pending as ActorRef<T>;
    const creation = (async () => {
      const existing = await this.orNull();
      if (existing) return existing;
      return this.#runtime.spawn(this.#Type, await factory(), this.#key);
    })();
    creations.set(id, creation);
    try {
      return await creation;
    } finally {
      if (creations.get(id) === creation) creations.delete(id);
    }
  }

  orNull(): Promise<ActorRef<T> | null> {
    return this.#runtime.resolve(this.#Type, this.#key);
  }

  /** Requires an existing actor, for example `Gathering.ofId(id).orThrow(() => gatheringNotFound(id))`. */
  async orThrow(error?: () => unknown): Promise<ActorRef<T>> {
    const ref = await this.orNull();
    if (ref) return ref;
    throw error ? error() : new ActorNotFoundError(actorTypeIdOrThrow(this.#Type), this.#key);
  }
}
