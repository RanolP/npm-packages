# @mekakucity/durable-object

## 0.4.2

### Patch Changes

- 621cb51: Declare `sideEffects` so bundlers can drop unused imports of these packages. `@mekakucity/days` and `@mekakucity/durable-object` have none. `@mekakucity/actors` no longer installs `Symbol.metadata` when imported; TypeScript `tsc` users can opt in through `@mekakucity/actors/polyfill`.

## 0.4.1

### Patch Changes

- c4e62d0: Report the read `@state` field as an optional `key` on actor read observations; a read without `key` depends on the whole actor.
- c4e62d0: An action that leaves an actor's state unchanged no longer raises its version or emits an `onCommit` event, so a read-only call no longer makes later reads observe a new version. Holder, outbox and inbox bookkeeping for that action is still written, and `afterCommit` hooks still run with the current version and an empty `changed`.

## 0.4.0

### Minor Changes

- 009b1c4: Add actor read observation scopes, include the committed actor, version, and accumulated changed state fields in after-commit hooks, and expose a best-effort runtime commit feed for every persisted action version across both runtimes and their conformance suite.

## 0.3.0

### Minor Changes

- 2532358: Add augmentable, per-action actor context with caller and detached-origin propagation plus transaction hooks to the actor contract, in-memory runtime, and Durable Object runtime.

### Patch Changes

- 50d9489: Document that `nodejs_compat` is needed only before `compatibility_date` 2026-08-04; from that date workerd provides `node:async_hooks` and `node:util` without a flag.

## 0.2.0

### Minor Changes

- c55eb11: Add the `@actor(id)` class decorator and make it required on every actor class. The id is the stable actor type id and replaces the class name (`@mekakucity/days`) and the `defineActorHost` key (`@mekakucity/durable-object`). The last class defined under an id wins and `console.warn` names the id and both classes, so Vite HMR and watch mode can re-evaluate a module; spawning, looking up or referencing an unregistered class or id throws `ActorRuntimeError` instead of building a reference without actions.

  `@state` and `@action` now record their members in decorator metadata when the class is defined, so `metadataFor(Type)` no longer needs an instance. This fixes Durable Object worker refs that had no action methods (`counter.add is not a function`) because the worker never constructs the actors it calls.

  Breaking: `@mekakucity/durable-object` removes `defineActorHost` and the test-only `allowUnregisteredTypes`; export `ActorHost` from the worker entry with `export { ActorHost } from "@mekakucity/durable-object"`. The verify suites decorate their actor classes, so they assert the new type ids.

- 0e29be3: Add `schedule({ after: { ms } })` and `schedule({ at: Date })` to actor-reference and self-reference actions; the returned object exposes only `runDetached`. A plain `runDetached` is the same as `schedule({ after: { ms: 0 } }).runDetached`. The delay counts from the commit that confirms the message, a rolled-back sender discards it, and messages to one target run by due time, then send order.

  `@mekakucity/days` now runs detached messages to different targets concurrently, keeping per-target order.

  `@mekakucity/durable-object` storage from 0.1.0 is incompatible when it contains queued inbox or outbox messages; drain queued detached messages before upgrading.

  Failed durable-object detached deliveries from a live actor are not retried automatically; the sending actor resends them when it next runs, and one failed row blocks its later rows. A collected actor retries its remaining release messages up to five times after 5, 8, 13, 21, and 34 seconds, then leaves its storage and holds in place if every retry fails.

  An in-flight durable-object inbox action uses per-message backstop alarms after 5, 8, 13, 21, and 34 seconds; after five wakes the runtime logs and leaves the inbox row without another alarm.

### Patch Changes

- a3a7178: Remove the `derived` decorator and expose actor class getters directly through references, where they recompute from the reference's current state snapshot. Update both runtime implementations and the conformance suite for the new getter surface.
- 3009fec: Add detached-only actor self references and conformance coverage for both runtimes.

  Fix the durable-object runtime throwing `ReferenceError: metadataFor is not defined` when an actor awaits an action on its own reference.

## 0.1.0

### Minor Changes

- a6023ff: Add the Cloudflare Durable Object backed `ActorRuntime` for `@mekakucity/actors`, exposing `DurableObjectActorRuntime` and `defineActorHost`, which registers the worker's actor classes under stable stored names and returns the `ActorHost` Durable Object class to export.
