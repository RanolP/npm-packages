import { describe, it, expect } from 'vitest';
import { AsyncIterator } from './index.js';

describe('AsyncIterator', () => {
  describe('from', () => {
    it('should create AsyncIterator from array', async () => {
      const arr = [1, 2, 3];
      const iter = AsyncIterator.from(arr);
      const result = await iter.toArray();
      expect(result).toEqual([1, 2, 3]);
    });

    it('should create AsyncIterator from async generator', async () => {
      async function* gen() {
        yield 1;
        yield 2;
        yield 3;
      }

      const iter = AsyncIterator.from(gen());
      const result = await iter.toArray();
      expect(result).toEqual([1, 2, 3]);
    });
  });

  describe('map', () => {
    it('should transform values', async () => {
      const iter = AsyncIterator.from([1, 2, 3]);
      const mapped = iter.map(x => x * 2);
      const result = await mapped.toArray();
      expect(result).toEqual([2, 4, 6]);
    });

    it('should work with async generators', async () => {
      async function* gen() {
        yield 1;
        yield 2;
        yield 3;
      }

      const iter = AsyncIterator.from(gen());
      const mapped = iter.map(x => x * 2);
      const result = await mapped.toArray();
      expect(result).toEqual([2, 4, 6]);
    });
  });

  describe('filter', () => {
    it('should filter values', async () => {
      const iter = AsyncIterator.from([1, 2, 3, 4, 5]);
      const filtered = iter.filter(x => x % 2 === 0);
      const result = await filtered.toArray();
      expect(result).toEqual([2, 4]);
    });

    it('should work with empty results', async () => {
      const iter = AsyncIterator.from([1, 3, 5]);
      const filtered = iter.filter(x => x % 2 === 0);
      const result = await filtered.toArray();
      expect(result).toEqual([]);
    });
  });

  describe('take', () => {
    it('should take first n elements', async () => {
      const iter = AsyncIterator.from([1, 2, 3, 4, 5]);
      const taken = iter.take(3);
      const result = await taken.toArray();
      expect(result).toEqual([1, 2, 3]);
    });

    it('should handle take more than available', async () => {
      const iter = AsyncIterator.from([1, 2]);
      const taken = iter.take(5);
      const result = await taken.toArray();
      expect(result).toEqual([1, 2]);
    });

    it('should handle take 0', async () => {
      const iter = AsyncIterator.from([1, 2, 3]);
      const taken = iter.take(0);
      const result = await taken.toArray();
      expect(result).toEqual([]);
    });
  });

  describe('drop', () => {
    it('should drop first n elements', async () => {
      const iter = AsyncIterator.from([1, 2, 3, 4, 5]);
      const dropped = iter.drop(2);
      const result = await dropped.toArray();
      expect(result).toEqual([3, 4, 5]);
    });

    it('should handle drop more than available', async () => {
      const iter = AsyncIterator.from([1, 2]);
      const dropped = iter.drop(5);
      const result = await dropped.toArray();
      expect(result).toEqual([]);
    });

    it('should handle drop 0', async () => {
      const iter = AsyncIterator.from([1, 2, 3]);
      const dropped = iter.drop(0);
      const result = await dropped.toArray();
      expect(result).toEqual([1, 2, 3]);
    });
  });

  describe('parallel', () => {
    it('should set parallel limit', async () => {
      const iter = AsyncIterator.from([1, 2, 3, 4, 5]);
      const parallel = iter.parallel(2);
      const result = await parallel.toArray();
      expect(result).toEqual([1, 2, 3, 4, 5]);
    });

    it('should handle parallel limit of 1', async () => {
      const iter = AsyncIterator.from([1, 2, 3]);
      const parallel = iter.parallel(1);
      const result = await parallel.toArray();
      expect(result).toEqual([1, 2, 3]);
    });
  });

  describe('flatMap', () => {
    it('should flatten mapped results', async () => {
      const iter = AsyncIterator.from([1, 2, 3]);
      const flatMapped = iter.flatMap(x => [x, x * 2]);
      const result = await flatMapped.toArray();
      expect(result).toEqual([1, 2, 2, 4, 3, 6]);
    });

    it('should work with async generators', async () => {
      const iter = AsyncIterator.from([1, 2]);
      const flatMapped = iter.flatMap(async function* (x) {
        yield x;
        yield x * 2;
      });
      const result = await flatMapped.toArray();
      expect(result).toEqual([1, 2, 2, 4]);
    });
  });

  describe('find', () => {
    it('should find first matching element', async () => {
      const iter = AsyncIterator.from([1, 2, 3, 4, 5]);
      const found = await iter.find(x => x > 3);
      expect(found).toBe(4);
    });

    it('should return undefined if not found', async () => {
      const iter = AsyncIterator.from([1, 2, 3]);
      const found = await iter.find(x => x > 5);
      expect(found).toBeUndefined();
    });
  });

  describe('forEach', () => {
    it('should execute function for each element', async () => {
      const iter = AsyncIterator.from([1, 2, 3]);
      const results: number[] = [];
      await iter.forEach(x => results.push(x));
      expect(results).toEqual([1, 2, 3]);
    });
  });

  describe('reduce', () => {
    it('should reduce values to single result', async () => {
      const iter = AsyncIterator.from([1, 2, 3, 4]);
      const sum = await iter.reduce((acc, x) => acc + x, 0);
      expect(sum).toBe(10);
    });

    it('should work with different accumulator type', async () => {
      const iter = AsyncIterator.from([1, 2, 3]);
      const result = await iter.reduce((acc, x) => acc + x.toString(), '');
      expect(result).toBe('123');
    });
  });

  describe('some', () => {
    it('should return true if any element matches', async () => {
      const iter = AsyncIterator.from([1, 2, 3, 4]);
      const result = await iter.some(x => x > 3);
      expect(result).toBe(true);
    });

    it('should return false if no element matches', async () => {
      const iter = AsyncIterator.from([1, 2, 3]);
      const result = await iter.some(x => x > 5);
      expect(result).toBe(false);
    });

    it('should return false for empty iterator', async () => {
      const iter = AsyncIterator.from([]);
      const result = await iter.some(x => x > 0);
      expect(result).toBe(false);
    });
  });

  describe('every', () => {
    it('should return true if all elements match', async () => {
      const iter = AsyncIterator.from([2, 4, 6]);
      const result = await iter.every(x => x % 2 === 0);
      expect(result).toBe(true);
    });

    it('should return false if any element does not match', async () => {
      const iter = AsyncIterator.from([2, 3, 4]);
      const result = await iter.every(x => x % 2 === 0);
      expect(result).toBe(false);
    });

    it('should return true for empty iterator', async () => {
      const iter = AsyncIterator.from([]);
      const result = await iter.every(x => x > 0);
      expect(result).toBe(true);
    });
  });

  describe('chaining operations', () => {
    it('should chain multiple operations', async () => {
      const iter = AsyncIterator.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const result = await iter
        .filter(x => x % 2 === 0)
        .map(x => x * 2)
        .take(3)
        .toArray();
      expect(result).toEqual([4, 8, 12]);
    });

    it('should work with complex chaining', async () => {
      const iter = AsyncIterator.from([1, 2, 3, 4, 5]);
      const result = await iter
        .drop(1)
        .map(x => x * 2)
        .filter(x => x > 4)
        .take(2)
        .toArray();
      expect(result).toEqual([6, 8]);
    });
  });

  describe('edge cases', () => {
    it('should handle empty arrays', async () => {
      const iter = AsyncIterator.from([]);
      const result = await iter.toArray();
      expect(result).toEqual([]);
    });

    it('should handle single element', async () => {
      const iter = AsyncIterator.from([42]);
      const result = await iter.toArray();
      expect(result).toEqual([42]);
    });

    it('should handle async generators that yield nothing', async () => {
      async function* gen() {
        // yields nothing
      }

      const iter = AsyncIterator.from(gen());
      const result = await iter.toArray();
      expect(result).toEqual([]);
    });
  });

  describe('performance and concurrency', () => {
    it('should handle large datasets efficiently', async () => {
      const largeArray = Array.from({ length: 1000 }, (_, i) => i);
      const iter = AsyncIterator.from(largeArray);
      const result = await iter
        .filter(x => x % 2 === 0)
        .map(x => x * 2)
        .take(10)
        .toArray();

      expect(result).toHaveLength(10);
      expect(result[0]).toBe(0);
      expect(result[9]).toBe(36);
    });

    it('should work with different parallel limits', async () => {
      const iter = AsyncIterator.from([1, 2, 3, 4, 5]);
      const result1 = await iter.parallel(1).toArray();
      const result2 = await iter.parallel(10).toArray();

      expect(result1).toEqual([1, 2, 3, 4, 5]);
      expect(result2).toEqual([1, 2, 3, 4, 5]);
    });

    it('should demonstrate current sequential behavior of async operations', async () => {
      const timeouts = [100, 200, 300]; // timeouts in milliseconds
      const sumTimeout = timeouts.reduce((a, b) => a + b, 0); // sum = 600ms
      const delta = 200; // 200ms delta for timing tolerance

      const startTime = Date.now();

      // Current AsyncIterator behavior - operations run sequentially
      const iter = AsyncIterator.from(timeouts);
      const result = await iter
        .parallel(10) // High parallel limit doesn't help with async operations in flatMap
        .flatMap(async function* (ms) {
          await new Promise(resolve => setTimeout(resolve, ms));
          yield ms;
        })
        .toArray();

      const endTime = Date.now();
      const actualDuration = endTime - startTime;

      // Verify that all operations completed
      expect(result).toEqual([100, 200, 300]);

      // Current behavior: execution time is approximately sum of timeouts (sequential)
      expect(actualDuration).toBeGreaterThan(sumTimeout - 100);
      expect(actualDuration).toBeLessThan(sumTimeout + delta);
    }, 2000);

    it('should run setTimeout operations in parallel within max timeout + delta (Promise.all baseline)', async () => {
      const timeouts = [100, 200, 300, 400, 500]; // timeouts in milliseconds
      const maxTimeout = Math.max(...timeouts); // max timeout in ms
      const delta = 200; // 200ms delta for timing tolerance

      const startTime = Date.now();

      // Test using Promise.all to demonstrate expected parallel behavior
      const promises = timeouts.map(ms =>
        new Promise<number>(resolve =>
          setTimeout(() => resolve(ms), ms)
        )
      );
      const result = await Promise.all(promises);

      const endTime = Date.now();
      const actualDuration = endTime - startTime;

      // Verify that all operations completed
      expect(result.sort()).toEqual([100, 200, 300, 400, 500]);

      // Verify that execution time is approximately max timeout, not sum of timeouts
      // Sum would be 1500ms, but with parallelism it should be ~500ms
      expect(actualDuration).toBeLessThan(maxTimeout + delta);
      expect(actualDuration).toBeGreaterThan(maxTimeout - delta);
    }, 2000);
  });

  describe('async callbacks', () => {
    it('map should support async transform', async () => {
      const iter = AsyncIterator.from([1, 2, 3]);
      const mapped = iter.map(async x => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return x * 2;
      });
      const result = await mapped.toArray();
      expect(result).toEqual([2, 4, 6]);
    });

    it('filter should support async predicate', async () => {
      const iter = AsyncIterator.from([1, 2, 3, 4]);
      const filtered = iter.filter(async x => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return x % 2 === 0;
      });
      const result = await filtered.toArray();
      expect(result).toEqual([2, 4]);
    });

    it('find should support async predicate', async () => {
      const iter = AsyncIterator.from([1, 2, 3, 4]);
      const found = await iter.find(async x => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return x > 2;
      });
      expect(found).toBe(3);
    });

    it('some should support async predicate', async () => {
      const iter = AsyncIterator.from([1, 2, 3]);
      const result = await iter.some(async x => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return x === 3;
      });
      expect(result).toBe(true);
    });

    it('flatMap should support async results', async () => {
      const iter = AsyncIterator.from([1, 2]);
      const flatMapped = iter.flatMap(x => [
        Promise.resolve(x),
        Promise.resolve(x * 2)
      ]);
      const result = await flatMapped.toArray();
      expect(result).toEqual([1, 2, 2, 4]);
    });
  });
}); 
