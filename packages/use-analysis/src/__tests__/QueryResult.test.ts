import { describe, it, expect } from 'vitest'
import { QueryResult, QueryResultElement } from '../QueryResult'
import { Project, SyntaxKind } from 'ts-morph'

describe('QueryResult', () => {
  // Helper to create mock QueryResultElement
  const createElement = (id: string, captures: Record<string, any> = {}): QueryResultElement => {
    const project = new Project()
    const sourceFile = project.createSourceFile('test.ts', `const ${id} = 1;`)
    const node = sourceFile.getVariableDeclarations()[0]
    
    return {
      node,
      captures,
      sourceFilePath: 'test.ts',
    }
  }

  describe('construction', () => {
    it('should create from empty array', () => {
      const result = QueryResult.from([])
      expect(result).toBeInstanceOf(QueryResult)
    })

    it('should create from elements array', () => {
      const elements = [createElement('a'), createElement('b')]
      const result = QueryResult.from(elements)
      expect(result).toBeInstanceOf(QueryResult)
    })

    it('should create from generator', () => {
      async function* generator() {
        yield createElement('a')
        yield createElement('b')
      }
      const result = QueryResult.fromGenerator(generator())
      expect(result).toBeInstanceOf(QueryResult)
    })

    it('should create empty result', () => {
      const result = QueryResult.empty()
      expect(result).toBeInstanceOf(QueryResult)
    })
  })

  describe('async iteration', () => {
    it('should iterate over elements', async () => {
      const elements = [createElement('a'), createElement('b'), createElement('c')]
      const result = QueryResult.from(elements)
      
      const collected: QueryResultElement[] = []
      for await (const element of result) {
        collected.push(element)
      }
      
      expect(collected).toHaveLength(3)
      expect(collected).toEqual(elements)
    })

    it('should iterate over generator elements', async () => {
      const elements = [createElement('a'), createElement('b')]
      async function* generator() {
        for (const el of elements) {
          yield el
        }
      }
      
      const result = QueryResult.fromGenerator(generator())
      const collected: QueryResultElement[] = []
      for await (const element of result) {
        collected.push(element)
      }
      
      expect(collected).toHaveLength(2)
      expect(collected).toEqual(elements)
    })

    it('should support multiple iterations when backed by array', async () => {
      const elements = [createElement('a'), createElement('b')]
      const result = QueryResult.from(elements)
      
      const first: QueryResultElement[] = []
      for await (const element of result) {
        first.push(element)
      }
      
      const second: QueryResultElement[] = []
      for await (const element of result) {
        second.push(element)
      }
      
      expect(first).toEqual(second)
    })

    it('should cache generator results for re-iteration', async () => {
      let generatorCalls = 0
      async function* generator() {
        generatorCalls++
        yield createElement('a')
        yield createElement('b')
      }
      
      const result = QueryResult.fromGenerator(generator())
      
      const first: QueryResultElement[] = []
      for await (const element of result) {
        first.push(element)
      }
      
      const second: QueryResultElement[] = []
      for await (const element of result) {
        second.push(element)
      }
      
      expect(first.length).toBe(2)
      expect(second.length).toBe(2)
      expect(generatorCalls).toBe(1) // Generator only called once
    })
  })

  describe('toArray', () => {
    it('should convert to array', async () => {
      const elements = [createElement('a'), createElement('b')]
      const result = QueryResult.from(elements)
      const array = await result.toArray()
      
      expect(array).toEqual(elements)
    })

    it('should force generator evaluation', async () => {
      async function* generator() {
        yield createElement('a')
        yield createElement('b')
      }
      
      const result = QueryResult.fromGenerator(generator())
      const array = await result.toArray()
      
      expect(array).toHaveLength(2)
    })
  })

  describe('count', () => {
    it('should count elements', async () => {
      const elements = [createElement('a'), createElement('b'), createElement('c')]
      const result = QueryResult.from(elements)
      
      expect(await result.count()).toBe(3)
    })

    it('should return 0 for empty result', async () => {
      const result = QueryResult.empty()
      expect(await result.count()).toBe(0)
    })
  })

  describe('first', () => {
    it('should get first element', async () => {
      const elements = [createElement('a'), createElement('b')]
      const result = QueryResult.from(elements)
      
      const first = await result.first()
      expect(first).toEqual(elements[0])
    })

    it('should return undefined for empty result', async () => {
      const result = QueryResult.empty()
      const first = await result.first()
      
      expect(first).toBeUndefined()
    })

    it('should efficiently get first from generator', async () => {
      let yielded = 0
      async function* generator() {
        yielded++
        yield createElement('a')
        yielded++
        yield createElement('b')
        yielded++
        yield createElement('c')
      }
      
      const result = QueryResult.fromGenerator(generator())
      const first = await result.first()
      
      expect(first).toBeDefined()
      expect(yielded).toBe(1) // Only first element was generated
    })
  })

  describe('isEmpty', () => {
    it('should return true for empty result', async () => {
      const result = QueryResult.empty()
      expect(await result.isEmpty()).toBe(true)
    })

    it('should return false for non-empty result', async () => {
      const result = QueryResult.from([createElement('a')])
      expect(await result.isEmpty()).toBe(false)
    })
  })

  describe('transformation methods', () => {
    describe('map', () => {
      it('should transform elements', async () => {
        const elements = [createElement('a'), createElement('b')]
        const result = QueryResult.from(elements)
        
        const mapped = result.map(el => ({
          ...el,
          captures: { ...el.captures, mapped: 'true' }
        }))
        
        const array = await mapped.toArray()
        expect(array).toHaveLength(2)
        expect(array[0].captures.mapped).toBe('true')
        expect(array[1].captures.mapped).toBe('true')
      })
    })

    describe('filter', () => {
      it('should filter elements', async () => {
        const elements = [
          createElement('a', { keep: 'true' }),
          createElement('b', { keep: 'false' }),
          createElement('c', { keep: 'true' })
        ]
        const result = QueryResult.from(elements)
        
        const filtered = result.filter(el => el.captures.keep === 'true')
        const array = await filtered.toArray()
        
        expect(array).toHaveLength(2)
        expect(array[0].captures.keep).toBe('true')
        expect(array[1].captures.keep).toBe('true')
      })

      it('should support async predicates', async () => {
        const elements = [createElement('a'), createElement('b'), createElement('c')]
        const result = QueryResult.from(elements)
        
        const filtered = result.filter(async (el) => {
          await new Promise(resolve => setTimeout(resolve, 1))
          return el.node.getText().includes('a') || el.node.getText().includes('c')
        })
        
        const array = await filtered.toArray()
        expect(array).toHaveLength(2)
      })
    })

    describe('unique', () => {
      it('should deduplicate by node', async () => {
        const el1 = createElement('a')
        const el2 = createElement('b')
        const elements = [el1, el2, el1, el2, el1] // Duplicates
        const result = QueryResult.from(elements)
        
        const unique = result.unique()
        const array = await unique.toArray()
        
        expect(array).toHaveLength(2)
        expect(array[0]).toEqual(el1)
        expect(array[1]).toEqual(el2)
      })
    })

    describe('limit', () => {
      it('should limit results', async () => {
        const elements = [
          createElement('a'),
          createElement('b'),
          createElement('c'),
          createElement('d')
        ]
        const result = QueryResult.from(elements)
        
        const limited = result.limit(2)
        const array = await limited.toArray()
        
        expect(array).toHaveLength(2)
        expect(array[0]).toEqual(elements[0])
        expect(array[1]).toEqual(elements[1])
      })

      it('should handle limit larger than elements', async () => {
        const elements = [createElement('a')]
        const result = QueryResult.from(elements)
        
        const limited = result.limit(10)
        const array = await limited.toArray()
        
        expect(array).toHaveLength(1)
      })
    })

    describe('skip', () => {
      it('should skip elements', async () => {
        const elements = [
          createElement('a'),
          createElement('b'),
          createElement('c'),
          createElement('d')
        ]
        const result = QueryResult.from(elements)
        
        const skipped = result.skip(2)
        const array = await skipped.toArray()
        
        expect(array).toHaveLength(2)
        expect(array[0]).toEqual(elements[2])
        expect(array[1]).toEqual(elements[3])
      })

      it('should return empty when skip exceeds length', async () => {
        const elements = [createElement('a')]
        const result = QueryResult.from(elements)
        
        const skipped = result.skip(10)
        const array = await skipped.toArray()
        
        expect(array).toHaveLength(0)
      })
    })
  })

  describe('chaining', () => {
    it('should support method chaining', async () => {
      const elements = [
        createElement('a', { value: '1' }),
        createElement('b', { value: '2' }),
        createElement('c', { value: '3' }),
        createElement('d', { value: '4' }),
        createElement('e', { value: '5' })
      ]
      const result = QueryResult.from(elements)
      
      const chained = result
        .filter(el => parseInt(el.captures.value as string) > 1)
        .map(el => ({ ...el, captures: { ...el.captures, doubled: String(parseInt(el.captures.value as string) * 2) }}))
        .skip(1)
        .limit(2)
      
      const array = await chained.toArray()
      
      expect(array).toHaveLength(2)
      expect(array[0].captures.value).toBe('3')
      expect(array[0].captures.doubled).toBe('6')
      expect(array[1].captures.value).toBe('4')
      expect(array[1].captures.doubled).toBe('8')
    })
  })

  describe('query composition placeholders', () => {
    it('should throw not implemented for or()', () => {
      const result = QueryResult.empty()
      expect(() => result.or('pattern')).toThrow('Not implemented yet')
    })

    it('should throw not implemented for and()', () => {
      const result = QueryResult.empty()
      expect(() => result.and('pattern')).toThrow('Not implemented yet')
    })

    it('should throw not implemented for exclude()', () => {
      const result = QueryResult.empty()
      expect(() => result.exclude('pattern')).toThrow('Not implemented yet')
    })

    it('should throw not implemented for select()', () => {
      const result = QueryResult.empty()
      expect(() => result.select('pattern')).toThrow('Not implemented yet')
    })
  })
})