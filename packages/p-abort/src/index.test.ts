import { describe, it, expect, vi } from 'vitest';
import { abortable, AbortedError } from './index.js';

describe('abortable', () => {
  it('should complete successfully', async () => {
    const operation = abortable(($) => async (value: number) => {
      const doubled = await $(value * 2);
      return doubled + 1;
    });

    const result = await operation(5);
    expect(result).toEqual({ ok: true, data: 11 });
  });

  it('should provide abort method', () => {
    const operation = abortable(($) => async () => {
      return 'test';
    });

    const promise = operation();
    expect(typeof promise.abort).toBe('function');
  });

  it('should abort operation', async () => {
    const operation = abortable(($) => async () => {
      await $(new Promise((resolve) => setTimeout(resolve, 100)));
      return 'completed';
    });

    const promise = operation();
    promise.abort();

    const result = await promise;
    expect(result).toEqual({ ok: false });
  });

  it('should throw AbortedError when aborted during wrapped promise', async () => {
    const operation = abortable(($) => async () => {
      await $(new Promise((resolve) => setTimeout(resolve, 100)));
      return 'should not reach here';
    });

    const promise = operation();

    // Start the operation and immediately abort
    setTimeout(() => promise.abort(), 10);

    const result = await promise;
    expect(result).toEqual({ ok: false });
  });

  it('should throw AbortedError when aborted during wrapped function', async () => {
    const operation = abortable(($) => async () => {
      const wrappedFn = $(async (value: number) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return value * 2;
      });

      return await wrappedFn(5);
    });

    const promise = operation();
    setTimeout(() => promise.abort(), 10);

    const result = await promise;
    expect(result).toEqual({ ok: false });
  });

  it('should propagate non-abort errors', async () => {
    const operation = abortable(($) => async () => {
      throw new Error('Something went wrong');
    });

    const promise = operation();
    await expect(promise).rejects.toThrow('Something went wrong');
  });

  it('should execute cleanup functions on successful completion', async () => {
    const cleanupSpy = vi.fn();

    const operation = abortable(($) => async () => {
      $.cleanup(cleanupSpy);
      return 'success';
    });

    const result = await operation();
    expect(result).toEqual({ ok: true, data: 'success' });
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('should execute cleanup functions on abortion', async () => {
    const cleanupSpy = vi.fn();

    const operation = abortable(($) => async () => {
      $.cleanup(cleanupSpy);
      await $(new Promise((resolve) => setTimeout(resolve, 100)));
      return 'should not reach here';
    });

    const promise = operation();
    promise.abort();

    const result = await promise;
    expect(result).toEqual({ ok: false });
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('should execute cleanup functions in reverse order (LIFO)', async () => {
    const cleanupOrder: number[] = [];

    const operation = abortable(($) => async () => {
      $.cleanup(() => cleanupOrder.push(1));
      $.cleanup(() => cleanupOrder.push(2));
      $.cleanup(() => cleanupOrder.push(3));
      return 'success';
    });

    await operation();
    expect(cleanupOrder).toEqual([3, 2, 1]);
  });

  it('should execute cleanup functions immediately if already aborted', async () => {
    const cleanupSpy = vi.fn();

    const operation = abortable(($) => async () => {
      // This won't be called since we're aborting immediately
      return 'should not reach here';
    });

    const promise = operation();
    promise.abort();

    // Register cleanup after abort
    const operation2 = abortable(($) => async () => {
      $.cleanup(cleanupSpy);
      return 'should not reach here';
    });

    const promise2 = operation2();
    promise2.abort();

    await promise2;
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('should ignore errors in cleanup functions', async () => {
    const cleanupSpy = vi.fn();

    const operation = abortable(($) => async () => {
      $.cleanup(() => {
        throw new Error('Cleanup failed');
      });
      $.cleanup(cleanupSpy);
      return 'success';
    });

    const result = await operation();
    expect(result).toEqual({ ok: true, data: 'success' });
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('should handle multiple parameters', async () => {
    const operation = abortable(($) => async (a: number, b: string) => {
      const num = await $(a * 2);
      return `${b}-${num}`;
    });

    const result = await operation(5, 'test');
    expect(result).toEqual({ ok: true, data: 'test-10' });
  });

  it('should handle complex async operations', async () => {
    const operation = abortable(($) => async (items: string[]) => {
      const results: string[] = [];

      for (const item of items) {
        const processed = await $(item.toUpperCase());
        results.push(processed);
      }

      return results;
    });

    const result = await operation(['a', 'b', 'c']);
    expect(result).toEqual({ ok: true, data: ['A', 'B', 'C'] });
  });

  it('should handle wrapped functions correctly', async () => {
    const operation = abortable(($) => async (items: number[]) => {
      const double = $(async (n: number) => n * 2);
      const results: number[] = [];

      for (const item of items) {
        const doubled = await double(item);
        results.push(doubled);
      }

      return results;
    });

    const result = await operation([1, 2, 3]);
    expect(result).toEqual({ ok: true, data: [2, 4, 6] });
  });

  it('should maintain backward compatibility with defer', async () => {
    const cleanupSpy = vi.fn();

    const operation = abortable(($) => async () => {
      $.defer(cleanupSpy); // Using deprecated defer method
      return 'success';
    });

    const result = await operation();
    expect(result).toEqual({ ok: true, data: 'success' });
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });
});

describe('AbortedError', () => {
  it('should have correct name', () => {
    const error = new AbortedError();
    expect(error.name).toBe('AbortedError');
  });

  it('should be instance of Error', () => {
    const error = new AbortedError();
    expect(error).toBeInstanceOf(Error);
  });
});
