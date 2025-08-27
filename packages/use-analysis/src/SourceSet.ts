import { Project, SourceFile, ts } from 'ts-morph'
import glob from 'fast-glob'

export type GlobPattern = string

export interface SourceSetConfig {
  patterns: GlobPattern | GlobPattern[]
  tsConfig?: string | ts.CompilerOptions
}

export const RECOMMENDED_TSCONFIG: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  allowJs: true,
  checkJs: false,
  jsx: ts.JsxEmit.React,
  strict: false,
  skipLibCheck: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  resolveJsonModule: true,
  isolatedModules: false,
  noEmit: true,
}

export class SourceSet {
  private project: Project
  private patterns: GlobPattern[]
  private sourceFiles: Map<string, SourceFile> = new Map()
  private sourceFilesArray: SourceFile[] | null = null
  private filesLoaded = false

  constructor(config: string | GlobPattern[] | SourceSetConfig) {
    if (typeof config === 'string') {
      this.patterns = [config]
      this.project = this.createProject()
    } else if (Array.isArray(config)) {
      this.patterns = config
      this.project = this.createProject()
    } else {
      this.patterns = Array.isArray(config.patterns) 
        ? config.patterns 
        : [config.patterns]
      this.project = this.createProject(config.tsConfig)
    }
  }

  private createProject(tsConfig?: string | ts.CompilerOptions): Project {
    if (typeof tsConfig === 'string') {
      return new Project({
        tsConfigFilePath: tsConfig,
        skipAddingFilesFromTsConfig: false,
      })
    } else {
      return new Project({
        compilerOptions: tsConfig || RECOMMENDED_TSCONFIG,
        skipAddingFilesFromTsConfig: true,
      })
    }
  }

  private async loadFiles(): Promise<void> {
    if (this.filesLoaded) return

    const filePaths = await glob(this.patterns, {
      absolute: true,
      onlyFiles: true,
      unique: true,
    })

    for (const filePath of filePaths) {
      const sourceFile = this.project.addSourceFileAtPath(filePath)
      this.sourceFiles.set(filePath, sourceFile)
    }

    this.sourceFilesArray = Array.from(this.sourceFiles.values())
    this.filesLoaded = true
  }

  async getSourceFiles(): Promise<SourceFile[]> {
    await this.loadFiles()
    return this.sourceFilesArray!
  }

  async getSourceFile(filePath: string): Promise<SourceFile | undefined> {
    await this.loadFiles()
    return this.sourceFiles.get(filePath)
  }

  getProject(): Project {
    return this.project
  }

  getPatternsUsed(): GlobPattern[] {
    return [...this.patterns]
  }
}