import type { ActorRuntime } from "@mekakucity/actors/runtime";
import { effectSuite } from "./suite.js";

export const actorEffectConformance = (factory: () => ActorRuntime): void => effectSuite(factory);
