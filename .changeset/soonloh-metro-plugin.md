---
'soonloh': minor
---

Add a Metro integration (`soonloh/metro`). `withSoonloh(metroConfig, options)` wraps a Metro config to run codegen before the first bundle and watch the router root in dev. Also fixes inline `config` objects being silently ignored (router root was never resolved).
