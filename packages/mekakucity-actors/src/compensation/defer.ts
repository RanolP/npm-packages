import { ActorRuntime } from "../runtime/actor-runtime.js";

export const defer = (method: Function, ...args: unknown[]): void => {
  ActorRuntime.current("defer").defer(method, args);
};
