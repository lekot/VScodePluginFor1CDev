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

/** Returns true when `filePath` is located under `dir` (case-insensitive on Windows). */
function isUnderDir(filePath: string, dir: string): boolean {
  // Normalise separators before comparing.
  const normalFile = filePath.replace(/\\/g, '/').toLowerCase();
  const normalDir = dir.replace(/\\/g, '/').toLowerCase();
  const prefix = normalDir.endsWith('/') ? normalDir : normalDir + '/';
  return normalFile.startsWith(prefix);
}

/**
 * Detects changed configuration files using the VS Code git repository state.
 *
 * @param configRoot - Absolute path to the configuration root directory.
 * @param deps - Dependency injection: provides access to the git repository.
 * @param options - Optional overrides for scope and file extension filter.
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
  },
): Promise<DetectedChanges | { error: string }> {
  const repo = deps.getGitRepository();
  if (!repo) {
    return { error: 'Git репозиторий не обнаружен для workspace.' };
  }

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

  for (const change of rawChanges) {
    const absPath = change.uri.fsPath;

    if (!isUnderDir(absPath, configRoot)) {
      skippedCount++;
      continue;
    }

    const ext = path.extname(absPath).toLowerCase();
    if (!extensions.has(ext)) {
      skippedCount++;
      continue;
    }

    absolutePaths.push(absPath);
    relativePaths.push(path.relative(configRoot, absPath).replace(/\\/g, '/'));
  }

  return {
    absolutePaths,
    relativePaths,
    source,
    skippedCount,
  };
}
