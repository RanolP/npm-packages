declare namespace Cloudflare {
  interface Env {
    ACTOR_HOST: DurableObjectNamespace<import("../src/index.js").ActorHost>;
  }
}
