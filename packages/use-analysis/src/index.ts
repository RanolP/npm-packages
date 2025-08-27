import { Project, SourceFile, Node, SyntaxKind } from 'ts-morph'

export { Project, SourceFile, Node, SyntaxKind } from 'ts-morph'
export { SourceSet, GlobPattern, SourceSetConfig, RECOMMENDED_TSCONFIG } from './SourceSet'

export function createProject(tsConfigFilePath?: string): Project {
  return new Project({
    tsConfigFilePath,
    skipAddingFilesFromTsConfig: tsConfigFilePath === undefined,
  })
}

export function analyzeFile(project: Project, filePath: string): SourceFile {
  return project.addSourceFileAtPath(filePath)
}

export function findNodesOfKind<T extends Node>(
  sourceFile: SourceFile,
  kind: SyntaxKind
): T[] {
  return sourceFile.getDescendantsOfKind(kind) as T[]
}