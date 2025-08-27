import { describe, it, expect, beforeEach } from 'vitest'
import { createProject, analyzeFile, findNodesOfKind, SyntaxKind } from '../index'
import { Project, SourceFile } from 'ts-morph'

describe('use-analysis', () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
  })

  describe('createProject', () => {
    it('should create a new Project instance', () => {
      const newProject = createProject()
      expect(newProject).toBeInstanceOf(Project)
    })

    it('should accept a tsconfig path', () => {
      const projectWithConfig = createProject('./tsconfig.json')
      expect(projectWithConfig).toBeInstanceOf(Project)
    })
  })

  describe('analyzeFile', () => {
    it('should add and return a source file', () => {
      const testCode = `
        function testFunction() {
          return "test";
        }
      `
      const sourceFile = project.createSourceFile('test.ts', testCode)
      expect(sourceFile).toBeInstanceOf(SourceFile)
      expect(sourceFile.getFullText()).toContain('testFunction')
    })
  })

  describe('findNodesOfKind', () => {
    it('should find nodes of specified kind', () => {
      const testCode = `
        function func1() {}
        function func2() {}
        const arrow = () => {};
      `
      const sourceFile = project.createSourceFile('test.ts', testCode)
      const functions = findNodesOfKind(sourceFile, SyntaxKind.FunctionDeclaration)
      
      expect(functions).toHaveLength(2)
    })

    it('should return empty array when no nodes found', () => {
      const testCode = `const x = 1;`
      const sourceFile = project.createSourceFile('test.ts', testCode)
      const functions = findNodesOfKind(sourceFile, SyntaxKind.FunctionDeclaration)
      
      expect(functions).toHaveLength(0)
    })
  })
})