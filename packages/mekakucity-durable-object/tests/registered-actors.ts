import { Actor, action, actor, state } from "@mekakucity/actors";

/** Registered under the id "Tally", deliberately not its class name; tests/worker.ts imports this module. */
@actor("Tally")
export class TallyActor extends Actor<TallyActor, { count: number }> {
  @state accessor count = this.input.count;

  @action async add(): Promise<number> {
    this.count += 1;
    return this.count;
  }
}
