import type { ActorDescriptor } from "@mekakucity/actors";

export interface OutboxMessage {
  readonly id: string;
  readonly target: ActorDescriptor;
  readonly action: string;
  readonly args: readonly unknown[];
  readonly heldIds: readonly string[];
}
