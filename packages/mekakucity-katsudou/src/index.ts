import {
  Actor,
  ActorContextUnavailableError,
  ActorRuntime,
  ActorRuntimeError,
  type ActorConstructor,
  type ActorContext,
  type ActorDescriptor,
  type ActorDetachedSchedule,
  type ActorInput,
  type ActorRef,
} from "@mekakucity/actors";
import {
  actorClassOf,
  actorClassOrThrow,
  actorRefSurfaceFor,
  actorTypeIdOrThrow,
  createActorRef,
  metadataFor,
} from "@mekakucity/actors/runtime";

class KatsudouActorRuntimeImpl extends ActorRuntime {
  readonly #descriptor: ActorDescriptor;
  readonly #instance: Actor<unknown, unknown>;
  readonly #instances = new WeakMap<object, ActorDescriptor>();

  constructor(type: string, id: string) {
    super();
    const Type = actorClassOrThrow(type);
    this.#descriptor = { type, id };
    this.#instance = this.withActiveRuntime(() => new Type({}));
    this.#instances.set(this.#instance, this.#descriptor);
  }

  run<Result>(work: () => Result | Promise<Result>): Promise<Awaited<Result>> {
    return Promise.resolve(this.withActiveRuntime(work));
  }

  spawn<T extends Actor<unknown, unknown>>(
    _Type: ActorConstructor<T>,
    _input: ActorInput<T>,
    _key?: string,
  ): Promise<ActorRef<T>> {
    throw new ActorRuntimeError("Actor.spawn is unavailable in the katsudou skeleton");
  }

  resolve<T extends Actor<unknown, unknown>>(
    _Type: ActorConstructor<T>,
    _key: string,
  ): Promise<ActorRef<T> | null> {
    return Promise.resolve(null);
  }

  refreshValues<T extends Actor<unknown, unknown>>(ref: ActorRef<T> | ActorDescriptor): Promise<ActorRef<T>> {
    this.#assertLocal(ref);
    return Promise.resolve(this.#makeRef<T>());
  }

  selfDescriptorOf(instance: object): ActorDescriptor {
    const descriptor = this.#instances.get(instance);
    if (!descriptor) throw new ActorRuntimeError("Actor instance does not belong to this katsudou isolate");
    return descriptor;
  }

  actorContextOf(_instance: object): ActorContext {
    throw new ActorContextUnavailableError("No ActorContextProvider is configured");
  }

  invokeRefAction(ref: ActorDescriptor, actionName: string, args: unknown[]): Promise<unknown> {
    this.#assertLocal(ref);
    return this.invoke(actionName, args);
  }

  invokeLocalAction(_instance: object, _actionName: string, _args: unknown[], run: () => unknown): unknown {
    return run();
  }

  runDetached(
    _ref: ActorDescriptor,
    _actionName: string,
    _args: unknown[],
    _schedule: ActorDetachedSchedule,
  ): void {
    throw new ActorRuntimeError("Detached actions are unavailable in the katsudou skeleton");
  }

  readSnapshotValue(ref: ActorDescriptor, key: string): unknown {
    this.#assertLocal(ref);
    return Reflect.get(this.#instance, key);
  }

  async invoke(actionName: string, args: unknown[]): Promise<unknown> {
    const method = metadataFor(this.#instance).actions.get(actionName);
    if (!method) throw new ActorRuntimeError(`Unknown actor action ${actionName}`);
    return this.run(() => method.apply(this.#instance, args));
  }

  #assertLocal(ref: ActorDescriptor): void {
    if (ref.type !== this.#descriptor.type || ref.id !== this.#descriptor.id) {
      throw new ActorRuntimeError(`Actor ${ref.type}/${ref.id} is not hosted by this isolate`);
    }
  }

  #makeRef<T extends Actor<unknown, unknown>>(): ActorRef<T> {
    const Type = actorClassOrThrow(this.#descriptor.type);
    return createActorRef<T>(this.#descriptor, actorRefSurfaceFor(Type));
  }
}

export const KatsudouActorRuntime = KatsudouActorRuntimeImpl;
export type KatsudouActorRuntime = KatsudouActorRuntimeImpl;

export const describeActorTarget = (type: string, actionName: string): "actorType" | "action" | null => {
  const Type = actorClassOf(type);
  if (!Type) return "actorType";
  return metadataFor(Type).actions.has(actionName) ? null : "action";
};

export const createActorRuntime = (type: string, id: string): KatsudouActorRuntime => {
  const Type = actorClassOrThrow(type);
  if (actorTypeIdOrThrow(Type) !== type) throw new ActorRuntimeError(`Actor type mismatch for ${type}`);
  return new KatsudouActorRuntime(type, id);
};
