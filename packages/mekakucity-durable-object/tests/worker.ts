// The worker entry imports every actor module, so a Durable Object woken in a fresh isolate finds its class.
import "./registered-actors.js";

export { ActorHost } from "../src/index.js";

export default {
  fetch(): Response {
    return new Response("ok");
  },
};
