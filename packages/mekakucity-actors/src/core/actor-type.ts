import { ActorRuntimeError } from "../runtime/errors.js";
import type { Actor } from "./actor.js";

type AnyActorClass = abstract new (input: never) => Actor<unknown, unknown>;

// Filled at class definition time by @actor, so any isolate that loaded an actor's module resolves its type id,
// whether or not it ever constructs the actor.
const classesById = new Map<string, Function>();
const idsByClass = new WeakMap<Function, string>();

const labelOf = (Type: Function): string => Type.name || "(anonymous)";

/**
 * Registers an actor class under `id`, its stable type id. Runtimes persist and route actors by this id, so
 * renaming the class is safe while changing the id orphans actors stored under the old one. Binding an id that
 * already belongs to another class throws when the class is defined.
 */
export const actor = (id: string) =>
  <Class extends AnyActorClass>(Type: Class, _context: ClassDecoratorContext<Class>): void => {
    if (typeof id !== "string" || id === "" || id.includes("\0")) {
      throw new ActorRuntimeError(`@actor id ${JSON.stringify(id)} on class ${labelOf(Type)} must be a non-empty string without NUL`);
    }
    const bound = classesById.get(id);
    if (bound !== undefined && bound !== Type) {
      throw new ActorRuntimeError(`@actor id "${id}" on class ${labelOf(Type)} is already bound to class ${labelOf(bound)}`);
    }
    const known = idsByClass.get(Type);
    if (known !== undefined && known !== id) {
      throw new ActorRuntimeError(`Actor class ${labelOf(Type)} is already registered as "${known}", not "${id}"`);
    }
    classesById.set(id, Type);
    idsByClass.set(Type, id);
  };

/** The @actor id of exactly `Type`; a subclass does not inherit its parent's id. */
export const actorTypeIdOf = (Type: Function): string | undefined => idsByClass.get(Type);

export const actorClassOf = (id: string): Function | undefined => classesById.get(id);

export const actorTypeIdOrThrow = (Type: Function): string => {
  const id = idsByClass.get(Type);
  if (id === undefined) {
    throw new ActorRuntimeError(`Actor class ${labelOf(Type)} is not registered; decorate it with @actor(id)`);
  }
  return id;
};

export const actorClassOrThrow = (id: string): Function => {
  const Type = classesById.get(id);
  if (Type === undefined) {
    throw new ActorRuntimeError(
      `Actor type "${id}" is not registered; decorate its class with @actor(${JSON.stringify(id)}) and import the module that defines it`,
    );
  }
  return Type;
};
