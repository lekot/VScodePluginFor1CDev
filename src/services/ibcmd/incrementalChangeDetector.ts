/**
 * Commit 4 — Git-based change detector.
 *
 * Detects configuration files that have been modified according to the VS Code git
 * extension, so that an incremental ibcmd `import files` can target only the
 * dirty subset of the configuration tree.
 *
 * Does NOT import vscode directly — all VS Code types are declared locally to keep
 * the module unit-testable without the full extension host.
 */

import * as path from 'path';
import { isSameOrDescendantPath } from '../../utils/configurationPathIdentity';

// ---------------------------------------------------------------------------
// Minimal local interfaces that mirror the VS Code built-in git extension API.
// Same approach as src/services/gitIntegration.ts — no @types/vscode-git dep.
// ---------------------------------------------------------------------------

interface GitChange {
  readonly uri: { readonly fsPath: string };
}

interface GitRepositoryState {
  readonly workingTreeChanges: readonly GitChange[];
  readonly indexChanges: readonly GitChange[];
  readonly mergeChanges: readonly GitChange[];
}

/** Minimal shape of a git repository exposed by the built-in vscode.git extension. */
export interface GitRepository {
  readonly rootUri: { readonly fsPath: string };
  readonly state: GitRepositoryState;
}

/**
 * Finds the deepest/most specific Git repository containing targetPath.
 * Respects platform case sensitivity and path segment boundaries.
 * Returns undefined if targetPath does not belong to any repository (no arbitrary fallback).
 */
export function findDeepestContainingRepository<T extends { readonly rootUri: { readonly fsPath: string } }>(
  repositories: readonly T[] | undefined,
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
): T | undefined {
  if (!repositories || repositories.length === 0 || !targetPath) {
    return undefined;
  }

  let bestRepo: T | undefined;
  for (const repo of repositories) {
    const repoRoot = repo?.rootUri?.fsPath;
    if (!repoRoot) {
      continue;
    }
    if (isSameOrDescendantPath(repoRoot, targetPath, platform)) {
      if (!bestRepo) {
        bestRepo = repo;
      } else if (isSameOrDescendantPath(bestRepo.rootUri.fsPath, repoRoot, platform)) {
        bestRepo = repo;
      }
    }
  }

  return bestRepo;
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * Dependency injection interface for the change detector.
 *
 * In production the caller provides a closure over
 * `vscode.extensions.getExtension('vscode.git')?.exports?.getAPI(1)`.
 * In tests a stub object is passed instead.
 */
export interface IncrementalChangeDetectorDeps {
  getGitRepository(): GitRepository | undefined;
}

/** The set of changed config files detected by the git repository state. */
export interface DetectedChanges {
  /** Absolute file-system paths of changed files that are inside configRoot. */
  readonly absolutePaths: readonly string[];
  /** Paths relative to configRoot, normalised to forward slashes. */
  readonly relativePaths: readonly string[];
  /** Which git change set was used as the source. */
  readonly source: 'git-working-tree' | 'git-staged' | 'git-head-diff';
  /** Number of changed files that were outside configRoot or had a filtered extension. */
  readonly skippedCount: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_EXTENSIONS = ['.xml', '.bsl', '.os'];

/** Returns true when `filePath` is located strictly inside `dir` (platform-aware). */
function isDescendantOfDir(filePath: string, dir: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const rel = p.relative(dir, filePath);
  if (rel === '' || rel === '.' || rel.startsWith('..') || p.isAbsolute(rel)) {
    return false;
  }
  return isSameOrDescendantPath(dir, filePath, platform);
}

/**
 * Detects changed configuration files using the VS Code git repository state.
 *
 * @param configRoot - Absolute path to the configuration root directory.
 * @param deps - Dependency injection: provides access to the git repository.
 * @param options - Optional overrides for scope, file extension filter, and platform.
 * @returns `DetectedChanges` on success, or `{ error: string }` when detection fails.
 */
export async function detectChangedConfigFiles(
  configRoot: string,
  deps: IncrementalChangeDetectorDeps,
  options?: {
    /** Which git change set to examine. Defaults to 'working'. */
    scope?: 'working' | 'staged' | 'head';
    /** File extensions to include. Defaults to ['.xml', '.bsl', '.os']. */
    extensions?: string[];
    /** Platform semantics override for containment checks. Defaults to host platform. */
    platform?: NodeJS.Platform;
  },
): Promise<DetectedChanges | { error: string }> {
  const repo = deps.getGitRepository();
  if (!repo) {
    return { error: 'Git репозиторий не обнаружен для workspace.' };
  }

  const platform = options?.platform ?? process.platform;
  const scope = options?.scope ?? 'working';

  if (scope === 'head') {
    return { error: 'Режим scope=head не поддерживается в текущей версии.' };
  }

  let rawChanges: readonly GitChange[];
  let source: DetectedChanges['source'];

  if (scope === 'staged') {
    rawChanges = repo.state.indexChanges;
    source = 'git-staged';
  } else {
    // 'working': union of working-tree changes and merge conflicts
    const combined = [
      ...repo.state.workingTreeChanges,
      ...repo.state.mergeChanges,
    ];
    rawChanges = combined;
    source = 'git-working-tree';
  }

  const extensions = new Set(
    (options?.extensions ?? DEFAULT_EXTENSIONS).map((e) => e.toLowerCase()),
  );

  const absolutePaths: string[] = [];
  const relativePaths: string[] = [];
  let skippedCount = 0;
  const p = platform === 'win32' ? path.win32 : path.posix;

  for (const change of rawChanges) {
    const absPath = change.uri.fsPath;

    if (!isDescendantOfDir(absPath, configRoot, platform)) {
      skippedCount++;
      continue;
    }

    const ext = path.extname(absPath).toLowerCase();
    if (!extensions.has(ext)) {
      skippedCount++;
      continue;
    }

    const rel = p.relative(configRoot, absPath).replace(/\\/g, '/');
    if (rel === '' || rel.startsWith('../') || rel === '..' || p.isAbsolute(rel)) {
      skippedCount++;
      continue;
    }

    absolutePaths.push(absPath);
    relativePaths.push(rel);
  }

  return {
    absolutePaths,
    relativePaths,
    source,
    skippedCount,
  };
}
