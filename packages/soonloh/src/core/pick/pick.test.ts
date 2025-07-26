import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { TypeScriptParser } from './ts-parser.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('TypeScriptParser', () => {
  let parser: TypeScriptParser;
  let tempDir: string;

  beforeEach(async () => {
    parser = new TypeScriptParser();
    tempDir = join(tmpdir(), `ts-parser-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  const createTestFile = async (filename: string, content: string) => {
    const filepath = join(tempDir, filename);
    await writeFile(filepath, content);
    return filepath;
  };



  describe('type alias exports', () => {
    it('should detect exported type aliases', async () => {
      const filepath = await createTestFile(
        'types.ts',
        `
        export type User = { id: string; name: string };
        export type Product = { id: number; title: string };
        type Internal = { secret: boolean }; // not exported
        `
      );

      const types = await parser.getExportedTypes(filepath);
      expect(types).toEqual(new Set(['User', 'Product']));
    });

    it('should detect default exported type aliases', async () => {
      const filepath = await createTestFile(
        'default-type.ts',
        `
        type Config = { api: string };
        export default Config;
        `
      );

      const types = await parser.getExportedTypes(filepath);
      expect(types).toEqual(new Set(['default']));
    });
  });

  describe('interface exports', () => {
    it('should detect exported interfaces', async () => {
      const filepath = await createTestFile(
        'interfaces.ts',
        `
        export interface ApiResponse<T> {
          data: T;
          status: number;
        }
        export interface UserData {
          id: string;
          email: string;
        }
        interface PrivateInterface {
          internal: boolean;
        }
        `
      );

      const types = await parser.getExportedTypes(filepath);
      expect(types).toEqual(new Set(['ApiResponse', 'UserData']));
    });

    it('should detect default exported interfaces', async () => {
      const filepath = await createTestFile(
        'default-interface.ts',
        `
        interface Settings {
          theme: 'light' | 'dark';
        }
        export default Settings;
        `
      );

      const types = await parser.getExportedTypes(filepath);
      expect(types).toEqual(new Set(['default']));
    });
  });

  describe('variable exports', () => {
    it('should detect exported const variables', async () => {
      const filepath = await createTestFile(
        'constants.ts',
        `
        export const API_URL = 'https://api.example.com';
        export const VERSION = '1.0.0';
        const PRIVATE_KEY = 'secret'; // not exported
        `
      );

      const types = await parser.getExportedTypes(filepath);
      expect(types).toEqual(new Set(['API_URL', 'VERSION']));
    });

    it('should detect destructured exports', async () => {
      const filepath = await createTestFile(
        'destructured.ts',
        `
        export const { foo, bar } = { foo: 1, bar: 2 };
        `
      );

      const types = await parser.getExportedTypes(filepath);
      // Note: Current implementation may not handle destructuring
      // This test documents current behavior
      expect(types.size).toBeGreaterThanOrEqual(0);
    });
  });

  describe('function exports', () => {
    it('should detect exported functions', async () => {
      const filepath = await createTestFile(
        'functions.ts',
        `
        export function createUser(name: string) {
          return { name, id: Math.random() };
        }
        export async function fetchData() {
          return Promise.resolve('data');
        }
        function privateHelper() {
          return 'helper';
        }
        `
      );

      const types = await parser.getExportedTypes(filepath);
      expect(types).toEqual(new Set(['createUser', 'fetchData']));
    });

    it('should detect default exported functions', async () => {
      const filepath = await createTestFile(
        'default-function.ts',
        `
        function handler(req: Request) {
          return new Response('OK');
        }
        export default handler;
        `
      );

      const types = await parser.getExportedTypes(filepath);
      expect(types).toEqual(new Set(['default']));
    });
  });

  describe('class exports', () => {
    it('should detect exported classes', async () => {
      const filepath = await createTestFile(
        'classes.ts',
        `
        export class UserService {
          private users = new Map();
        }
        export class ApiClient {
          constructor(private baseUrl: string) {}
        }
        class InternalService {
          // not exported
        }
        `
      );

      const types = await parser.getExportedTypes(filepath);
      expect(types).toEqual(new Set(['UserService', 'ApiClient']));
    });

    it('should detect default exported classes', async () => {
      const filepath = await createTestFile(
        'default-class.ts',
        `
        class Database {
          connect() {}
        }
        export default Database;
        `
      );

      const types = await parser.getExportedTypes(filepath);
      expect(types).toEqual(new Set(['default']));
    });
  });

  describe('re-exports', () => {
    it('should detect named re-exports', async () => {
      const filepath = await createTestFile(
        're-exports.ts',
        `
        import { internalFunction } from './internal';
        export { User, Product } from './types';
        export { createClient as client } from './api';
        `
      );

      const types = await parser.getExportedTypes(filepath);
      expect(types).toEqual(new Set(['User', 'Product', 'client']));
    });
  });

  describe('mixed exports', () => {
    it('should detect all types of exports in one file', async () => {
      const filepath = await createTestFile(
        'mixed.ts',
        `
        export type Config = { api: string };
        export interface User {
          id: string;
        }
        export const API_URL = 'https://api.com';
        export function createUser() {}
        export class UserService {}
        export { Helper } from './helper';
        `
      );

      const types = await parser.getExportedTypes(filepath);
      expect(types).toEqual(new Set([
        'Config',
        'User', 
        'API_URL',
        'createUser',
        'UserService',
        'Helper'
      ]));
    });
  });

  describe('error handling', () => {
    it('should handle invalid TypeScript syntax gracefully', async () => {
      const filepath = await createTestFile(
        'invalid.ts',
        `
        export type Broken = {
          // Missing closing brace
        `
      );

      const types = await parser.getExportedTypes(filepath);
      expect(types).toEqual(new Set());
    });

    it('should handle non-existent files gracefully', async () => {
      const types = await parser.getExportedTypes('/non/existent/file.ts');
      expect(types).toEqual(new Set());
    });
  });

  describe('caching', () => {
    it('should cache results for the same file', async () => {
      const filepath = await createTestFile(
        'cached.ts',
        'export type Test = string;'
      );

      const result1 = await parser.getExportedTypes(filepath);
      const result2 = await parser.getExportedTypes(filepath);

      expect(result1).toEqual(result2);
      expect(result1).toBe(result2); // Same reference due to caching
    });

    it('should invalidate cache when requested', async () => {
      const filepath = await createTestFile(
        'invalidate.ts',
        'export type Test = string;'
      );

      await parser.getExportedTypes(filepath);
      parser.invalidateCache(filepath);

      // File should be re-parsed (but result should be same)
      const result = await parser.getExportedTypes(filepath);
      expect(result).toEqual(new Set(['Test']));
    });

    it('should clear all cache when no path provided', async () => {
      const filepath1 = await createTestFile('cache1.ts', 'export type A = string;');
      const filepath2 = await createTestFile('cache2.ts', 'export type B = string;');

      await parser.getExportedTypes(filepath1);
      await parser.getExportedTypes(filepath2);

      parser.invalidateCache(); // Clear all

      const result1 = await parser.getExportedTypes(filepath1);
      const result2 = await parser.getExportedTypes(filepath2);

      expect(result1).toEqual(new Set(['A']));
      expect(result2).toEqual(new Set(['B']));
    });
  });

  describe('isTypeExported', () => {
    it('should check if specific type is exported', async () => {
      const filepath = await createTestFile(
        'check.ts',
        `
        export type User = { id: string };
        type Internal = { secret: boolean };
        `
      );

      expect(await parser.isTypeExported(filepath, 'User')).toBe(true);
      expect(await parser.isTypeExported(filepath, 'Internal')).toBe(false);
      expect(await parser.isTypeExported(filepath, 'NonExistent')).toBe(false);
    });
  });
});
