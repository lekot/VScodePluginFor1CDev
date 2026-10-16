import * as fs from 'fs';
import * as path from 'path';

/**
 * Returns the canonical filesystem path on the host platform, resolving 8.3 short names and symlinks.
 * If the target path does not exist on disk, walks up to the nearest existing ancestor.
 */
export function canonicalizeFsPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    let current = path.dirname(resolved);
    const suffix: string[] = [path.basename(resolved)];
    while (current && current !== path.dirname(current)) {
      try {
        const real = fs.realpathSync.native(current);
        return path.join(real, ...suffix);
      } catch {
        suffix.unshift(path.basename(current));
        current = path.dirname(current);
      }
    }
    return resolved;
  }
}

/** Returns the normalized absolute host path used to identify a filesystem path. */
export function filesystemPathKey(filePath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32' && process.platform === 'win32') {
    try {
      return canonicalizeFsPath(filePath).toLowerCase();
    } catch {
      // Fallback to lexical resolution
    }
  }
  const resolved = platform === 'win32'
    ? path.win32.resolve(filePath)
    : path.posix.resolve(filePath);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Returns the normalized absolute host path used to identify one configuration root. */
export function configurationPathKey(configPath: string, platform: NodeJS.Platform = process.platform): string {
  return filesystemPathKey(configPath, platform);
}

/** Checks whether two filesystem paths point to the same location, platform-aware. */
export function isSamePath(pathA: string, pathB: string, platform: NodeJS.Platform = process.platform): boolean {
  return filesystemPathKey(pathA, platform) === filesystemPathKey(pathB, platform);
}

/**
 * Checks whether candidatePath is identical to or located inside parentPath,
 * respecting path segment boundaries and host platform case sensitivity.
 */
export function isSameOrDescendantPath(
  parentPath: string,
  candidatePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') {
    const parentResolved = path.win32.resolve(parentPath);
    const candidateResolved = path.win32.resolve(candidatePath);
    const rel = path.win32.relative(parentResolved, candidateResolved);
    if (rel === '' || (!rel.startsWith('..\\') && rel !== '..' && !path.win32.isAbsolute(rel))) {
      return true;
    }
    // Fallback on Windows: resolve 8.3 short paths if lexical check failed
    if (platform === process.platform) {
      try {
        const canonicalParent = canonicalizeFsPath(parentResolved);
        const canonicalCandidate = canonicalizeFsPath(candidateResolved);
        const canonicalRel = path.win32.relative(canonicalParent, canonicalCandidate);
        return canonicalRel === '' || (!canonicalRel.startsWith('..\\') && canonicalRel !== '..' && !path.win32.isAbsolute(canonicalRel));
      } catch {
        return false;
      }
    }
    return false;
  } else {
    const parentResolved = path.posix.resolve(parentPath);
    const candidateResolved = path.posix.resolve(candidatePath);
    const rel = path.posix.relative(parentResolved, candidateResolved);
    return rel === '' || (!rel.startsWith('../') && rel !== '..' && !path.posix.isAbsolute(rel));
  }
}
