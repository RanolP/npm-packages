import type { Actor } from "@mekakucity/actors";
import { actorClassOf, actorClassOrThrow, actorTypeIdOrThrow } from "@mekakucity/actors/runtime";

/** A registered actor class with its input type erased, as a host sees it after resolving a wire type id. */
export interface RegisteredType {
  readonly Type: Function;
  construct(input: unknown): Actor<unknown, unknown>;
}

// Type ids come from @actor, which registers each class when its module is evaluated, so every isolate that
// loads the worker's modules (including one a Durable Object wakes in) resolves the same ids. The id is
// persisted in each actor's meta.

/** The wire type id of `Type`; throws, naming the class, when it lacks @actor(id). */
export const typeNameOf = (Type: Function): string => actorTypeIdOrThrow(Type);

/** Throws when no loaded class is decorated with @actor(type), so a caller never gets a ref without actions. */
export const lookupType = (type: string): RegisteredType => {
  const Type = actorClassOrThrow(type);
  // The wire input reaching construct() is the structured clone of the ActorInput a caller passed to
  // spawn/orSpawn for this same type id, which is the input this class's constructor declares.
  return { Type, construct: (input) => new Type(input) };
};

export const isKnownType = (type: string): boolean => actorClassOf(type) !== undefined;
