import * as path from 'path';

/** Returns the normalized absolute host path used to identify a filesystem path. */
export function filesystemPathKey(filePath: string, platform: NodeJS.Platform = process.platform): string {
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
    return rel === '' || (!rel.startsWith('..\\') && rel !== '..' && !path.win32.isAbsolute(rel));
  } else {
    const parentResolved = path.posix.resolve(parentPath);
    const candidateResolved = path.posix.resolve(candidatePath);
    const rel = path.posix.relative(parentResolved, candidateResolved);
    return rel === '' || (!rel.startsWith('../') && rel !== '..' && !path.posix.isAbsolute(rel));
  }
}
