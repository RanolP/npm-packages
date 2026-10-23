import { expectTypeOf, test } from "vitest";
import { Actor, action, state } from "../src/index.js";
import type { ActorRef } from "../src/index.js";

class TypeFixture extends Actor<TypeFixture, { input: string }> {}
class MutualActorA extends Actor<MutualActorA, { peer: ActorRef<MutualActorB> }> {
  @state accessor peer = this.input.peer;
  @action async callPeer(peer: ActorRef<MutualActorB>): Promise<ActorRef<MutualActorB>> { return peer; }
}
class MutualActorB extends Actor<MutualActorB, { peer: ActorRef<MutualActorA> }> {
  @state accessor peer = this.input.peer;
  @action async callPeer(peer: ActorRef<MutualActorA>): Promise<ActorRef<MutualActorA>> { return peer; }
}

test("mutually recursive actor refs preserve their field and action types", () => {
  const mutualARef = null as unknown as ActorRef<MutualActorA>;
  const mutualBRef = null as unknown as ActorRef<MutualActorB>;
  const ref = null as unknown as ActorRef<TypeFixture>;
  expectTypeOf(mutualARef.peer).toEqualTypeOf<ActorRef<MutualActorB>>();
  expectTypeOf(mutualBRef.peer).toEqualTypeOf<ActorRef<MutualActorA>>();
  expectTypeOf(mutualARef.callPeer(mutualBRef)).toEqualTypeOf<Promise<ActorRef<MutualActorB>>>();
  expectTypeOf(mutualBRef.callPeer(mutualARef)).toEqualTypeOf<Promise<ActorRef<MutualActorA>>>();
  // @ts-expect-error MutualActorA.callPeer requires a MutualActorB reference.
  mutualARef.callPeer(ref);
});
