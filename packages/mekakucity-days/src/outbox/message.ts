import type { ActorDescriptor } from "@mekakucity/actors";

export interface OutboxMessage {
  readonly id: string;
  readonly target: ActorDescriptor;
  readonly action: string;
  readonly args: readonly unknown[];
  readonly heldIds: readonly string[];
  /** Sent from root context: durable only if the root itself succeeds. */
  readonly rootContext?: true;
}
