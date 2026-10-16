import * as fs from 'fs';
import * as path from 'path';
import { isSameOrDescendantPath } from '../../utils/configurationPathIdentity';
import {
  PathBoundaryError,
  validateWorkspaceRelativePath,
  canonicalizePathWithMissingSuffix,
} from '../configurationSession/pathBoundary';

/**
 * Validates that a single relative file path stays strictly inside baseDir,
 * has no directory traversal, is not absolute, and does not escape canonical root via symlinks.
 * Throws PathBoundaryError if invalid.
 */
export function assertDeployFilePathWithinBase(
  filePath: string,
  baseDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = validateWorkspaceRelativePath(filePath);
  const p = platform === 'win32' ? path.win32 : path.posix;
  const absoluteTarget = p.resolve(baseDir, normalized);

  if (!isSameOrDescendantPath(baseDir, absoluteTarget, platform)) {
    throw new PathBoundaryError('PATH_OUTSIDE_ROOT', `Файл выходит за границы корня конфигурации: ${filePath}`, filePath);
  }

  if (fs.existsSync(baseDir)) {
    let canonicalRoot: string;
    try {
      canonicalRoot = fs.realpathSync.native ? fs.realpathSync.native(baseDir) : fs.realpathSync(baseDir);
    } catch (err) {
      throw new PathBoundaryError(
        'PATH_UNAVAILABLE',
        `Не удалось проверить канонический корень конфигурации: ${err instanceof Error ? err.message : String(err)}`,
        baseDir,
      );
    }

    const canonicalTarget = canonicalizePathWithMissingSuffixSync(absoluteTarget);
    if (!isSameOrDescendantPath(canonicalRoot, canonicalTarget, platform)) {
      throw new PathBoundaryError('PATH_OUTSIDE_ROOT', `Файл по ссылке указывает за пределы конфигурации: ${filePath}`, filePath);
    }
  }

  return normalized;
}

/**
 * Resolves an existing path or its nearest existing ancestor synchronously, preserving missing suffix.
 * Fails closed on permissions (EACCES) or loop (ELOOP) errors with PathBoundaryError.
 */
export function canonicalizePathWithMissingSuffixSync(targetPath: string): string {
  return canonicalizeTargetFromSync(path.resolve(targetPath), path.resolve(targetPath), []);
}

function canonicalizeTargetFromSync(originalTarget: string, cursor: string, missingSegments: string[]): string {
  try {
    const canonicalParent = fs.realpathSync.native ? fs.realpathSync.native(cursor) : fs.realpathSync(cursor);
    return path.join(canonicalParent, ...[...missingSegments].reverse());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw new PathBoundaryError(
        'PATH_UNAVAILABLE',
        `Не удалось проверить путь: ${error instanceof Error ? error.message : String(error)}`,
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
    return canonicalizeTargetFromSync(originalTarget, parent, [...missingSegments, path.basename(cursor)]);
  }
}

/**
 * Validates an array of relative file paths against configRoot.
 * Returns { ok: true, validatedFiles } or { ok: false, error }.
 */
export async function validateDeployRelativeFiles(
  configRoot: string,
  relativeFiles: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<{ ok: true; validatedFiles: string[] } | { ok: false; error: string }> {
  if (relativeFiles.length === 0) {
    return { ok: true, validatedFiles: [] };
  }

  const validatedFiles: string[] = [];
  for (const f of relativeFiles) {
    try {
      const normalized = validateWorkspaceRelativePath(f);
      const p = platform === 'win32' ? path.win32 : path.posix;
      const absoluteTarget = p.resolve(configRoot, normalized);

      if (!isSameOrDescendantPath(configRoot, absoluteTarget, platform)) {
        return { ok: false, error: `Файл выходит за границы корня конфигурации: ${f}` };
      }

      if (fs.existsSync(configRoot)) {
        let canonicalRoot: string;
        try {
          canonicalRoot = await fs.promises.realpath(path.resolve(configRoot));
        } catch (err) {
          return {
            ok: false,
            error: `Не удалось проверить канонический корень конфигурации: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        let canonicalTarget: string;
        try {
          canonicalTarget = await canonicalizePathWithMissingSuffix(absoluteTarget);
        } catch (err) {
          return {
            ok: false,
            error: `Не удалось проверить путь файла: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        if (!isSameOrDescendantPath(canonicalRoot, canonicalTarget, platform)) {
          return { ok: false, error: `Файл по ссылке указывает за пределы конфигурации: ${f}` };
        }
      }

      validatedFiles.push(normalized);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  return { ok: true, validatedFiles };
}
