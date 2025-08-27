import { Node, SourceFile } from 'ts-morph'

export type AstNode = Node

export interface QueryResultElement {
  node: AstNode
  captures: Record<string, AstNode | AstNode[] | string | undefined>
  parent?: QueryResultElement
  sourceFilePath: string
}

export class QueryResult implements AsyncIterable<QueryResultElement> {
  private elements: QueryResultElement[]
  private lazyGenerator?: AsyncGenerator<QueryResultElement>

  constructor(
    elementsOrGenerator: QueryResultElement[] | AsyncGenerator<QueryResultElement>
  ) {
    if (Array.isArray(elementsOrGenerator)) {
      this.elements = elementsOrGenerator
    } else {
      this.elements = []
      this.lazyGenerator = elementsOrGenerator
    }
  }

  static empty(): QueryResult {
    return new QueryResult([])
  }

  static from(elements: QueryResultElement[]): QueryResult {
    return new QueryResult(elements)
  }

  static fromGenerator(generator: AsyncGenerator<QueryResultElement>): QueryResult {
    return new QueryResult(generator)
  }

  async *[Symbol.asyncIterator](): AsyncIterator<QueryResultElement> {
    // If we have precomputed elements, yield them
    for (const element of this.elements) {
      yield element
    }

    // If we have a lazy generator, consume it
    if (this.lazyGenerator) {
      for await (const element of this.lazyGenerator) {
        this.elements.push(element) // Cache for potential re-iteration
        yield element
      }
      this.lazyGenerator = undefined // Mark as consumed
    }
  }

  async toArray(): Promise<QueryResultElement[]> {
    // Force full iteration to populate elements array
    if (this.lazyGenerator) {
      for await (const _ of this) {
        // Iteration will populate this.elements
      }
    }
    return [...this.elements]
  }

  async count(): Promise<number> {
    await this.toArray() // Ensure all elements are loaded
    return this.elements.length
  }

  async first(): Promise<QueryResultElement | undefined> {
    // Efficiently get first element without full iteration
    if (this.elements.length > 0) {
      return this.elements[0]
    }
    
    if (this.lazyGenerator) {
      const { value, done } = await this.lazyGenerator.next()
      if (!done && value) {
        this.elements.push(value)
        return value
      }
    }
    
    return undefined
  }

  async isEmpty(): Promise<boolean> {
    const first = await this.first()
    return first === undefined
  }

  // Query composition methods (to be implemented with pattern matching)
  or(pattern: string | QueryResult): QueryResult {
    // Placeholder for union operation
    throw new Error('Not implemented yet')
  }

  and(pattern: string | QueryResult): QueryResult {
    // Placeholder for intersection operation
    throw new Error('Not implemented yet')
  }

  exclude(pattern: string | QueryResult): QueryResult {
    // Placeholder for difference operation
    throw new Error('Not implemented yet')
  }

  select(pattern: string): QueryResult {
    // Placeholder for nested query with parent context
    throw new Error('Not implemented yet')
  }

  // Transform operations
  map(fn: (element: QueryResultElement) => QueryResultElement): QueryResult {
    const generator = async function* (this: QueryResult) {
      for await (const element of this) {
        yield fn(element)
      }
    }.call(this)
    
    return QueryResult.fromGenerator(generator)
  }

  filter(predicate: (element: QueryResultElement) => boolean | Promise<boolean>): QueryResult {
    const generator = async function* (this: QueryResult) {
      for await (const element of this) {
        if (await predicate(element)) {
          yield element
        }
      }
    }.call(this)
    
    return QueryResult.fromGenerator(generator)
  }

  // Utility to get unique nodes (deduplicate)
  unique(): QueryResult {
    const generator = async function* (this: QueryResult) {
      const seenNodes = new Set<AstNode>()
      for await (const element of this) {
        if (!seenNodes.has(element.node)) {
          seenNodes.add(element.node)
          yield element
        }
      }
    }.call(this)
    
    return QueryResult.fromGenerator(generator)
  }

  // Limit results
  limit(n: number): QueryResult {
    const generator = async function* (this: QueryResult) {
      let count = 0
      for await (const element of this) {
        if (count >= n) break
        yield element
        count++
      }
    }.call(this)
    
    return QueryResult.fromGenerator(generator)
  }

  // Skip results
  skip(n: number): QueryResult {
    const generator = async function* (this: QueryResult) {
      let count = 0
      for await (const element of this) {
        if (count >= n) {
          yield element
        }
        count++
      }
    }.call(this)
    
    return QueryResult.fromGenerator(generator)
  }
}