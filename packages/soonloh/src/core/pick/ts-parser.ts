import { parse, type ParseResult } from '@babel/parser';
import * as t from '@babel/types';
import { readFile } from 'node:fs/promises';


/**
 * Analyzes TypeScript file to find exported types
 */
export class TypeScriptParser {
  private cache = new Map<string, Set<string>>();

  /**
   * Get all exported type names from a TypeScript file
   */
  async getExportedTypes(filePath: string): Promise<Set<string>> {
    if (this.cache.has(filePath)) {
      return this.cache.get(filePath)!;
    }

    try {
      const content = await readFile(filePath, 'utf-8');
      const ast = parse(content, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx', 'decorators-legacy'],
      });

      const exportedTypes = new Set<string>();

      // Traverse AST to find exported types
      for (const node of (ast as t.File).program.body) {
        if (t.isExportNamedDeclaration(node)) {
          // Handle direct exports like: export type Foo = ...
          if (node.declaration) {
            if (t.isTSTypeAliasDeclaration(node.declaration)) {
              exportedTypes.add(node.declaration.id.name);
            } else if (t.isTSInterfaceDeclaration(node.declaration)) {
              exportedTypes.add(node.declaration.id.name);
            } else if (t.isVariableDeclaration(node.declaration)) {
              // export const foo = ...
              for (const declarator of node.declaration.declarations) {
                if (t.isIdentifier(declarator.id)) {
                  exportedTypes.add(declarator.id.name);
                }
              }
            } else if (
              t.isFunctionDeclaration(node.declaration) &&
              node.declaration.id
            ) {
              exportedTypes.add(node.declaration.id.name);
            } else if (
              t.isClassDeclaration(node.declaration) &&
              node.declaration.id
            ) {
              exportedTypes.add(node.declaration.id.name);
            }
          }

          // Handle export specifiers like: export { Type }
          if (node.specifiers) {
            for (const specifier of node.specifiers) {
              if (
                t.isExportSpecifier(specifier) &&
                t.isIdentifier(specifier.exported)
              ) {
                exportedTypes.add(specifier.exported.name);
              }
            }
          }
        } else if (t.isExportDefaultDeclaration(node)) {
          // Handle default exports - only add 'default', not the original name
          exportedTypes.add('default');
        }
      }

      this.cache.set(filePath, exportedTypes);
      return exportedTypes;
    } catch (error) {
      console.warn(`Failed to parse TypeScript file ${filePath}:`, error);
      return new Set();
    }
  }

  /**
   * Check if a specific type is exported from a file
   */
  async isTypeExported(filePath: string, typeName: string): Promise<boolean> {
    const exportedTypes = await this.getExportedTypes(filePath);
    return exportedTypes.has(typeName);
  }

  /**
   * Clear cache for a specific file (useful when file changes)
   */
  invalidateCache(filePath?: string) {
    if (filePath) {
      this.cache.delete(filePath);
    } else {
      this.cache.clear();
    }
  }
}

// Global parser instance
export const tsParser = new TypeScriptParser();
