import MagicString from 'magic-string';
import { parseSync } from 'oxc-parser';
import type { Selection } from './types.js';
import { isIncluded } from './query.js';

export interface TransformResult {
  code: string;
  map: ReturnType<InstanceType<typeof MagicString>['generateMap']>;
}

/** Minimal structural view of an oxc/ESTree node — enough to slice ranges. */
interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

/** A top-level import/declaration that is removed unless something reaches it. */
interface Candidate {
  node: Node;
  /** Value bindings this statement introduces. */
  names: string[];
  /** Names this statement references (only consulted once it is live). */
  refs: Set<string>;
  live?: boolean;
}

const LANG_BY_EXT: Record<string, 'js' | 'jsx' | 'ts' | 'tsx'> = {
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
};

function langOf(filename: string): 'js' | 'jsx' | 'ts' | 'tsx' {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  return LANG_BY_EXT[ext] ?? 'tsx';
}

/**
 * Strip the top-level exports the {@link Selection} excludes, then delete every
 * import and non-exported declaration that is no longer reachable from a
 * surviving export or top-level side effect.
 *
 * The reachability pass is what removes server-only code from a client `pick`:
 * once `loader` is gone, the `fs` import it alone used has no live reference and
 * is deleted here rather than left for the bundler (which keeps side-effectful
 * imports by default).
 *
 * Returns `null` when nothing changed (or the source is not a module).
 */
export function transform(
  filename: string,
  code: string,
  selection: Selection,
): TransformResult | null {
  const { program, errors } = parseSync(filename, code, {
    lang: langOf(filename),
    sourceType: 'module',
    range: true,
  });
  if (errors.length > 0 || program.sourceType !== 'module') return null;

  const ms = new MagicString(code);
  let changed = false;

  // Names reachable from surviving exports and top-level side effects.
  const used = new Set<string>();
  const candidates: Candidate[] = [];

  for (const node of program.body as unknown as Node[]) {
    switch (node.type) {
      case 'ImportDeclaration': {
        if (node.importKind === 'type') break; // `import type` — erased later.
        const specifiers = (node.specifiers ?? []) as Node[];
        const valueSpecifiers = specifiers.filter(
          (specifier) => specifier.importKind !== 'type',
        );
        // Bare `import './x'` (or all-type) imports are side effects — keep.
        if (valueSpecifiers.length === 0) break;
        const names = valueSpecifiers.map(
          (specifier) => (specifier.local as Node).name as string,
        );
        candidates.push({ node, names, refs: new Set() });
        break;
      }
      case 'FunctionDeclaration':
      case 'ClassDeclaration': {
        const name = (node.id as Node | undefined)?.name as string | undefined;
        if (name === undefined) {
          collectRefs(node, used);
          break;
        }
        const refs = new Set<string>();
        collectRefs(node, refs);
        candidates.push({ node, names: [name], refs });
        break;
      }
      case 'VariableDeclaration': {
        const names: string[] = [];
        for (const declarator of node.declarations as Node[]) {
          const id = declarator.id as Node;
          if (id.type === 'Identifier') names.push(id.name as string);
        }
        const refs = new Set<string>();
        collectRefs(node, refs);
        if (names.length === 0) {
          // Destructuring / pattern binding — cannot split it, treat as a root.
          for (const ref of refs) used.add(ref);
          break;
        }
        candidates.push({ node, names, refs });
        break;
      }
      case 'ExportDefaultDeclaration':
        if (isIncluded(selection, 'default')) {
          collectRefs((node.declaration as Node) ?? node, used);
        } else {
          ms.remove(node.start, node.end);
          changed = true;
        }
        break;
      case 'ExportNamedDeclaration':
        changed = applyNamedExport(ms, code, node, selection, used) || changed;
        break;
      default:
        // Side-effect statements, `export * from`, etc. — roots, never removed.
        collectRefs(node, used);
        break;
    }
  }

  // Mark-and-sweep: pull in any candidate a live reference reaches, to a
  // fixpoint (helper -> import chains take more than one round).
  for (let progress = true; progress; ) {
    progress = false;
    for (const candidate of candidates) {
      if (candidate.live) continue;
      if (candidate.names.some((name) => used.has(name))) {
        candidate.live = true;
        for (const ref of candidate.refs) used.add(ref);
        progress = true;
      }
    }
  }

  for (const candidate of candidates) {
    if (candidate.live) continue;
    ms.remove(candidate.node.start, candidate.node.end);
    changed = true;
  }

  if (!changed) return null;
  return { code: ms.toString(), map: ms.generateMap({ hires: true }) };
}

function applyNamedExport(
  ms: MagicString,
  code: string,
  node: Node,
  selection: Selection,
  used: Set<string>,
): boolean {
  if (node.exportKind === 'type') return false; // `export type { T }` — erased.

  const declaration = node.declaration as Node | null | undefined;
  if (declaration) {
    switch (declaration.type) {
      case 'FunctionDeclaration':
      case 'ClassDeclaration': {
        const id = declaration.id as Node | undefined;
        const name = id?.name as string | undefined;
        if (name !== undefined && !isIncluded(selection, name)) {
          ms.remove(node.start, node.end);
          return true;
        }
        collectRefs(declaration, used); // survives — keep what it references.
        return false;
      }
      case 'VariableDeclaration':
        return applyVariableExport(ms, code, node, declaration, selection, used);
      default:
        // `export type`, `export interface`, `export enum` — leave alone.
        return false;
    }
  }
  // `export { a, b as c }` or `export { a } from './x'`
  const specifiers = (node.specifiers ?? []) as Node[];
  if (specifiers.length === 0) return false;
  return applySpecifierList(ms, code, node, specifiers, selection, used);
}

function applyVariableExport(
  ms: MagicString,
  code: string,
  node: Node,
  declaration: Node,
  selection: Selection,
  used: Set<string>,
): boolean {
  const declarators = declaration.declarations as Node[];
  const kept: Node[] = [];
  let removedAny = false;
  for (const declarator of declarators) {
    const id = declarator.id as Node;
    if (id.type === 'Identifier' && !isIncluded(selection, id.name as string)) {
      removedAny = true;
    } else {
      kept.push(declarator);
    }
  }
  for (const declarator of kept) {
    collectRefs((declarator.init as Node) ?? declarator, used);
  }
  if (!removedAny) return false;
  if (kept.length === 0) {
    ms.remove(node.start, node.end);
    return true;
  }
  const kind = declaration.kind as string;
  const survivors = kept
    .map((declarator) => code.slice(declarator.start, declarator.end))
    .join(', ');
  ms.overwrite(node.start, node.end, `export ${kind} ${survivors};`);
  return true;
}

function applySpecifierList(
  ms: MagicString,
  code: string,
  node: Node,
  specifiers: Node[],
  selection: Selection,
  used: Set<string>,
): boolean {
  const source = node.source as Node | null | undefined;
  const kept: Node[] = [];
  let removedAny = false;
  for (const specifier of specifiers) {
    if (specifier.exportKind === 'type') {
      kept.push(specifier);
      continue;
    }
    const exported = specifier.exported as Node;
    const name =
      exported.type === 'Identifier'
        ? (exported.name as string)
        : (exported.value as string); // `export { x as 'str name' }`
    if (typeof name === 'string' && !isIncluded(selection, name)) {
      removedAny = true;
    } else {
      kept.push(specifier);
      // A local re-export keeps its local binding alive.
      const local = specifier.local as Node;
      if (!source && local?.type === 'Identifier') used.add(local.name as string);
    }
  }
  if (!removedAny) return false;
  if (kept.length === 0) {
    ms.remove(node.start, node.end);
    return true;
  }
  const survivors = kept
    .map((specifier) => code.slice(specifier.start, specifier.end))
    .join(', ');
  const from = source ? ` from ${code.slice(source.start, source.end)}` : '';
  ms.overwrite(node.start, node.end, `export { ${survivors} }${from};`);
  return true;
}

/**
 * Collect every identifier *referenced* within a subtree into `out`.
 *
 * Deliberately over-approximates (ignores scope/shadowing and counts type
 * positions): it may keep a binding that a precise analysis could drop, but it
 * never drops one that is still needed.
 */
function collectRefs(root: unknown, out: Set<string>): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    const record = node as Record<string, unknown>;
    const type = record.type;
    switch (type) {
      case 'Identifier':
      case 'JSXIdentifier':
        if (typeof record.name === 'string') out.add(record.name);
        continue;
      case 'MemberExpression':
        stack.push(record.object);
        if (record.computed) stack.push(record.property);
        continue;
      case 'Property':
      case 'PropertyDefinition':
      case 'MethodDefinition':
        if (record.computed) stack.push(record.key);
        stack.push(record.value);
        continue;
      case 'ImportSpecifier':
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
        continue; // import bindings, not references
      default:
        for (const key in record) {
          if (
            key === 'type' ||
            key === 'start' ||
            key === 'end' ||
            key === 'range' ||
            key === 'loc' ||
            key === 'parent'
          ) {
            continue;
          }
          stack.push(record[key]);
        }
    }
  }
}
