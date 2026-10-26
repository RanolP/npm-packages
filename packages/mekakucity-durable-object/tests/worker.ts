import { defineActorHost } from "../src/index.js";
import { TallyActor } from "./registered-actors.js";

export const ActorHost = defineActorHost({ Tally: TallyActor });

export default {
  fetch(): Response {
    return new Response("ok");
  },
};
