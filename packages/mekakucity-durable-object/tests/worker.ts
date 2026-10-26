export { ActorHost } from "../src/host.js";

export default {
  fetch(): Response {
    return new Response("ok");
  },
};
