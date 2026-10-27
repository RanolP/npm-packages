import type { ActorDescriptor } from "@mekakucity/actors";
import type { DueActorMessage, HolderOp, PendingActorMessage, TxHold } from "@mekakucity/actors/runtime";
import type { ActorHost } from "./host.js";

/** A detached action call, persisted in the sender's outbox and then in the target's inbox. */
interface OutboxMessageData {
  readonly id: string;
  readonly target: ActorDescriptor;
  readonly action: string;
  readonly args: readonly unknown[];
  readonly heldIds: readonly string[];
}

export type PendingOutboxMessage = PendingActorMessage<OutboxMessageData>;
export type DueOutboxMessage = DueActorMessage<OutboxMessageData>;

/** One durable outbox row; a row is deleted only after its target acknowledged it. */
export type OutboxRow =
  | { readonly kind: "ops"; readonly target: string; readonly ops: readonly HolderOp[] }
  | { readonly kind: "message"; readonly message: DueOutboxMessage }
  /** Last row a collected sender sends each actor it delivered messages to: drop its `seen:` watermark. */
  | { readonly kind: "forget-seen"; readonly target: string };

/**
 * Transaction context carried explicitly over RPC, because AsyncLocalStorage
 * does not cross a Durable Object stub.
 */
export interface CallContext {
  readonly rootId: string;
  /** Fresh per invoke: the callee holds its results with `txHolder(rootId, callId)`, a key no other call shares. */
  readonly callId: string;
  readonly chain: readonly string[];
  /** The calling frame when the caller is itself an actor action; the callee hands its spawns to it. */
  readonly parentFrameId?: string;
  /** Per-call application context, carried explicitly because AsyncLocalStorage does not cross a stub. */
  readonly carried?: unknown;
  /** Actor whose detached invocation started this call chain; absent for caller-started chains. */
  readonly origin?: ActorDescriptor;
}

export interface ActorView {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly snapshot: Readonly<Record<string, unknown>>;
}

export interface InvokeResult extends ActorView {
  readonly value: unknown;
  /** Holds the caller's root transaction now owns and must release when it finishes. */
  readonly owned: readonly TxHold[];
  /** Actors spawned by this call that are now held by `parentFrameId`. */
  readonly spawnedIds: readonly string[];
}

export interface CreateRequest {
  readonly scope: string;
  readonly type: string;
  readonly input: unknown;
  readonly named: boolean;
  readonly holders: readonly string[];
}

export interface InvokeRequest {
  readonly action: string;
  readonly args: readonly unknown[];
  readonly context: CallContext;
}

export type DeliveryAck = "queued" | "dead";

/**
 * Where an outbox delivery came from: the sending ActorHost and the outbox row
 * sequence. A sender's rows go out strictly in sequence order, so the target
 * treats a row at or below the highest sequence it stored from that sender as
 * a redelivery.
 */
export interface MessageOrigin {
  readonly sender: string;
  readonly seq: number;
}

export interface WireError {
  readonly name: string;
  readonly message: string;
  readonly token: string;
}

/** Host methods return errors as values: RPC would otherwise strip the class of a thrown error. */
export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: WireError };

/** The ActorHost RPC methods as callers use them. */
export interface ActorHostRpc {
  create(request: CreateRequest): Promise<Outcome<ActorView>>;
  view(): Promise<Outcome<ActorView | null>>;
  invoke(request: InvokeRequest): Promise<Outcome<InvokeResult>>;
  applyHolderOps(ops: HolderOp[]): Promise<void>;
  deliverMessage(message: DueOutboxMessage, origin?: MessageOrigin): Promise<DeliveryAck>;
  forgetSender(sender: string): Promise<void>;
}

/**
 * The one place a stub is typed. workers-types' Rpc mapping turns the
 * `unknown` payloads in these signatures (action args, results, snapshots)
 * into `{}`/`never`, so `DurableObjectStub<ActorHost>` cannot express them;
 * ActorHost implements ActorHostRpc (checked in host.ts), which is what makes
 * this cast sound.
 */
export const stubOf = (binding: DurableObjectNamespace<ActorHost>, id: string): ActorHostRpc =>
  binding.get(binding.idFromString(id)) as unknown as ActorHostRpc;
