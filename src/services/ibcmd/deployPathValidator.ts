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

  try {
    if (fs.existsSync(baseDir)) {
      const canonicalRoot = fs.realpathSync.native ? fs.realpathSync.native(baseDir) : fs.realpathSync(baseDir);
      if (fs.existsSync(absoluteTarget)) {
        const canonicalTarget = fs.realpathSync.native ? fs.realpathSync.native(absoluteTarget) : fs.realpathSync(absoluteTarget);
        if (!isSameOrDescendantPath(canonicalRoot, canonicalTarget, platform)) {
          throw new PathBoundaryError('PATH_OUTSIDE_ROOT', `Файл по ссылке указывает за пределы конфигурации: ${filePath}`, filePath);
        }
      }
    }
  } catch (err) {
    if (err instanceof PathBoundaryError) {
      throw err;
    }
  }

  return normalized;
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
        const canonicalRoot = await fs.promises.realpath(path.resolve(configRoot)).catch(() => path.resolve(configRoot));
        const canonicalTarget = await canonicalizePathWithMissingSuffix(absoluteTarget).catch(() => absoluteTarget);
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
