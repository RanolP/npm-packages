import { describe, expect, it } from 'vitest';
import { genLink } from './link.js';
import { CommonSegment } from '../builtin-common-segment.js';

describe('genLink', () => {
  const createRoute = (filePosix: string, segments: CommonSegment[]) => ({
    fileRaw: filePosix,
    filePosix,
    segments: segments as Array<Exclude<CommonSegment, { kind: 'error' | 'skip' }>>,
  });

  describe('basic generation', () => {
    it('should generate LinkMap interface and link function', () => {
       const generator = genLink({});
       const routes = [
         createRoute('home/page.tsx', [
           { kind: 'static' as const, path: 'home', raw: 'home' },
           { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
         ]),
       ];

       const output = generator.generate(routes, 'src/generated/link.ts');
      expect(output).toContain('export interface LinkMap');
      expect(output).toContain('export function link');
      expect(output).toContain('"/home"?: never');
    });

    it('should handle static routes without parameters', () => {
      const generator = genLink({});
      const routes = [
        createRoute('about/page.tsx', [
          { kind: 'static' as const, path: 'about', raw: 'about' },
          { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
        ]),
      ];

      const output = generator.generate(routes, 'src/generated/link.ts');
      expect(output).toContain('"/about"?: never');
    });

    it('should handle nested static routes', () => {
      const generator = genLink({});
      const routes = [
        createRoute('products/category/page.tsx', [
          { kind: 'static' as const, path: 'products', raw: 'products' },
          { kind: 'static' as const, path: 'category', raw: 'category' },
          { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
        ]),
      ];

      const output = generator.generate(routes, 'src/generated/link.ts');
      expect(output).toContain('"/products/category"?: never');
    });
  });

  describe('parameter handling', () => {
    it('should handle single parameter', () => {
      const generator = genLink({});
      const routes = [
        createRoute('products/$id/page.tsx', [
          { kind: 'static' as const, path: 'products', raw: 'products' },
          {
            kind: 'param' as const,
            name: 'id',
            catchall: false,
            optional: false,
            raw: '$id',
          },
          { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
        ]),
      ];

      const output = generator.generate(routes, 'src/generated/link.ts');
      expect(output).toContain('"/products/{id}"');
      expect(output).toContain('"id": string');
    });

    it('should handle multiple parameters', () => {
      const generator = genLink({});
      const routes = [
        createRoute('blog/$year/$slug/page.tsx', [
          { kind: 'static' as const, path: 'blog', raw: 'blog' },
          {
            kind: 'param' as const,
            name: 'year',
            catchall: false,
            optional: false,
            raw: '$year',
          },
          {
            kind: 'param' as const,
            name: 'slug',
            catchall: false,
            optional: false,
            raw: '$slug',
          },
          { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
        ]),
      ];

      const output = generator.generate(routes, 'src/generated/link.ts');
      expect(output).toContain('"/blog/{year}/{slug}"');
      expect(output).toContain('"year": string');
      expect(output).toContain('"slug": string');
    });

    it('should handle optional parameters', () => {
      const generator = genLink({});
      const routes = [
        createRoute('products/[$category]/page.tsx', [
          { kind: 'static' as const, path: 'products', raw: 'products' },
          {
            kind: 'param' as const,
            name: 'category',
            catchall: false,
            optional: true,
            raw: '$category',
          },
          { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
        ]),
      ];

      const output = generator.generate(routes, 'src/generated/link.ts');
      expect(output).toContain('"/products/{category}?"');
      expect(output).toContain('"category"?');
    });

    it('should handle catchall parameters', () => {
      const generator = genLink({});
      const routes = [
        createRoute('docs/$+slug/page.tsx', [
          { kind: 'static' as const, path: 'docs', raw: 'docs' },
          {
            kind: 'param' as const,
            name: 'slug',
            catchall: true,
            optional: false,
            raw: '$+slug',
          },
          { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
        ]),
      ];

      const output = generator.generate(routes, 'src/generated/link.ts');
      expect(output).toContain('"/docs/{*slug}"');
      expect(output).toContain('"slug": string[]');
    });

    it('should handle optional catchall parameters', () => {
      const generator = genLink({});
      const routes = [
        createRoute('docs/[$+slug]/page.tsx', [
          { kind: 'static' as const, path: 'docs', raw: 'docs' },
          {
            kind: 'param' as const,
            name: 'slug',
            catchall: true,
            optional: true,
            raw: '$+slug',
          },
          { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
        ]),
      ];

      const output = generator.generate(routes, 'src/generated/link.ts');
      expect(output).toContain('"/docs/{*slug}?"');
      expect(output).toContain('"slug"?');
      expect(output).toContain('string[]');
    });
  });

  describe('grouping handling', () => {
    it('should ignore grouping segments', () => {
      const generator = genLink({});
      const routes = [
        createRoute('(auth)/login/page.tsx', [
          { kind: 'grouping' as const, name: 'auth', raw: '(auth)' },
          { kind: 'static' as const, path: 'login', raw: 'login' },
          { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
        ]),
      ];

      const output = generator.generate(routes, 'src/generated/link.ts');
      expect(output).toContain('"/login"?: never');
      expect(output).toContain('// (auth)/login/page.tsx');
      // grouping segments should not appear in the route pattern
      expect(output).not.toMatch(/"\(\w+\).*login/);
    });

    it('should ignore multiple grouping segments', () => {
      const generator = genLink({});
      const routes = [
        createRoute('(marketing)/(blog)/posts/page.tsx', [
          { kind: 'grouping' as const, name: 'marketing', raw: '(marketing)' },
          { kind: 'grouping' as const, name: 'blog', raw: '(blog)' },
          { kind: 'static' as const, path: 'posts', raw: 'posts' },
          { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
        ]),
      ];

      const output = generator.generate(routes, 'src/generated/link.ts');
      expect(output).toContain('"/posts"?: never');
    });
  });

  describe('filter option', () => {
    it('should filter routes by terminator', () => {
      const generator = genLink({
        filter: (terminator) => terminator === 'page',
      });

      const routes = [
        createRoute('home/page.tsx', [
          { kind: 'static' as const, path: 'home', raw: 'home' },
          { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
        ]),
        createRoute('api/route.ts', [
          { kind: 'static' as const, path: 'api', raw: 'api' },
          { kind: 'terminator' as const, path: 'route', raw: 'route.ts' },
        ]),
      ];

      const output = generator.generate(routes, 'src/generated/link.ts');
      expect(output).toContain('"/home"?: never');
      expect(output).not.toContain('"/api"');
    });

    it('should handle filter that includes all routes', () => {
      const generator = genLink({
        filter: () => true,
      });

      const routes = [
        createRoute('home/page.tsx', [
          { kind: 'static' as const, path: 'home', raw: 'home' },
          { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
        ]),
        createRoute('api/route.ts', [
          { kind: 'static' as const, path: 'api', raw: 'api' },
          { kind: 'terminator' as const, path: 'route', raw: 'route.ts' },
        ]),
      ];

      const output = generator.generate(routes, 'src/generated/link.ts');
      expect(output).toContain('"/home"?: never');
      expect(output).toContain('"/api"?: never');
    });

    it('should handle filter that excludes all routes', () => {
      const generator = genLink({
        filter: () => false,
      });

      const routes = [
        createRoute('home/page.tsx', [
          { kind: 'static' as const, path: 'home', raw: 'home' },
          { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
        ]),
      ];

      const output = generator.generate(routes, 'src/generated/link.ts');
      expect(output).toContain('export interface LinkMap');
      expect(output).not.toContain('"/home"');
    });

    it('should filter routes without terminator (null)', () => {
      const generator = genLink({
        filter: (terminator) => terminator !== null,
      });

      const routes = [
        createRoute('no-terminator/file.ts', [
          {
            kind: 'static' as const,
            path: 'no-terminator',
            raw: 'no-terminator',
          },
          { kind: 'static' as const, path: 'file', raw: 'file.ts' },
        ]),
        createRoute('home/page.tsx', [
          { kind: 'static' as const, path: 'home', raw: 'home' },
          { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
        ]),
      ];

      const output = generator.generate(routes, 'src/generated/link.ts');
      expect(output).toContain('"/home"?: never');
      expect(output).not.toContain('"/no-terminator/file"');
    });
  });

  describe('targetPath option', () => {
    it('should use default targetPath', () => {
      const generator = genLink({});
      expect(generator.targetPath('src')).toBe('src/generated/link.ts');
    });

    it('should use custom targetPath', () => {
      const generator = genLink({
        targetPath: (pathSafeBranch) => `${pathSafeBranch}/custom-link.ts`,
      });
      expect(generator.targetPath('src')).toBe('src/custom-link.ts');
    });
  });

  describe('complex routes', () => {
    it('should handle complex route with parameters and grouping', () => {
      const generator = genLink({});
      const routes = [
        createRoute('(admin)/products/[$category]/$id/page.tsx', [
          { kind: 'grouping' as const, name: 'admin', raw: '(admin)' },
          { kind: 'static' as const, path: 'products', raw: 'products' },
          {
            kind: 'param' as const,
            name: 'category',
            catchall: false,
            optional: true,
            raw: '$category',
          },
          {
            kind: 'param' as const,
            name: 'id',
            catchall: false,
            optional: false,
            raw: '$id',
          },
          { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
        ]),
      ];

      const output = generator.generate(routes, 'src/generated/link.ts');
      expect(output).toContain('"/products/{category}?/{id}"');
      expect(output).toContain('"category"?');
      expect(output).toContain('"id": string');
    });

    it('should handle route with only parameters', () => {
      const generator = genLink({});
      const routes = [
        createRoute('$user/$id/page.tsx', [
          {
            kind: 'param' as const,
            name: 'user',
            catchall: false,
            optional: false,
            raw: '$user',
          },
          {
            kind: 'param' as const,
            name: 'id',
            catchall: false,
            optional: false,
            raw: '$id',
          },
          { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
        ]),
      ];

      const output = generator.generate(routes, 'src/generated/link.ts');
      expect(output).toContain('"/{user}/{id}"');
      expect(output).toContain('"user": string');
      expect(output).toContain('"id": string');
    });
  });

  describe('generator metadata', () => {
    it('should have correct name', () => {
      const generator = genLink({});
      expect(generator.name).toBe('soonloh:link');
    });
  });

  describe('output format', () => {
    it('should include file path comment', () => {
      const generator = genLink({});
      const routes = [
        createRoute('home/page.tsx', [
          { kind: 'static' as const, path: 'home', raw: 'home' },
          { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
        ]),
      ];

      const output = generator.generate(routes, 'src/generated/link.ts');
      expect(output).toContain('// home/page.tsx');
    });

    it('should produce valid TypeScript', () => {
      const generator = genLink({});
      const routes = [
        createRoute('home/page.tsx', [
          { kind: 'static' as const, path: 'home', raw: 'home' },
          { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
        ]),
        createRoute('user/$id/page.tsx', [
          { kind: 'static' as const, path: 'user', raw: 'user' },
          {
            kind: 'param' as const,
            name: 'id',
            catchall: false,
            optional: false,
            raw: '$id',
          },
          { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
        ]),
      ];

      const output = generator.generate(routes, 'src/generated/link.ts');

      // Check basic structure
      expect(output).toContain('export interface LinkMap');
      expect(output).toContain('};');
      expect(output).toContain('export function link');
      expect(output).toMatch(/\{.*\}/); // Function body
    });

    it('should end with newline', () => {
       const generator = genLink({});
       const routes = [
         createRoute('home/page.tsx', [
           { kind: 'static' as const, path: 'home', raw: 'home' },
           { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
         ]),
       ];

       const output = generator.generate(routes, 'src/generated/link.ts');
       expect(output).toBeDefined();
       if (typeof output === 'string') {
         expect(output[output.length - 1]).toBe('\n');
       }
     });
  });

  describe('edge cases', () => {
    it('should handle empty routes array', () => {
      const generator = genLink({});
      const output = generator.generate([], 'src/generated/link.ts');

      expect(output).toContain('export interface LinkMap');
      expect(output).toContain('};');
      expect(output).toContain('export function link');
    });

    it('should handle special characters in route names', () => {
      const generator = genLink({});
      const routes = [
        createRoute('user-profile/page.tsx', [
          {
            kind: 'static' as const,
            path: 'user-profile',
            raw: 'user-profile',
          },
          { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
        ]),
      ];

      const output = generator.generate(routes, 'src/generated/link.ts');
      expect(output).toContain('"/user-profile"?: never');
    });

    it('should properly escape JSON strings in route patterns', () => {
      const generator = genLink({});
      const routes = [
        createRoute('test/page.tsx', [
          { kind: 'static' as const, path: 'test', raw: 'test' },
          { kind: 'terminator' as const, path: 'page', raw: 'page.tsx' },
        ]),
      ];

      const output = generator.generate(routes, 'src/generated/link.ts');
      expect(output).toContain('"/test"');
    });
  });
});
