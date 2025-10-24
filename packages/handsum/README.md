<div align="center">
    <h1>handsum</h1>
    <p>👏 = ✋ ➕ ✋ /* Create sum types with <code>ergonomics</code> equipped */</p>
</div>

## Quick Tour on `handsum`

handsum provides a sophisticated way to define sum types in TypeScript with natural ergonomics that integrate seamlessly with the language.

**Core Features**:

- **Type-safe `if` checks**: Destructure variants by checking truthiness
- **Classical `match`**: Clean, expressive enough pattern matching
- **Associated functions**: Attach methods directly to your sum types

### Creating a Maybe Type

Let's start by defining a classic `Maybe<T> = just(T) | nothing` type.

```ts
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
```

Now you can use it:

```ts
Maybe.just(42).match({
  just(value) {
    console.log(`The answer is ${value}`);
  },
  nothing() {
    console.log('nothing');
  },
});
```

Simple and type-safe!

<details>
<summary><h3>Advanced Topic: <code>impl</code>.</h3></summary>

You can associate utility functions like `Maybe<T>.map :: ((T) -> U) -> Maybe<U>` directly with your type.

```ts
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
    // You may write type twice if type's too complex.
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
```

Now you can use methods naturally:

```ts
Maybe.just(42)
  .map((x) => x * 2)
  .map((x) => x / 2)
```
</details>

### Flow-sensitive Matching

For the demonstration, let's say we have following type.

```ts
import { handsum, type Handsum } from 'handsum';

type NumbersStr = '00' | '01' | '10' | '11';

type TNumbers = Record<NumbersStr, (val: number) => NumbersStr>;
type Numbers = Handsum<TNumbers>;
const Numbers = handsum<TNumbers>({});
```

#### Using `if` statements

To quickly extract values from specific variants like `00` or `11`:

```ts
function process(n: Numbers) {
  if (n['00']) return n['00'][0];
  if (n['11']) return n['11'][0];
```

#### Using `match(...)`

Since `00` and `11` are already handled, we can match the remaining cases:

```ts
  return n.match({
    '01': (x) => x * 2,
    '10': (x) => x * 3,
  });
}
```

#### The special `_` wildcard case

Use `_` to handle all remaining variants in one place:

```ts
function only0011(n: Numbers) {
  return n.match({
    '00': () => '00',
    '11': () => '11',
    _: () => 'others',
  });
}
```

<details>

<summary><h3>Advanced Topic: Subsetting Variants</h3></summary>

You can enhance flow sensitivity in subroutines by subsetting variants using `HandsumSubset`.

```ts
function only0011Simpler(n: Numbers) {
  if (n['00'] || n['11']) return simpler(n);
  return 'others';
}

function simpler(n: HandsumSubset<Numbers, '00' | '11'>) {
  return n.match({
    '00': () => '00',
    '11': () => '11',
  });
}
```

This is an advanced feature that you'll rarely need in typical usage.

</details>
