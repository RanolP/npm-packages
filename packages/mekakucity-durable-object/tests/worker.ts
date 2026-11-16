// The worker entry imports every actor module, so a Durable Object woken in a fresh isolate finds its class.
import "./registered-actors.js";

import type { ActorCommitInfo, ActorContextProvider } from "@mekakucity/actors";
import { createActorHost } from "../src/index.js";

const contextProvider: ActorContextProvider = {
  carry: () => undefined,
  build: (carried, hooks, _self, origin) => {
    const afterCommits: ActorCommitInfo[] = [];
    return {
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
      recordAfterCommit() {
        hooks.afterCommit.bestEffort((info) => {
          afterCommits.push(info);
          if (afterCommits.length > 1) throw new Error("after-commit hook ran twice");
        });
      },
      recordedAfterCommits: () => [...afterCommits],
    };
  },
};

export const ActorHost = createActorHost({ contextProvider });

export default {
  fetch(): Response {
    return new Response("ok");
  },
};
