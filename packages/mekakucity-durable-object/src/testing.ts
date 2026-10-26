import { allowOnDemandTypes } from "./registry.js";

/**
 * Test-only, reached by path and absent from the package entry. Runtimes in `scope`, and the hosts they reach,
 * accept actor classes a test defines after the worker module loaded: each is registered for that scope alone,
 * under its class name, on first spawn. A deployed worker registers every class through defineActorHost.
 */
export const allowUnregisteredTypes = (scope: string): void => allowOnDemandTypes(scope);
