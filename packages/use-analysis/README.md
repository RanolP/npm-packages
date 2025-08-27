# use-analysis

Create your own build-time analysis on use of library (e.g. Static Extraction of CSS-in-JS).

It's much like ast-grep optimized for TypeScript.

## API

### `new SourceSet(files: GlobPattern | GlobPattern[], config?: TsConfig | { tsconfigPath: string } = RECOMMENDED_TSCONFIG)`

Create source set from glob pattern string.

### `SourceSet.query(pat: QueryPattern): QueryResult`

Query expression based on the pattern. Following patterns are allowed:

| Syntax                    | Example                                            | Behavior                                                                                                                           |
| ------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| *Normal JavaScript Codes* | `css({ a: 1 })`, `x = 3`                           | Match for exact AST; <br> Non-essential parts ignored (grouping parenthesis, whitespace, semicolon, return type of function, etc.) |
| `'$' ident`               | `$0`, `$NAME`                                      | Match any node and capture it as variable named ident. the ident must be uppercased ascii alphabet or digit.                       |
| `'$$$'`                   | `$$$`                                              | Match for all the rest elements. Can appear inside function call argument, array enumeration, function call, an expression etc.    |
| `'(' '$' ':' type ')'`    | `($: { [import('styled-system').id.css]: true  })` | Match for expression can be assignable to the type specified                                                                       |
| `specifier '?'`           | `async? function $NAME() { $$$ }`                  | The node can have spcifier or not.                                                                                                 |

Example usage:

```
sources.query(`
  export? default? async? function loader() {
    $$$
  }
`).or(`
  export? const loader = $$$;
`)
```

### The `QueryResult` type

You can use fluent chaining method on `QueryResult`

#### `QueryResult.or(other: QueryPattern): QueryResult`

Exactly same as `new QueryResult(new Set(this).union(new Set(other)))`

#### `QueryResult.and(other: QueryPattern): QueryResult`

Exactly same as `new QueryResult(new Set(this).intersection(new Set(other)))`

#### `QueryResult.exclude(other: QueryPattern): QueryResult`

Exactly same as `new QueryResult(new Set(this).difference(new Set(other)))`

#### `QueryResult.select(childQueryPattern: QueryPattern): QueryResult`

Like `querySelectorAll`, do the sub query on each element and flatten the result.

#### `[Symbol.asyncIterator]`

Iterates over AST node of ts-morph, with captures.

```
interface QueryResultElement {
    node: AstNode;
    captures: Record<string, AstNode>;
    parent?: QueryResultElement;
    sourceFilePath: string;
}
```
