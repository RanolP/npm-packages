import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { parser, segments } from './snzrwm.js';

describe('snzrwm parser', () => {
  const defaultParser = parser({});

  describe('basic parsing', () => {
    it('should parse simple page route', () => {
      const result = defaultParser('home/page.tsx');
      expect(result).toEqual([
        segments.static({ path: 'home' }),
        segments.terminator({ path: 'page' }),
      ]);
    });

    it('should parse route with multiple segments', () => {
      const result = defaultParser('products/category/page.tsx');
      expect(result).toEqual([
        segments.static({ path: 'products' }),
        segments.static({ path: 'category' }),
        segments.terminator({ path: 'page' }),
      ]);
    });

    it('should return null for non-terminating paths', () => {
      const result = defaultParser('products/category/utils.ts');
      expect(result).toBeNull();
    });

    it('should return null for paths ending with underscore', () => {
      const result = defaultParser('_utils/page.tsx');
      expect(result).toBeNull();
    });
  });

  describe('parameter parsing', () => {
    it('should parse single parameter', () => {
      const result = defaultParser('products/$id/page.tsx');
      expect(result).toEqual([
        segments.static({ path: 'products' }),
        segments.param({ name: 'id', catchall: false, optional: false }),
        segments.terminator({ path: 'page' }),
      ]);
    });

    it('should parse catchall parameter', () => {
      const result = defaultParser('docs/$+slug/page.tsx');
      expect(result).toEqual([
        segments.static({ path: 'docs' }),
        segments.param({ name: 'slug', catchall: true, optional: false }),
        segments.terminator({ path: 'page' }),
      ]);
    });

    it('should parse optional parameter', () => {
      const result = defaultParser('products/[$id]/page.tsx');
      expect(result).toEqual([
        segments.static({ path: 'products' }),
        segments.param({ name: 'id', catchall: false, optional: true }),
        segments.terminator({ path: 'page' }),
      ]);
    });

    it('should parse optional catchall parameter', () => {
      const result = defaultParser('docs/[$+slug]/page.tsx');
      expect(result).toEqual([
        segments.static({ path: 'docs' }),
        segments.param({ name: 'slug', catchall: true, optional: true }),
        segments.terminator({ path: 'page' }),
      ]);
    });
  });

  describe('grouping', () => {
    it('should parse grouping', () => {
      const result = defaultParser('(auth)/login/page.tsx');
      expect(result).toEqual([
        segments.grouping({ name: 'auth' }),
        segments.static({ path: 'login' }),
        segments.terminator({ path: 'page' }),
      ]);
    });

    it('should parse nested grouping', () => {
      const result = defaultParser('(marketing)/(blog)/posts/page.tsx');
      expect(result).toEqual([
        segments.grouping({ name: 'marketing' }),
        segments.grouping({ name: 'blog' }),
        segments.static({ path: 'posts' }),
        segments.terminator({ path: 'page' }),
      ]);
    });
  });

  describe('escape sequences', () => {
    it('should parse escaped static path', () => {
      const result = defaultParser('{$special}/page.tsx');
      expect(result).toEqual([
        segments.static({ path: '$special' }),
        segments.terminator({ path: 'page' }),
      ]);
    });

    it('should parse escaped grouping', () => {
      const result = defaultParser('{(not-a-group)}/page.tsx');
      expect(result).toEqual([
        segments.static({ path: '(not-a-group)' }),
        segments.terminator({ path: 'page' }),
      ]);
    });
  });

  describe('terminators', () => {
    it('should parse all default terminators', () => {
      const terminators = ['page', 'route', 'layout', 'error', 'loading'];
      const extensions = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'mjsx', 'mts', 'mtsx', 'cjs', 'cjsx', 'cts', 'ctsx'];
      
      for (const terminator of terminators) {
        for (const ext of extensions) {
          const result = defaultParser(`home/${terminator}.${ext}`);
          expect(result).toEqual([
            segments.static({ path: 'home' }),
            segments.terminator({ path: terminator }),
          ]);
        }
      }
    });

    it('should parse all-caps terminators', () => {
      const result = defaultParser('api/HANDLER.ts');
      expect(result).toEqual([
        segments.static({ path: 'api' }),
        segments.terminator({ path: 'HANDLER' }),
      ]);
    });

    it('should not parse mixed-case as terminator', () => {
      const result = defaultParser('api/Handler.ts');
      expect(result).toBeNull();
    });
  });

  describe('custom terminators', () => {
    it('should respect custom terminator tokens', () => {
      const customParser = parser({
        terminators: { allCaps: false, tokens: ['index', 'view'] },
      });
      
      const result1 = customParser('home/index.tsx');
      expect(result1).toEqual([
        segments.static({ path: 'home' }),
        segments.terminator({ path: 'index' }),
      ]);

      const result2 = customParser('home/page.tsx');
      expect(result2).toBeNull();

      const result3 = customParser('home/ALLCAPS.tsx');
      expect(result3).toBeNull();
    });

    it('should disable terminators when set to false', () => {
      const noTerminatorParser = parser({ terminators: false });
      
      const result = noTerminatorParser('home/page.tsx');
      expect(result).toBeNull();
    });
  });

  describe('complex combinations', () => {
    it('should parse complex route with multiple features', () => {
      const result = defaultParser('(admin)/products/[$category]/$id/{special-offer}/page.tsx');
      expect(result).toEqual([
        segments.grouping({ name: 'admin' }),
        segments.static({ path: 'products' }),
        segments.param({ name: 'category', catchall: false, optional: true }),
        segments.param({ name: 'id', catchall: false, optional: false }),
        segments.static({ path: 'special-offer' }),
        segments.terminator({ path: 'page' }),
      ]);
    });
  });

  describe('property-based testing', () => {
    it('should always return null or array of segments', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          (path) => {
            const result = defaultParser(path);
            expect(result === null || Array.isArray(result)).toBe(true);
          }
        )
      );
    });

    it('should parse valid static paths consistently', () => {
      fc.assert(
        fc.property(
          fc.array(fc.stringMatching(/^[a-z]+$/), { minLength: 1, maxLength: 5 }),
          (pathSegments) => {
            const path = [...pathSegments, 'page.tsx'].join('/');
            const result = defaultParser(path);
            
            expect(result).not.toBeNull();
            expect(result).toHaveLength(pathSegments.length + 1);
            
            pathSegments.forEach((segment, i) => {
              expect(result![i]).toEqual(segments.static({ path: segment }));
            });
            
            expect(result![pathSegments.length]).toEqual(
              segments.terminator({ path: 'page' })
            );
          }
        )
      );
    });

    it('should handle parameter names consistently', () => {
      fc.assert(
        fc.property(
          fc.stringMatching(/^[a-z][a-zA-Z0-9]*$/),  // Start with lowercase to avoid ALLCAPS terminator
          (paramName) => {
            const paths = [
              `$${paramName}/page.tsx`,
              `[$${paramName}]/page.tsx`,
              `$+${paramName}/page.tsx`,
              `[$+${paramName}]/page.tsx`,
            ];

            for (const path of paths) {
              const result = defaultParser(path);
              expect(result).not.toBeNull();
              
              const param = result![0];
              expect(param.kind).toBe('param');
              expect((param as any).name).toBe(paramName);
            }
          }
        )
      );
    });

    it('should handle escaped content without modification', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }).filter(s => !s.includes('}') && !s.includes('{')),
          (content) => {
            const path = `{${content}}/page.tsx`;
            const result = defaultParser(path);
            
            expect(result).not.toBeNull();
            expect(result![0]).toEqual(segments.static({ path: content }));
          }
        )
      );
    });
  });
});