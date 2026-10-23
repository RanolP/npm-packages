import type { ActorDescriptor } from "@mekakucity/actors";

export interface InMemoryActionReplyForTest {
  readonly baseVersion: number;
  readonly startVersion: number;
  readonly isDiff: boolean;
  readonly snapshot: Readonly<Record<string, unknown>>;
}

export interface InMemoryActorRuntimeTestHooks {
  evictSnapshotCache(ref: ActorDescriptor): void;
  lastActionReply(): InMemoryActionReplyForTest | undefined;
}

export const inMemoryActorRuntimeTestHooks: unique symbol = Symbol("@mekakucity/days test hooks");
