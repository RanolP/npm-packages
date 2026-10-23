import type { ActorRuntime } from "../../runtime/actor-runtime.js";
import { effectSuite } from "./suite.js";

export const actorEffectConformance = (factory: () => ActorRuntime): void => effectSuite(factory);
