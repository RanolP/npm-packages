import "@mekakucity/actors/polyfill";
import { Actor, action, actor, state } from "@mekakucity/actors";
import { createActorRuntime, describeActorTarget, type KatsudouActorRuntime } from "../../src/index.js";

let calls = 0;

@actor("Counter")
class Counter extends Actor<Counter, Record<string, never>> {
  @state accessor count = 0;

  @action async increment(): Promise<number> {
    await Promise.resolve();
    void this.asRef;
    calls += 1;
    this.count += 1;
    return this.count;
  }

  @action async moduleCalls(): Promise<number> {
    return calls;
  }
}

let runtime: KatsudouActorRuntime | undefined;

Object.assign(globalThis, {
  __katsudouDescribe: describeActorTarget,
  __katsudouCreate: (type: string, id: string): void => {
    runtime = createActorRuntime(type, id);
  },
  __katsudouInvoke: (actionName: string, args: unknown[]): Promise<unknown> => {
    if (!runtime) throw new Error("Katsudou actor runtime has not been created");
    return runtime.invoke(actionName, args);
  },
});
