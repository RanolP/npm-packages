declare namespace Cloudflare {
  interface Env {
    ACTOR_HOST: DurableObjectNamespace<import("../src/host.js").ActorHost>;
  }
}
