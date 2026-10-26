import { ActorHost } from "./host.js";
import { registerTypes, type AnyActorConstructor } from "./registry.js";

/**
 * Registers the worker's actor classes and returns the Durable Object class to export from the worker entry
 * (bound as `ACTOR_HOST`). Call it at module load so every isolate, including one a Durable Object wakes in,
 * resolves the same classes.
 *
 * Each key is the type name stored with every actor of that class: renaming a key orphans the actors stored
 * under the old one, while renaming the class is safe. Binding one key to two classes, or one class under two
 * keys, throws here.
 */
export const defineActorHost = (types: Readonly<Record<string, AnyActorConstructor>>): typeof ActorHost => {
  registerTypes(types);
  return ActorHost;
};
