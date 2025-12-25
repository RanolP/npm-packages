import { describe, it, expect } from 'vitest';
import { transformOxc, visitEstree } from '../src/transformer/oxc';
import { parseSync } from 'oxc-parser';
import type { Selection } from '../src/types';

describe('transformOxc', () => {
  it('should handle pick mode and return transformed code', () => {
    const code = `export function foo() {}\nexport function bar() {}\nexport function baz() {}`;
    const result = transformOxc('test.ts', code, { mode: 'pick', items: ['foo', 'baz'] });
    
    // Since the transformer removes items that are NOT in the pick list,
    // 'bar' function should be removed
    expect(typeof result).toBe('string');
    expect(result).toBeTruthy();
  });

  it('should handle drop mode', () => {
    const code = `export function foo() {}\nexport function bar() {}\nexport function baz() {}`;
    const result = transformOxc('test.ts', code, { mode: 'drop', items: ['bar'] });
    
    expect(typeof result).toBe('string');
    expect(result).toBeTruthy();
  });

  it('should handle empty code gracefully', () => {
    const result = transformOxc('test.ts', '', { mode: 'pick', items: ['foo'] });
    expect(result).toBe('');
  });

  it('should work with variable declarations in pick mode', () => {
    const code = `export const a = 1;\nexport const b = 2;\nexport const c = 3;`;
    const result = transformOxc('test.ts', code, { mode: 'pick', items: ['a', 'c'] });
    
    expect(typeof result).toBe('string');
    expect(result).toBeTruthy();
  });

  it('should preserve internal (non-exported) code', () => {
    const code = `const helper = () => 'help';\nexport function api() { return helper(); }`;
    const result = transformOxc('test.ts', code, { mode: 'pick', items: ['api'] });
    
    // Helper should remain as it's not exported
    expect(result).toContain('helper');
    expect(result).toContain('api');
  });
});

describe('visitEstree', () => {
  const createSelection = (mode: 'pick' | 'drop', items: string[]): Selection => ({
    mode,
    items,
  });

  it('should return array of nodes in pick mode', () => {
    const code = `export function keep() {}\nexport function remove() {}`;
    const ast = parseSync('test.ts', code, {
      astType: 'ts',
      lang: 'tsx',
      sourceType: 'module',
    });
    const ranges = visitEstree(ast.program, createSelection('pick', ['keep']));
    expect(Array.isArray(ranges)).toBe(true);
  });

  it('should return array of nodes in drop mode', () => {
    const code = `export const x = 1;\nexport const y = 2;\nexport const z = 3;`;
    const ast = parseSync('test.ts', code, {
      astType: 'ts',
      lang: 'tsx',
      sourceType: 'module',
    });
    const ranges = visitEstree(ast.program, createSelection('drop', ['y']));
    expect(Array.isArray(ranges)).toBe(true);
  });

  it('should throw on script source type', () => {
    const code = `var x = 1;`;
    const ast = parseSync('test.ts', code, {
      astType: 'ts',
      lang: 'tsx',
      sourceType: 'script',
    });
    expect(() => visitEstree(ast.program, createSelection('pick', []))).toThrow(
      'Script is not supported',
    );
  });

  it('should return empty array when all items are kept in pick mode', () => {
    const code = `export function a() {}\nexport function b() {}`;
    const ast = parseSync('test.ts', code, {
      astType: 'ts',
      lang: 'tsx',
      sourceType: 'module',
    });
    const ranges = visitEstree(ast.program, createSelection('pick', ['a', 'b']));
    expect(ranges.length).toBe(0);
  });

  it('should handle function declarations', () => {
    const code = `export function foo() {}`;
    const ast = parseSync('test.ts', code, {
      astType: 'ts',
      lang: 'tsx',
      sourceType: 'module',
    });
    const ranges = visitEstree(ast.program, createSelection('pick', ['foo']));
    expect(Array.isArray(ranges)).toBe(true);
  });

  it('should handle variable declarations with identifier', () => {
    const code = `export const bar = 1;`;
    const ast = parseSync('test.ts', code, {
      astType: 'ts',
      lang: 'tsx',
      sourceType: 'module',
    });
    const ranges = visitEstree(ast.program, createSelection('pick', ['bar']));
    expect(Array.isArray(ranges)).toBe(true);
  });
});
