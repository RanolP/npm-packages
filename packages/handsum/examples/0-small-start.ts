import { handsum, type Handsum } from 'handsum';

// 1. Define type constructors of Maybe<T>
interface TMaybe<T extends {}> {
  just(value: T): Maybe<T>;
  nothing(): Maybe<T>;
}
// 2. Define the actual type
type Maybe<T extends {}> = Handsum<TMaybe<T>>;
// 3. Define the constructor
const MaybeCtor = <T extends {}>() => handsum<TMaybe<T>>({});

// 4. (optional) wrap your sum type for ergonomics
//               If it isn't generic, the step is truly optional.
const Maybe = {
  just: <T extends {}>(value: T) => MaybeCtor<T>().just(value),
  nothing: <T extends {}>() => MaybeCtor<T>().nothing(),
};

// ============= usage =============
Maybe.just(42).match({
  just(value) {
    console.log(`The answer is ${value}`);
  },
  nothing() {
    console.log('nothing');
  },
});
