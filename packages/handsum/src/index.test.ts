import { describe, it, expect } from 'vitest';
import { handsum, HandsumSubset, type Handsum } from './index.js';

// Test ADT implementation based on Maybe example
interface TMaybe<T extends {}> {
  just(value: T): Maybe<T>;
  nothing(): Maybe<T>;
}

interface IMaybe<T extends {}> {
  map<U extends {}>(this: Maybe<T>, f: (value: T) => U): Maybe<U>;
  toString(this: Maybe<T>): string;
  isJust(this: Maybe<T>): this is HandsumSubset<Maybe<T>, 'just'>;
  isNothing(this: Maybe<T>): this is HandsumSubset<Maybe<T>, 'nothing'>;
}

type Maybe<T extends {}> = Handsum<TMaybe<T>, IMaybe<T>>;

const MaybeCtor = <T extends {}>(): TMaybe<T> =>
  handsum<TMaybe<T>, IMaybe<T>>({
    map<U extends {}>(this: Maybe<T>, f: (value: T) => U): Maybe<U> {
      return this.match({
        just: (value) => MaybeCtor<U>().just(f(value)),
        nothing: () => MaybeCtor<U>().nothing(),
      });
    },
    toString() {
      return this.match({
        just: (value) => `Maybe.just(${value})`,
        nothing: () => 'Maybe.nothing()',
      });
    },
    isJust(): this is HandsumSubset<Maybe<T>, 'just'> {
      return this.match({
        just: () => true,
        nothing: () => false,
      });
    },
    isNothing(): this is HandsumSubset<Maybe<T>, 'nothing'> {
      return this.match({
        just: () => false,
        nothing: () => true,
      });
    },
  });

export const Maybe = {
  just: <T extends {}>(value: T) => MaybeCtor<T>().just(value),
  nothing: <T extends {}>() => MaybeCtor<T>().nothing(),
  fromNullable: <T extends {}>(value: T | null | undefined) => {
    if (value == null) return MaybeCtor<T>().nothing();
    return MaybeCtor<T>().just(value);
  },
};

describe('adt', () => {
  describe('basic functionality', () => {
    it('should create ADT with constructors', () => {
      const maybe = Maybe.just(42);
      expect(maybe).toBeDefined();
      expect(typeof maybe.match).toBe('function');
    });

    it('should handle different constructors', () => {
      const just = Maybe.just('hello');
      const nothing = Maybe.nothing();

      expect(just).toBeDefined();
      expect(nothing).toBeDefined();
    });
  });

  describe('match method', () => {
    it('should match on just constructor', () => {
      const maybe = Maybe.just(42);
      const result = maybe.match({
        just: (value) => value * 2,
        nothing: () => 0,
      });
      expect(result).toBe(84);
    });

    it('should match on nothing constructor', () => {
      const maybe = Maybe.nothing<number>();
      const result = maybe.match({
        just: (value) => value * 2,
        nothing: () => 0,
      });
      expect(result).toBe(0);
    });

    it('should support default branch with _', () => {
      const maybe = Maybe.just(42);
      const result = maybe.match({
        just: (value) => value * 2,
        _: () => 0,
      });
      expect(result).toBe(84);
    });

    it('should use default branch when no specific match', () => {
      const maybe = Maybe.nothing<number>();
      const result = maybe.match({
        just: (value) => value * 2,
        _: () => -1,
      });
      expect(result).toBe(-1);
    });
  });

  describe('instance methods', () => {
    it('should implement map method', () => {
      const maybe = Maybe.just(42);
      const doubled = maybe.map((x) => x * 2);

      const result = doubled.match({
        just: (value) => value,
        nothing: () => 0,
      });
      expect(result).toBe(84);
    });

    it('should map nothing to nothing', () => {
      const maybe = Maybe.nothing<number>();
      const doubled = maybe.map((x) => x * 2);

      const result = doubled.match({
        just: (value) => value,
        nothing: () => 0,
      });
      expect(result).toBe(0);
    });

    it('should implement toString method', () => {
      const just = Maybe.just(42);
      const nothing = Maybe.nothing<number>();

      expect(just.toString()).toBe('Maybe.just(42)');
      expect(nothing.toString()).toBe('Maybe.nothing()');
    });

    it('should implement isJust method', () => {
      const just = Maybe.just(42);
      const nothing = Maybe.nothing<number>();

      expect(just.isJust()).toBe(true);
      just.just;
      expect(nothing.isJust()).toBe(false);
    });

    it('should implement isNothing method', () => {
      const just = Maybe.just(42);
      const nothing = Maybe.nothing<number>();

      expect(just.isNothing()).toBe(false);
      expect(nothing.isNothing()).toBe(true);
    });
  });

  describe('static methods', () => {
    it('should implement fromNullable for non-null values', () => {
      const maybe = Maybe.fromNullable(42);
      const result = maybe.match({
        just: (value) => value,
        nothing: () => 0,
      });
      expect(result).toBe(42);
    });

    it('should implement fromNullable for null values', () => {
      const maybe = Maybe.fromNullable<number>(null);
      const result = maybe.match({
        just: (value) => value,
        nothing: () => 0,
      });
      expect(result).toBe(0);
    });

    it('should implement fromNullable for undefined values', () => {
      const maybe = Maybe.fromNullable<number>(undefined);
      const result = maybe.match({
        just: (value) => value,
        nothing: () => 0,
      });
      expect(result).toBe(0);
    });
  });

  describe('complex operations', () => {
    it('should chain map operations', () => {
      const maybe = Maybe.just(5)
        .map((x) => x * 2)
        .map((x) => x + 1)
        .map((x) => x.toString());

      const result = maybe.match({
        just: (value) => value,
        nothing: () => 'nothing',
      });
      expect(result).toBe('11');
    });

    it('should handle chaining with nothing', () => {
      const maybe = Maybe.nothing<number>()
        .map((x) => x * 2)
        .map((x) => x + 1);

      const result = maybe.match({
        just: (value) => value,
        nothing: () => 0,
      });
      expect(result).toBe(0);
    });

    it('should work with complex types', () => {
      interface User {
        id: number;
        name: string;
      }

      const user: User = { id: 1, name: 'Alice' };
      const maybeUser = Maybe.just(user);

      const userName = maybeUser
        .map((u) => u.name)
        .map((name) => name.toUpperCase());

      const result = userName.match({
        just: (name) => name,
        nothing: () => 'UNKNOWN',
      });
      expect(result).toBe('ALICE');
    });
  });

  describe('type safety', () => {
    it('should maintain type information through operations', () => {
      const maybe = Maybe.just(42);

      // TypeScript should infer the correct types
      const stringMaybe = maybe.map((x) => x.toString());

      const result = stringMaybe.match({
        just: (value) => value.length, // value should be string
        nothing: () => 0,
      });

      expect(result).toBe(2); // "42".length
    });

    it('should handle generic types correctly', () => {
      const maybe = Maybe.just([1, 2, 3]);
      const length = maybe.map((arr) => arr.length);

      const result = length.match({
        just: (len) => len,
        nothing: () => 0,
      });

      expect(result).toBe(3);
    });
  });
});

describe('adt edge cases', () => {
  it('should handle empty objects', () => {
    interface Empty {}
    const emptyMaybe = Maybe.just<Empty>({});

    const result = emptyMaybe.match({
      just: (value) => 'has value',
      nothing: () => 'nothing',
    });

    expect(result).toBe('has value');
  });

  it('should handle zero values', () => {
    const zeroMaybe = Maybe.just(0);

    const result = zeroMaybe.match({
      just: (value) => value,
      nothing: () => -1,
    });

    expect(result).toBe(0);
  });

  it('should handle false boolean values', () => {
    const falseMaybe = Maybe.just(false);

    const result = falseMaybe.match({
      just: (value) => value === false,
      nothing: () => false,
    });

    expect(result).toBe(true);
  });

  it('should handle empty strings', () => {
    const emptyStringMaybe = Maybe.just('');

    const result = emptyStringMaybe.match({
      just: (value) => value.length,
      nothing: () => -1,
    });

    expect(result).toBe(0);
  });
});
