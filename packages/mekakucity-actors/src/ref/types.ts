import type { Actor } from "../core/actor.js";

declare const actorRefBrand: unique symbol;

type ActorRefValue = { readonly [actorRefBrand]: true; readonly type: string; readonly id: string };

export type Cloneable =
  | string | number | boolean | bigint | null | undefined
  | Date | RegExp | ArrayBuffer | SharedArrayBuffer | ArrayBufferView
  | ActorRefValue
  | readonly Cloneable[]
  | ReadonlyMap<Cloneable, Cloneable>
  | ReadonlySet<Cloneable>
  | { readonly [key: string]: Cloneable; readonly [key: symbol]: never };

type IsAny<Value> = 0 extends (1 & Value) ? true : false;
type IsStructuredCloneSafe<Value, Seen = never> = IsAny<Value> extends true
  ? false
  : [Value] extends [Cloneable]
    ? true
  : Value extends undefined | void | string | number | boolean | bigint | null
    ? true
    : Value extends { readonly [actorRefBrand]: true }
      ? true
      : Value extends (...args: any[]) => unknown
        ? false
        : Value extends Date | RegExp | ArrayBuffer | SharedArrayBuffer | DataView
          | Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array
          | Int32Array | Uint32Array | Float32Array | Float64Array | BigInt64Array | BigUint64Array
          ? true
          : Value extends Map<infer Key, infer Item>
            ? [IsStructuredCloneSafe<Key, Seen>, IsStructuredCloneSafe<Item, Seen>] extends [true, true] ? true : false
            : Value extends Set<infer Item>
              ? IsStructuredCloneSafe<Item, Seen>
              : Value extends readonly (infer Item)[]
                ? IsStructuredCloneSafe<Item, Seen>
                : Value extends object
                  ? Value extends Seen
                    ? true
                    : [Extract<keyof Value, symbol>] extends [never]
                      ? false extends {
                        [Key in keyof Value]-?: IsStructuredCloneSafe<Value[Key], Seen | Value>
                      }[keyof Value]
                        ? false
                        : true
                      : false
                  : false;

export type StructuredCloneable<Value> = [IsStructuredCloneSafe<Value>] extends [true] ? Value : never;

export type ActorScheduleOptions =
  | { readonly after: { readonly ms: number }; readonly at?: never }
  | { readonly at: Date; readonly after?: never };

export interface ScheduledDetachedAction<Args extends unknown[]> {
  runDetached(...args: Args): void;
}

type DetachedAction<Args extends unknown[]> = {
  runDetached(...args: Args): void;
  schedule(options: ActorScheduleOptions): ScheduledDetachedAction<Args>;
};

// Generic method inference can surface as unknown; preserve the original method signature in that case.
type IsActionResultCloneable<Value> = unknown extends Value
  ? true
  : [StructuredCloneable<Value>] extends [never]
    ? [Value] extends [Cloneable] ? true : false
    : true;

export type DeepReadonly<Value> = Value extends { readonly type: string; readonly id: string }
  ? Value
  : Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

export type ActorRefAction<T, Key extends keyof T> = T[Key] extends (...args: infer Args) => PromiseLike<infer Result>
  ? IsAny<Awaited<Result>> extends true
    ? never
    : IsActionResultCloneable<Awaited<Result>> extends true
      ? T[Key] & DetachedAction<Args>
      : never
  : never;

export type ActorRef<T> = ActorRefValue & {
  readonly [Key in keyof T]: T[Key] extends (...args: never[]) => unknown
    ? ActorRefAction<T, Key>
    : DeepReadonly<T[Key]>;
};

export type ActorSelfRef<T> = {
  readonly [Key in keyof T as ActorRefAction<T, Key> extends never ? never : Key]:
    ActorRefAction<T, Key> extends (...args: infer Args) => unknown
      ? DetachedAction<Args>
      : never;
};

export type ActorInput<T> = T extends Actor<unknown, infer Input> ? Input : never;

export interface ActorRefInit<T> {
  orSpawn(factory: () => ActorInput<T> | Promise<ActorInput<T>>): Promise<ActorRef<T>>;
  orNull(): Promise<ActorRef<T> | null>;
}
