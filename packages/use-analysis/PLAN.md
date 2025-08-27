# use-analysis Implementation Plan

## Overview
Build a TypeScript AST query library optimized for analyzing library usage patterns, similar to ast-grep but TypeScript-focused.

## Phase 1: Foundation (Core Infrastructure)

### 1.1 SourceSet Class
- [x] Implement `SourceSet` constructor with glob pattern support
  - Accept `GlobPattern | GlobPattern[]`
  - Add optional TypeScript config parameter
  - Define `RECOMMENDED_TSCONFIG` constant
- [x] Set up ts-morph Project integration
  - Lazy file loading on first query
  - AST node caching mechanism
  - TypeScript config resolution

### 1.2 Basic QueryResult Class
- [ ] Create `QueryResult` class structure
- [ ] Implement `QueryResultElement` interface:
  ```typescript
  interface QueryResultElement {
    node: AstNode;
    captures: Record<string, AstNode>;
    parent?: QueryResultElement;
    sourceFilePath: string;
  }
  ```
- [ ] Add async iterator support (`Symbol.asyncIterator`)

## Phase 2: Pattern Matching Engine

### 2.1 Pattern Parser
- [ ] Build tokenizer for query pattern syntax
- [ ] Create AST representation of patterns
- [ ] Handle JavaScript/TypeScript syntax parsing

### 2.2 Basic Matching
- [ ] Implement exact AST matching
  - Ignore non-essential parts (whitespace, semicolons, parentheses)
  - Match function declarations, variable assignments, expressions
- [ ] Add support for optional specifiers (`async?`, `export?`, `default?`)

### 2.3 Capture Variables
- [ ] Implement `$IDENTIFIER` capture syntax
  - Validate uppercase alphanumeric identifiers
  - Store captured nodes in result
- [ ] Add `$$$` rest element matching
  - Function arguments
  - Array elements
  - Block statements

## Phase 3: Advanced Features

### 3.1 Type Constraints
- [ ] Implement `($: Type)` syntax
- [ ] Add inline import support for type constraints
  - Parse `import('module').Type` syntax
  - Resolve types using ts-morph type checker
- [ ] Type assignability checking

### 3.2 JSX Support
- [ ] Parse JSX element patterns
- [ ] Match JSX attributes and children
- [ ] Handle JSX expressions and fragments

### 3.3 Query Composition
- [ ] Implement `.or(pattern)` - union of results
- [ ] Implement `.and(pattern)` - intersection of results  
- [ ] Implement `.exclude(pattern)` - difference of results
- [ ] Implement `.select(pattern)` - nested queries with parent context

## Phase 4: Error Handling & Testing

### 4.1 Error Handling
- [anner InvalidPatternError for malformed queries
- [ ] FileNotFoundError for glob mismatches
- [ ] TypeResolutionError for type constraints
- [ ] Early validation and descriptive error messages

### 4.2 Testing
- [ ] Unit tests for pattern parser
- [ ] Integration tests for each pattern type
- [ ] Performance tests for large codebases
- [ ] Edge cases and error scenarios

## Phase 5: Documentation & Polish

### 5.1 Documentation
- [ ] API reference with all methods
- [ ] Pattern syntax guide with examples
- [ ] Common use case tutorials
- [ ] Migration guide from ast-grep

### 5.2 Performance Optimization
- [ ] Optimize pattern matching algorithms
- [ ] Improve caching strategies
- [ ] Benchmark against similar tools

## Technical Decisions

### Dependencies
- `ts-morph`: AST manipulation and type checking ✓
- `fast-glob`: File pattern matching ✓
- Existing dev dependencies (TypeScript, Vitest, tsdown)

### Architecture
- **Lazy evaluation**: Queries processed on iteration, not construction
- **Immutable results**: Each operation returns new QueryResult
- **Streaming**: Use async iterators for memory efficiency
- **Caching**: Parse files once, reuse AST nodes

### Limitations (MVP)
- No decorator matching
- No type annotation matching  
- No escape sequences for literal `$` or `$$$`
- No custom pattern functions
- QueryPattern is plain string (future: template literal types)

## Success Criteria
- [ ] All README API examples work
- [ ] Performance: < 1s for 1000 file codebase query
- [ ] 90%+ test coverage
- [ ] Zero runtime dependencies besides ts-morph
- [ ] Works with React, Vue, Angular codebases

## Future Enhancements (Post-MVP)
- Decorator and type annotation support
- Escape sequence syntax
- Template literal types for better IDE support
- Custom matcher functions
- CLI tool for interactive queries
- VSCode extension for visual querying
- Integration with build tools (webpack, vite, rollup)