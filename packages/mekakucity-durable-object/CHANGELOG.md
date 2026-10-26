# @mekakucity/durable-object

## 0.1.0

### Minor Changes

- a6023ff: Add the Cloudflare Durable Object backed `ActorRuntime` for `@mekakucity/actors`, exposing `DurableObjectActorRuntime` and `defineActorHost`, which registers the worker's actor classes under stable stored names and returns the `ActorHost` Durable Object class to export.
