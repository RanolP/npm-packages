import { Actor, ActorContextUnavailableError } from "../src/index.js";
import {
  ActorInvocationContext,
  type ActorContextProvider,
  type ActorTransactionHooks,
} from "../src/runtime/index.js";
import { expect, test } from "vitest";

class ContextReader extends Actor<ContextReader, {}> {
  readContext() {
    return this.ctx;
  }
}

const openInvocation = (id: string): { invocation: ActorInvocationContext; hooks: ActorTransactionHooks } => {
  let builtHooks: ActorTransactionHooks | undefined;
  const provider: ActorContextProvider<undefined> = {
    carry: () => undefined,
    build: (_carried, hooks) => {
      builtHooks = hooks;
      return {};
    },
  };
  const invocation = new ActorInvocationContext(undefined, provider, { type: "Test", id });
  invocation.get();
  if (builtHooks === undefined) throw new Error("Actor context provider did not build");
  return { invocation, hooks: builtHooks };
};

test("Actor.ctx rejects reads outside an active action", () => {
  const actor = new ContextReader({});
  expect(() => actor.readContext()).toThrow(ActorContextUnavailableError);
});

test("nested hooks run in registration order when parent and child overlap", async () => {
  const calls: string[] = [];
  const { promise: childCanResume, resolve: resumeChild } = Promise.withResolvers<void>();
  const { promise: childDidRegister, resolve: childRegistered } = Promise.withResolvers<void>();
  const { invocation: parent, hooks: parentHooks } = openInvocation("parent");
  const { invocation: child, hooks: childHooks } = openInvocation("child");

  const childWork = (async () => {
    childHooks.afterCommit(() => {
      calls.push("H1");
    });
    childRegistered();
    await childCanResume;
    child.mergeHooksInto(parent);
  })();

  await childDidRegister;
  parentHooks.afterCommit(() => {
    calls.push("H2");
  });
  resumeChild();
  await childWork;
  await parent.afterCommit(1, []);

  expect(calls).toEqual(["H1", "H2"]);
});

test("nested rollback hooks run in reverse registration order when parent and child overlap", async () => {
  const calls: string[] = [];
  const { promise: childCanResume, resolve: resumeChild } = Promise.withResolvers<void>();
  const { promise: childDidRegister, resolve: childRegistered } = Promise.withResolvers<void>();
  const { invocation: parent, hooks: parentHooks } = openInvocation("parent");
  const { invocation: child, hooks: childHooks } = openInvocation("child");

  const childWork = (async () => {
    childHooks.onRollback(() => {
      calls.push("C1");
    });
    childRegistered();
    await childCanResume;
    child.mergeHooksInto(parent);
  })();

  await childDidRegister;
  parentHooks.onRollback(() => {
    calls.push("P2");
  });
  resumeChild();
  await childWork;
  await parent.afterRollback(new Error("x"));

  expect(calls).toEqual(["P2", "C1"]);
});

// Regression: a segment hook that failed was dropped, and a later final commit could run the same hook twice.
test("segment after-commit hooks run once in registration order and their failures reject the final afterCommit", async () => {
  const calls: string[] = [];
  const { invocation: top, hooks: topHooks } = openInvocation("actor");
  const { invocation: nested, hooks: nestedHooks } = openInvocation("actor");
  topHooks.afterCommit(() => {
    calls.push("H1");
  });
  nestedHooks.afterCommit.bestEffort(() => {
    calls.push("H2");
    throw new Error("segment hook failed");
  });

  await ActorInvocationContext.afterSegmentCommit([nested, top], 1, ["value"]);
  expect(calls).toEqual(["H1", "H2"]);

  nested.mergeHooksInto(top);
  await expect(top.afterCommit(1, ["value"])).rejects.toThrow("afterCommit hook failure: segment hook failed");
  expect(calls).toEqual(["H1", "H2"]);
});
