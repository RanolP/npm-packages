import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SourceSet, RECOMMENDED_TSCONFIG } from '../SourceSet'
import { ts } from 'ts-morph'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('SourceSet', () => {
  let testDir: string

  beforeAll(() => {
    testDir = join(tmpdir(), `use-analysis-test-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })

    writeFileSync(join(testDir, 'file1.ts'), 'const a = 1;')
    writeFileSync(join(testDir, 'file2.js'), 'const b = 2;')
    writeFileSync(join(testDir, 'file3.tsx'), 'const c = <div>3</div>;')
    
    mkdirSync(join(testDir, 'nested'), { recursive: true })
    writeFileSync(join(testDir, 'nested', 'file4.ts'), 'const d = 4;')
  })

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  describe('constructor', () => {
    it('should accept a string pattern', () => {
      const sourceSet = new SourceSet(`${testDir}/*.ts`)
      expect(sourceSet.getPatternsUsed()).toEqual([`${testDir}/*.ts`])
    })

    it('should accept an array of patterns', () => {
      const patterns = [`${testDir}/*.ts`, `${testDir}/*.js`]
      const sourceSet = new SourceSet(patterns)
      expect(sourceSet.getPatternsUsed()).toEqual(patterns)
    })

    it('should accept a config object with single pattern', () => {
      const sourceSet = new SourceSet({
        patterns: `${testDir}/*.ts`,
      })
      expect(sourceSet.getPatternsUsed()).toEqual([`${testDir}/*.ts`])
    })

    it('should accept a config object with array of patterns', () => {
      const patterns = [`${testDir}/*.ts`, `${testDir}/*.js`]
      const sourceSet = new SourceSet({
        patterns,
      })
      expect(sourceSet.getPatternsUsed()).toEqual(patterns)
    })

    it('should accept a config object with tsconfig path', () => {
      const sourceSet = new SourceSet({
        patterns: `${testDir}/*.ts`,
        tsConfig: './tsconfig.json',
      })
      expect(sourceSet.getPatternsUsed()).toEqual([`${testDir}/*.ts`])
    })

    it('should accept a config object with compiler options', () => {
      const sourceSet = new SourceSet({
        patterns: `${testDir}/*.ts`,
        tsConfig: { target: ts.ScriptTarget.ES2020 },
      })
      expect(sourceSet.getPatternsUsed()).toEqual([`${testDir}/*.ts`])
    })

    it('should use RECOMMENDED_TSCONFIG when no tsConfig provided', () => {
      const sourceSet = new SourceSet(`${testDir}/*.ts`)
      const project = sourceSet.getProject()
      const compilerOptions = project.getCompilerOptions()
      expect(compilerOptions.target).toBe(RECOMMENDED_TSCONFIG.target)
      expect(compilerOptions.jsx).toBe(RECOMMENDED_TSCONFIG.jsx)
    })
  })

  describe('getSourceFiles', () => {
    it('should load files matching the pattern', async () => {
      const sourceSet = new SourceSet(`${testDir}/*.ts`)
      const files = await sourceSet.getSourceFiles()
      expect(files).toHaveLength(1)
      expect(files[0].getFilePath()).toContain('file1.ts')
    })

    it('should load files matching multiple patterns', async () => {
      const sourceSet = new SourceSet([`${testDir}/*.ts`, `${testDir}/*.js`])
      const files = await sourceSet.getSourceFiles()
      expect(files).toHaveLength(2)
      const filePaths = files.map(f => f.getFilePath())
      expect(filePaths.some(p => p.includes('file1.ts'))).toBe(true)
      expect(filePaths.some(p => p.includes('file2.js'))).toBe(true)
    })

    it('should load files recursively with glob pattern', async () => {
      const sourceSet = new SourceSet(`${testDir}/**/*.ts`)
      const files = await sourceSet.getSourceFiles()
      expect(files).toHaveLength(2)
      const filePaths = files.map(f => f.getFilePath())
      expect(filePaths.some(p => p.includes('file1.ts'))).toBe(true)
      expect(filePaths.some(p => p.includes('file4.ts'))).toBe(true)
    })

    it('should cache loaded files', async () => {
      const sourceSet = new SourceSet(`${testDir}/*.ts`)
      const files1 = await sourceSet.getSourceFiles()
      const files2 = await sourceSet.getSourceFiles()
      expect(files1).toBe(files2)
    })
  })

  describe('getSourceFile', () => {
    it('should return a specific source file if loaded', async () => {
      const sourceSet = new SourceSet(`${testDir}/*.ts`)
      const filePath = join(testDir, 'file1.ts')
      const file = await sourceSet.getSourceFile(filePath)
      expect(file).toBeDefined()
      expect(file?.getFilePath()).toBe(filePath)
    })

    it('should return undefined for files not matching pattern', async () => {
      const sourceSet = new SourceSet(`${testDir}/*.ts`)
      const filePath = join(testDir, 'file2.js')
      const file = await sourceSet.getSourceFile(filePath)
      expect(file).toBeUndefined()
    })
  })

  describe('getProject', () => {
    it('should return the ts-morph Project instance', () => {
      const sourceSet = new SourceSet(`${testDir}/*.ts`)
      const project = sourceSet.getProject()
      expect(project).toBeDefined()
      expect(project.getCompilerOptions).toBeDefined()
    })
  })
})