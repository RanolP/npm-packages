import { reentrancySuite } from "./reentrancy.js";
import { refLifecycleSuite } from "./ref-lifecycle.js";
import { runtimeScopeSuite } from "./runtime-scope.js";
import { selfReferenceSuite } from "./self-reference.js";
import { stateAndGenericsSuite } from "./state-and-generics.js";
import { transactionSuite } from "./transactions.js";
import type { ActorRuntimeConformanceHooks } from "./runtime.js";
import type { ActorRuntime } from "@mekakucity/actors/runtime";

export const actorRuntimeConformance = (
  factory: () => ActorRuntime,
  hooks?: ActorRuntimeConformanceHooks,
): void => {
  transactionSuite(factory, hooks);
  reentrancySuite(factory, hooks);
  selfReferenceSuite(factory, hooks);
  refLifecycleSuite(factory, hooks);
  stateAndGenericsSuite(factory, hooks);
  runtimeScopeSuite(factory, hooks);
};

export type { ActorRuntimeConformanceHooks } from "./runtime.js";
