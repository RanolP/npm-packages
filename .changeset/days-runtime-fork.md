---
"@mekakucity/days": minor
---

Add `InMemoryActorRuntime#fork()`, so a test harness can boot once and give each test a fresh child runtime without re-running boot. A fork copies an actor only when it first touches it, like a Durable Object cold load. The first fork freezes the parent and hands its pending detached deliveries to every fork. `InMemoryActorRuntime` is now `Disposable` and `AsyncDisposable`: disposing stops its delivery timers, drops deliveries that have not started, and makes later `run` calls throw; `await runtime[Symbol.asyncDispose]()` also waits for a delivery already running.
