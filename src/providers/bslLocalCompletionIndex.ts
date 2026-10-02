import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { readExtensionName } from '../debug/moduleIdResolver';
import { METADATA_TYPE_DESCRIPTORS } from '../constants/metadataTypeDescriptors';
import { parseBslRoutines } from '../bsl/routineRangeProvider';
import type { BslRoutineKind } from '../bsl/bslRoutineTypes';

const MAX_SOURCE_BYTES = 1_048_576;
const MAX_DOCUMENT_LINES = 20_000;
const MAX_DOCUMENT_CACHE_ENTRIES = 32;
const MAX_MODULE_CACHE_ENTRIES = 32;
const MAX_ROOTS = 4;
const MAX_CANDIDATE_PATHS = 8;
const MAX_ANCESTORS = 16;
const DOCUMENT_REFRESH_INTERVAL_MS = 500;
const IDENTIFIER_RE = /^[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*$/u;

const DESIGNER_MODULE_DIRECTORY_NAMES = new Set(
  METADATA_TYPE_DESCRIPTORS.map(({ designerFolder }) => designerFolder),
);

export interface BslLocalRoutineCandidate {
  readonly name: string;
  readonly kind: BslRoutineKind;
  readonly exported: boolean;
  readonly parameterText: string;
}

export interface BslLocalCompletionFileStat {
  readonly isFile: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface BslLocalCompletionIndexDependencies {
  readonly getWorkspaceRoots?: () => readonly string[];
  readonly statFile?: (filePath: string) => Promise<BslLocalCompletionFileStat | undefined>;
  readonly readFile?: (filePath: string) => Promise<string>;
  readonly now?: () => number;
  readonly readExtensionName?: (configRoot: string) => Promise<string>;
}

interface DocumentRoutineCacheEntry {
  readonly version: number;
  readonly parsedAt: number;
  readonly routines: readonly BslLocalRoutineCandidate[];
}

interface ModuleRoutineCacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly routines: readonly BslLocalRoutineCandidate[];
}

interface CandidateRootCacheEntry {
  readonly workspaceSignature: string;
  readonly roots: readonly string[];
}

const defaultStatFile = async (filePath: string): Promise<BslLocalCompletionFileStat | undefined> => {
  try {
    const stat = await fs.promises.stat(filePath);
    return { isFile: stat.isFile(), size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
};

const defaultReadFile = (filePath: string): Promise<string> => fs.promises.readFile(filePath, 'utf8');

function normalizePath(filePath: string): string {
  return path.resolve(filePath);
}

function routineCandidates(source: string): readonly BslLocalRoutineCandidate[] {
  return parseBslRoutines(source).routines.map(({ name, kind, exported, parameterText }) => ({
    name,
    kind,
    exported,
    parameterText,
  }));
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function exceedsCurrentDocumentBudget(document: vscode.TextDocument): boolean {
  const lineCount = document.lineCount;
  if (Number.isInteger(lineCount) && lineCount > MAX_DOCUMENT_LINES) {
    return true;
  }
  if (Number.isInteger(lineCount) && lineCount < 1) {
    return true;
  }
  if (typeof document.offsetAt !== 'function') {
    return true;
  }
  const finalLine = Number.isInteger(lineCount) ? lineCount - 1 : Number.MAX_SAFE_INTEGER;
  try {
    const finalPosition = new vscode.Position(finalLine, Number.MAX_SAFE_INTEGER);
    return document.offsetAt(finalPosition) > MAX_SOURCE_BYTES;
  } catch {
    return true;
  }
}

/**
 * Holds a small, lazy cache of routines in the current document and exact local CommonModule files.
 * It never enumerates workspace directories and never starts an external process.
 */
export class BslLocalCompletionIndex {
  private readonly documentRoutines = new Map<string, DocumentRoutineCacheEntry>();
  private readonly moduleRoutines = new Map<string, ModuleRoutineCacheEntry>();
  private readonly rootsByDocument = new Map<string, CandidateRootCacheEntry>();
  private readonly extensionNamesByRoot = new Map<string, Promise<string>>();
  private readonly statFile: (filePath: string) => Promise<BslLocalCompletionFileStat | undefined>;
  private readonly readFile: (filePath: string) => Promise<string>;
  private readonly getWorkspaceRoots: () => readonly string[];
  private readonly now: () => number;
  private readonly readExtensionName: (configRoot: string) => Promise<string>;

  constructor(dependencies: BslLocalCompletionIndexDependencies = {}) {
    this.statFile = dependencies.statFile ?? defaultStatFile;
    this.readFile = dependencies.readFile ?? defaultReadFile;
    this.getWorkspaceRoots = dependencies.getWorkspaceRoots ?? (() =>
      (vscode.workspace.workspaceFolders ?? []).map(({ uri }) => uri.fsPath));
    this.now = dependencies.now ?? Date.now;
    this.readExtensionName = dependencies.readExtensionName ?? readExtensionName;
  }

  /**
   * Returns all procedures/functions from the current unsaved document.
   * A changed document is reparsed on its first request after the 500 ms refresh interval.
   */
  getCurrentDocumentRoutines(document: vscode.TextDocument): readonly BslLocalRoutineCandidate[] {
    const identity = this.documentIdentity(document);
    if (!identity || !Number.isInteger(document.version)) {
      return [];
    }

    const currentTime = this.now();
    if (exceedsCurrentDocumentBudget(document)) {
      this.setBounded(this.documentRoutines, identity, {
        version: document.version,
        parsedAt: currentTime,
        routines: [],
      }, MAX_DOCUMENT_CACHE_ENTRIES);
      return [];
    }

    const cached = this.documentRoutines.get(identity);
    if (cached?.version === document.version) {
      this.touch(this.documentRoutines, identity, cached);
      return cached.routines;
    }
    if (cached && document.version > cached.version && currentTime - cached.parsedAt < DOCUMENT_REFRESH_INTERVAL_MS) {
      this.touch(this.documentRoutines, identity, cached);
      return cached.routines;
    }

    let routines: readonly BslLocalRoutineCandidate[] = [];
    try {
      const source = document.getText();
      if (Buffer.byteLength(source, 'utf8') <= MAX_SOURCE_BYTES) {
        routines = routineCandidates(source);
      }
    } catch {
      // A partially disposed or synthetic document should not interrupt platform completion.
    }
    this.setBounded(this.documentRoutines, identity, {
      version: document.version,
      parsedAt: currentTime,
      routines,
    }, MAX_DOCUMENT_CACHE_ENTRIES);
    return routines;
  }

  /**
   * Reads one exact CommonModules/<name> source file and returns only exported routines.
   * Designer and CFE roots use either CommonModules/<name>/Ext/Module.bsl or the nested
   * Ext/Module/Module.bsl layout; EDT roots use src/CommonModules/<name>/Module.bsl.
   * At most eight exact module paths are checked, with roots ordered by current configuration
   * and CFE precedence.
   */
  async getCommonModuleRoutines(
    document: vscode.TextDocument,
    moduleName: string,
    token?: vscode.CancellationToken,
  ): Promise<readonly BslLocalRoutineCandidate[]> {
    if (!IDENTIFIER_RE.test(moduleName) || token?.isCancellationRequested) {
      return [];
    }

    const candidatePaths = await this.getCandidatePaths(document, moduleName);
    if (token?.isCancellationRequested) {
      return [];
    }
    for (const candidatePath of candidatePaths) {
      if (token?.isCancellationRequested) {
        return [];
      }
      const stat = await this.statFile(candidatePath);
      if (!stat?.isFile) {
        continue;
      }
      if (stat.size > MAX_SOURCE_BYTES) {
        this.moduleRoutines.delete(candidatePath);
        return [];
      }

      const cached = this.moduleRoutines.get(candidatePath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        this.touch(this.moduleRoutines, candidatePath, cached);
        return cached.routines;
      }

      let routines: readonly BslLocalRoutineCandidate[];
      try {
        const source = await this.readFile(candidatePath);
        if (token?.isCancellationRequested) {
          return [];
        }
        if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
          this.moduleRoutines.delete(candidatePath);
          return [];
        }
        routines = routineCandidates(source).filter(({ exported }) => exported);
      } catch {
        this.moduleRoutines.delete(candidatePath);
        continue;
      }

      this.setBounded(this.moduleRoutines, candidatePath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        routines,
      }, MAX_MODULE_CACHE_ENTRIES);
      return routines;
    }
    return [];
  }

  private documentIdentity(document: vscode.TextDocument): string | undefined {
    const uri = document.uri;
    if (!uri || uri.scheme !== 'file' || !uri.fsPath) {
      return undefined;
    }
    return normalizePath(uri.fsPath);
  }

  private async getCandidatePaths(document: vscode.TextDocument, moduleName: string): Promise<readonly string[]> {
    const identity = this.documentIdentity(document);
    if (!identity) {
      return [];
    }
    const workspaceRoots = this.getWorkspaceRoots()
      .filter((root): root is string => typeof root === 'string' && root.length > 0)
      .map(normalizePath);
    const workspaceSignature = workspaceRoots.join(path.delimiter);
    const cached = this.rootsByDocument.get(identity);
    let orderedRoots: readonly string[];
    if (cached?.workspaceSignature === workspaceSignature) {
      this.touch(this.rootsByDocument, identity, cached);
      orderedRoots = cached.roots;
    } else {
      const currentRoot = this.configurationRootForDocument(identity, workspaceRoots);
      const roots = [...new Set([
        ...(currentRoot ? [currentRoot] : []),
        ...workspaceRoots,
      ])].slice(0, MAX_ROOTS);
      const extensionNames = await Promise.all(roots.map((root) => this.extensionNameForRoot(root)));
      const currentIndex = currentRoot
        ? roots.findIndex((root) => normalizePath(root) === normalizePath(currentRoot))
        : -1;
      const currentIsExtension = currentIndex >= 0 && extensionNames[currentIndex] !== '';
      const extensionRoots = roots.filter((_root, index) => extensionNames[index] !== '' && index !== currentIndex);
      const regularRoots = roots.filter((_root, index) => extensionNames[index] === '' && index !== currentIndex);
      orderedRoots = [
        ...(currentIsExtension && currentRoot ? [currentRoot] : []),
        ...extensionRoots,
        ...(!currentIsExtension && currentRoot ? [currentRoot] : []),
        ...regularRoots,
      ].slice(0, MAX_ROOTS);
      this.setBounded(this.rootsByDocument, identity, { workspaceSignature, roots: orderedRoots }, MAX_DOCUMENT_CACHE_ENTRIES);
    }
    return orderedRoots.flatMap((root) => [
      path.join(root, 'CommonModules', moduleName, 'Ext', 'Module.bsl'),
      path.join(root, 'CommonModules', moduleName, 'Ext', 'Module', 'Module.bsl'),
      path.join(root, 'src', 'CommonModules', moduleName, 'Module.bsl'),
    ]).slice(0, MAX_CANDIDATE_PATHS);
  }

  private configurationRootForDocument(documentPath: string, workspaceRoots: readonly string[]): string | undefined {
    const workspaceRoot = workspaceRoots
      .filter((root) => isWithin(root, documentPath))
      .sort((left, right) => right.length - left.length)[0];
    let directory = path.dirname(documentPath);
    for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
      const baseName = path.basename(directory);
      if (baseName === 'CommonModules' || DESIGNER_MODULE_DIRECTORY_NAMES.has(baseName)) {
        const previous = path.dirname(directory);
        return path.basename(previous) === 'src' ? path.dirname(previous) : previous;
      }
      if (directory === workspaceRoot || path.dirname(directory) === directory) {
        break;
      }
      directory = path.dirname(directory);
    }
    return workspaceRoot;
  }

  private extensionNameForRoot(root: string): Promise<string> {
    const normalized = normalizePath(root);
    const existing = this.extensionNamesByRoot.get(normalized);
    if (existing) {
      return existing;
    }
    const loading = this.readExtensionName(normalized).catch(() => '');
    this.setBounded(this.extensionNamesByRoot, normalized, loading, MAX_DOCUMENT_CACHE_ENTRIES);
    return loading;
  }

  private touch<K, V>(map: Map<K, V>, key: K, value: V): void {
    map.delete(key);
    map.set(key, value);
  }

  private setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
    this.touch(map, key, value);
    while (map.size > limit) {
      const oldest = map.keys().next().value as K | undefined;
      if (oldest === undefined) {
        return;
      }
      map.delete(oldest);
    }
  }
}
