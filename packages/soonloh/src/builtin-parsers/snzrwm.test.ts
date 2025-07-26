import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { parser, segments } from './snzrwm.js';

describe('snzrwm parser', () => {
  const defaultParser = parser({});

  describe('basic parsing', () => {
    it('should parse simple page route', () => {
      const result = defaultParser('home/page.tsx');
      expect(result).toEqual([
        segments.static({ path: 'home', raw: 'home' }),
        segments.terminator({ path: 'page', raw: 'page.tsx' }),
      ]);
    });

    it('should parse route with multiple segments', () => {
      const result = defaultParser('products/category/page.tsx');
      expect(result).toEqual([
        segments.static({ path: 'products', raw: 'products' }),
        segments.static({ path: 'category', raw: 'category' }),
        segments.terminator({ path: 'page', raw: 'page.tsx' }),
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
        segments.static({ path: 'products', raw: 'products' }),
        segments.param({ name: 'id', catchall: false, optional: false, raw: '$id' }),
        segments.terminator({ path: 'page', raw: 'page.tsx' }),
      ]);
    });

    it('should parse catchall parameter', () => {
      const result = defaultParser('docs/$+slug/page.tsx');
      expect(result).toEqual([
        segments.static({ path: 'docs', raw: 'docs' }),
        segments.param({ name: 'slug', catchall: true, optional: false, raw: '$+slug' }),
        segments.terminator({ path: 'page', raw: 'page.tsx' }),
      ]);
    });

    it('should parse optional parameter', () => {
      const result = defaultParser('products/[$id]/page.tsx');
      expect(result).toEqual([
        segments.static({ path: 'products', raw: 'products' }),
        segments.param({ name: 'id', catchall: false, optional: true, raw: '$id' }),
        segments.terminator({ path: 'page', raw: 'page.tsx' }),
      ]);
    });

    it('should parse optional catchall parameter', () => {
      const result = defaultParser('docs/[$+slug]/page.tsx');
      expect(result).toEqual([
        segments.static({ path: 'docs', raw: 'docs' }),
        segments.param({ name: 'slug', catchall: true, optional: true, raw: '$+slug' }),
        segments.terminator({ path: 'page', raw: 'page.tsx' }),
      ]);
    });
  });

  describe('grouping', () => {
    it('should parse grouping', () => {
      const result = defaultParser('(auth)/login/page.tsx');
      expect(result).toEqual([
        segments.grouping({ name: 'auth', raw: '(auth)' }),
        segments.static({ path: 'login', raw: 'login' }),
        segments.terminator({ path: 'page', raw: 'page.tsx' }),
      ]);
    });

    it('should parse nested grouping', () => {
      const result = defaultParser('(marketing)/(blog)/posts/page.tsx');
      expect(result).toEqual([
        segments.grouping({ name: 'marketing', raw: '(marketing)' }),
        segments.grouping({ name: 'blog', raw: '(blog)' }),
        segments.static({ path: 'posts', raw: 'posts' }),
        segments.terminator({ path: 'page', raw: 'page.tsx' }),
      ]);
    });
  });

  describe('escape sequences', () => {
    it('should parse escaped static path', () => {
      const result = defaultParser('{$special}/page.tsx');
      expect(result).toEqual([
        segments.static({ path: '$special', raw: '{$special}' }),
        segments.terminator({ path: 'page', raw: 'page.tsx' }),
      ]);
    });

    it('should parse escaped grouping', () => {
      const result = defaultParser('{(not-a-group)}/page.tsx');
      expect(result).toEqual([
        segments.static({ path: '(not-a-group)', raw: '{(not-a-group)}' }),
        segments.terminator({ path: 'page', raw: 'page.tsx' }),
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
            segments.static({ path: 'home', raw: 'home' }),
            segments.terminator({ path: terminator, raw: `${terminator}.${ext}` }),
          ]);
        }
      }
    });

    it('should parse all-caps terminators', () => {
      const result = defaultParser('api/HANDLER.ts');
      expect(result).toEqual([
        segments.static({ path: 'api', raw: 'api' }),
        segments.terminator({ path: 'HANDLER', raw: 'HANDLER.ts' }),
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
        segments.static({ path: 'home', raw: 'home' }),
        segments.terminator({ path: 'index', raw: 'index.tsx' }),
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
        segments.grouping({ name: 'admin', raw: '(admin)' }),
        segments.static({ path: 'products', raw: 'products' }),
        segments.param({ name: 'category', catchall: false, optional: true, raw: '$category' }),
        segments.param({ name: 'id', catchall: false, optional: false, raw: '$id' }),
        segments.static({ path: 'special-offer', raw: '{special-offer}' }),
        segments.terminator({ path: 'page', raw: 'page.tsx' }),
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
            if (result) {
              expect(result).toHaveLength(pathSegments.length + 1);
              
              pathSegments.forEach((segment, i) => {
                expect(result[i]).toEqual(segments.static({ path: segment, raw: segment }));
              });
              
              expect(result[pathSegments.length]).toEqual(
                segments.terminator({ path: 'page', raw: 'page.tsx' })
              );
            }
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
              
              if (result) {
                const param = result[0];
                if (param) {
                  expect(param.kind).toBe('param');
                  expect((param as any).name).toBe(paramName);
                }
              }
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
            if (result) {
              expect(result[0]).toEqual(segments.static({ path: content, raw: `{${content}}` }));
            }
          }
        )
      );
    });
  });
});
