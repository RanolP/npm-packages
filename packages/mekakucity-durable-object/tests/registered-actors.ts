import { Actor, action, actor, clientAction, state } from "@mekakucity/actors";

declare module "@mekakucity/actors" {
  interface ActorContext {
    readonly requestId?: string;
  }
}

/** Registered under the id "Tally", deliberately not its class name; tests/worker.ts imports this module. */
@actor("Tally")
export class TallyActor extends Actor<TallyActor, { count: number }> {
  declare events: { counted: { count: number } };

  @state accessor count = this.input.count;

  get doubled(): number {
    return this.count * 2;
  }

  get explodesAfterChange(): number {
    if (this.count > 0) throw new Error("getter exploded");
    return this.count;
  }

  @action async serverOnlyAdd(): Promise<number> {
    this.count += 1;
    return this.count;
  }

  @clientAction async add(): Promise<number> {
    this.count += 1;
    return this.count;
  }

  @clientAction async unchanged(): Promise<number> {
    return this.count;
  }

  @clientAction async bigintAfterAdd(): Promise<bigint> {
    this.count += 1;
    return BigInt(this.count);
  }

  @clientAction async contextRequestId(): Promise<string | undefined> {
    return this.ctx.requestId;
  }

  @clientAction async announce(): Promise<void> {
    this.emit("counted", { count: this.count });
  }

  @clientAction async announceThenThrow(): Promise<never> {
    this.emit("counted", { count: this.count });
    throw new Error("announcement failed");
  }
}
