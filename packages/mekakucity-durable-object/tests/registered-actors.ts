import { Actor, action, state } from "@mekakucity/actors";

/** Registered by tests/worker.ts under the key "Tally", deliberately not its class name. */
export class TallyActor extends Actor<TallyActor, { count: number }> {
  @state accessor count = this.input.count;

  @action async add(): Promise<number> {
    this.count += 1;
    return this.count;
  }
}
