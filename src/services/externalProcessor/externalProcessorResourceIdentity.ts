import * as fs from 'fs';
import * as path from 'path';

function normalizeCanonicalPath(value: string): string {
  const normalized = path.normalize(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export async function resolveExternalProcessorResourceIdentity(
  resourcePath: string,
  exists: boolean
): Promise<string> {
  const absolutePath = path.resolve(resourcePath);
  if (exists) {
    const canonical = await fs.promises.realpath(absolutePath);
    return `external-resource:${normalizeCanonicalPath(canonical)}`;
  }

  const missingSegments: string[] = [];
  let candidate = absolutePath;
  for (;;) {
    try {
      const canonicalParent = await fs.promises.realpath(candidate);
      const canonical = path.join(canonicalParent, ...missingSegments.reverse());
      return `external-resource:${normalizeCanonicalPath(canonical)}`;
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw new Error(`Cannot resolve an existing parent for output path: ${absolutePath}`);
      }
      missingSegments.push(path.basename(candidate));
      candidate = parent;
    }
  }
}
