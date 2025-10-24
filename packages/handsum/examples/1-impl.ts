import { handsum, type Handsum } from 'handsum';

// 1. Define type constructors of Maybe<T>, same as above
interface TMaybe<T extends {}> {
  just(value: T): Maybe<T>;
  nothing(): Maybe<T>;
}
// 1.1. Define the Impl type
interface IMaybe<T extends {}> {
  map<U extends {}>(this: Maybe<T>, f: (value: T) => U): Maybe<U>;
}
// 2. Define Handsum with impl type augmented
type Maybe<T extends {}> = Handsum<TMaybe<T>, IMaybe<T>>;
// 3. Define the constructor with impls
const MaybeCtor = <T extends {}>() =>
  handsum<TMaybe<T>, IMaybe<T>>({
    map<U extends {}>(this: Maybe<T>, f: (value: T) => U): Maybe<U> {
      return this.match({
        just: (value) => MaybeCtor<U>().just(f(value)),
        nothing: () => MaybeCtor<U>().nothing(),
      });
    },
  });

// 4. (optional) wrap your sum type for ergonomics
//               If it isn't generic, the step is truly optional.
const Maybe = {
  just: <T extends {}>(value: T) => MaybeCtor<T>().just(value),
  nothing: <T extends {}>() => MaybeCtor<T>().nothing(),
};

// ============= usage =============
Maybe.just(42)
  .map((x) => x * 2)
  .map((x) => x / 2);
