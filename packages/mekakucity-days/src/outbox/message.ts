import type {
  ActorDescriptor,
  DueActorMessage,
  PendingActorMessage,
} from "@mekakucity/actors/runtime";

interface OutboxMessageData {
  readonly id: string;
  readonly target: ActorDescriptor;
  readonly action: string;
  readonly args: readonly unknown[];
  readonly heldIds: readonly string[];
  /** Sent from root context: durable only if the root itself succeeds. */
  readonly rootContext?: true;
}

export type PendingOutboxMessage = PendingActorMessage<OutboxMessageData>;
export type DueOutboxMessage = DueActorMessage<OutboxMessageData>;
export type OutboxMessage = PendingOutboxMessage | DueOutboxMessage;

export const isDueOutboxMessage = (message: OutboxMessage): message is DueOutboxMessage =>
  typeof message.dueAt === "number";
