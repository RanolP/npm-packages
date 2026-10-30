// The worker entry imports every actor module, so a Durable Object woken in a fresh isolate finds its class.
import "./registered-actors.js";

import type { ActorContextProvider } from "@mekakucity/actors";
import { createActorHost } from "../src/index.js";

const contextProvider: ActorContextProvider = {
  carry: () => undefined,
  build: (carried, hooks, _self, origin) => ({
    requestId: typeof carried === "object" && carried !== null && "requestId" in carried
      && typeof carried.requestId === "string"
      ? carried.requestId
      : undefined,
    origin,
    registerConformanceHooks() {
      hooks.onRollback(() => { throw new Error("rollback hook ran"); });
      hooks.afterCommit(() => { throw new Error("afterCommit hook ran"); });
    },
    reportCommitInfo() {
      hooks.afterCommit.bestEffort((info) => {
        throw new Error(`commit-info:${JSON.stringify(info)}`);
      });
    },
  }),
};

export const ActorHost = createActorHost({
  contextProvider,
  socket: {
    accept: (request) => {
      const requestId = request.headers.get("x-request-id") ?? undefined;
      return { attachment: { requestId }, scope: requestId ?? "anonymous" };
    },
    carried: (attachment) => attachment,
  },
});

export default {
  fetch(): Response {
    return new Response("ok");
  },
};
