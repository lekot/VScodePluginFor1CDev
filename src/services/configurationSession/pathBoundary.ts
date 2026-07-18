import * as fs from 'fs';
import * as path from 'path';

export type PathBoundaryErrorCode =
  | 'PATH_REQUIRED'
  | 'PATH_ABSOLUTE'
  | 'PATH_TRAVERSAL'
  | 'PATH_OUTSIDE_ROOT'
  | 'PATH_UNAVAILABLE';

export class PathBoundaryError extends Error {
  constructor(
    readonly code: PathBoundaryErrorCode,
    message: string,
    readonly targetPath?: string,
  ) {
    super(message);
    this.name = 'PathBoundaryError';
  }
}

/** Validates and normalizes a workspace-relative path without touching the filesystem. */
export function validateWorkspaceRelativePath(relativePath: string): string {
  const value = relativePath.trim();
  if (!value) {
    throw new PathBoundaryError('PATH_REQUIRED', 'Относительный путь не задан.');
  }
  if (
    value.includes('\0')
    || path.isAbsolute(value)
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || /^[a-zA-Z]:/.test(value)
  ) {
    throw new PathBoundaryError('PATH_ABSOLUTE', 'Абсолютный путь в привязке запрещён.', value);
  }

  const segments = value.replace(/\\/g, '/').split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new PathBoundaryError('PATH_TRAVERSAL', 'Путь с переходом в родительский каталог запрещён.', value);
  }

  const normalized = segments.filter((segment) => segment.length > 0 && segment !== '.').join('/');
  if (!normalized) {
    throw new PathBoundaryError('PATH_REQUIRED', 'Относительный путь не задан.', value);
  }
  return normalized;
}

/** Resolves an existing or not-yet-created target and proves its canonical parent stays in root. */
export async function assertPathWithinRoot(
  rootPath: string,
  targetPath: string,
): Promise<{ canonicalRoot: string; canonicalTarget: string }> {
  const absoluteRoot = path.resolve(rootPath);
  const absoluteTarget = path.resolve(targetPath);
  assertLexicallyInside(absoluteRoot, absoluteTarget);

  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.promises.realpath(absoluteRoot);
  } catch (error) {
    throw new PathBoundaryError(
      'PATH_UNAVAILABLE',
      `Не удалось канонизировать корень конфигурации: ${errorMessage(error)}`,
      rootPath,
    );
  }

  const canonicalTarget = await canonicalizeTarget(absoluteTarget);
  if (!isPathInside(canonicalRoot, canonicalTarget)) {
    throw new PathBoundaryError(
      'PATH_OUTSIDE_ROOT',
      `Путь выходит за границы конфигурации: ${targetPath}`,
      targetPath,
    );
  }
  return { canonicalRoot, canonicalTarget };
}

/**
 * Rechecks that every existing segment from the canonical root to the target parent
 * is a real directory. Call immediately before a namespace-changing operation.
 */
export async function assertNoSymlinkSegments(
  canonicalRoot: string,
  canonicalTarget: string,
): Promise<void> {
  if (!isPathInside(canonicalRoot, canonicalTarget)) {
    throw new PathBoundaryError('PATH_OUTSIDE_ROOT', `Path is outside configuration root: ${canonicalTarget}`);
  }
  const relativeParent = path.relative(canonicalRoot, path.dirname(canonicalTarget));
  let cursor = canonicalRoot;
  const segments = relativeParent === '' ? [] : relativeParent.split(path.sep);
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(cursor);
    } catch (error) {
      if (isMissingError(error)) {
        // Once a parent is absent, no deeper segment can exist yet. mkdir will
        // create the remaining lexical path under the last verified directory.
        break;
      }
      throw new PathBoundaryError(
        'PATH_UNAVAILABLE',
        `Unable to verify target parent ${cursor}: ${errorMessage(error)}`,
        canonicalTarget,
      );
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new PathBoundaryError(
        'PATH_OUTSIDE_ROOT',
        `Target path contains a non-directory or symbolic-link segment: ${cursor}`,
        canonicalTarget,
      );
    }
  }
}

/** Synchronous guard for legacy synchronous deploy path resolution. */
export function assertExistingPathWithinRootSync(
  rootPath: string,
  targetPath: string,
): { canonicalRoot: string; canonicalTarget: string } {
  const absoluteRoot = path.resolve(rootPath);
  const absoluteTarget = path.resolve(targetPath);
  assertLexicallyInside(absoluteRoot, absoluteTarget);
  try {
    const canonicalRoot = fs.realpathSync(absoluteRoot);
    const canonicalTarget = fs.realpathSync(absoluteTarget);
    if (!isPathInside(canonicalRoot, canonicalTarget)) {
      throw new PathBoundaryError(
        'PATH_OUTSIDE_ROOT',
        `Путь выходит за границы workspace: ${targetPath}`,
        targetPath,
      );
    }
    return { canonicalRoot, canonicalTarget };
  } catch (error) {
    if (error instanceof PathBoundaryError) {
      throw error;
    }
    throw new PathBoundaryError(
      'PATH_UNAVAILABLE',
      `Не удалось проверить путь: ${errorMessage(error)}`,
      targetPath,
    );
  }
}

export function isPathInside(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function canonicalizeTarget(targetPath: string): Promise<string> {
  return canonicalizeTargetFrom(targetPath, targetPath, []);
}

async function canonicalizeTargetFrom(
  originalTarget: string,
  cursor: string,
  missingSegments: string[],
): Promise<string> {
  try {
    const canonicalParent = await fs.promises.realpath(cursor);
    return path.join(canonicalParent, ...[...missingSegments].reverse());
  } catch (error) {
    if (!isMissingError(error)) {
      throw new PathBoundaryError(
        'PATH_UNAVAILABLE',
        `Не удалось канонизировать путь: ${errorMessage(error)}`,
        originalTarget,
      );
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new PathBoundaryError(
        'PATH_UNAVAILABLE',
        `Не найден существующий родитель: ${originalTarget}`,
        originalTarget,
      );
    }
    return canonicalizeTargetFrom(originalTarget, parent, [...missingSegments, path.basename(cursor)]);
  }
}

function assertLexicallyInside(rootPath: string, targetPath: string): void {
  if (!isPathInside(rootPath, targetPath)) {
    throw new PathBoundaryError(
      'PATH_OUTSIDE_ROOT',
      `Путь выходит за границы корня: ${targetPath}`,
      targetPath,
    );
  }
}

function isMissingError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
