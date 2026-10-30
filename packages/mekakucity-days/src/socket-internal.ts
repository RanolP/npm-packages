import type { ActorDescriptor } from "@mekakucity/actors";

export const socketRuntime = Symbol("mekakucity.days.socketRuntime");
export const socketRead = Symbol("mekakucity.days.socketRead");

export interface SocketValue {
  readonly value: unknown;
  readonly version: number;
}

export interface SocketRuntime {
  [socketRuntime](
    actor: ActorDescriptor,
    actionName: string,
    args: unknown[],
    carried: unknown,
  ): Promise<unknown>;
  [socketRead](actor: ActorDescriptor, key: string): Promise<SocketValue>;
}
