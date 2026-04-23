import * as fs from 'fs';
import * as path from 'path';

const COLLECTED_EXTENSIONS = new Set(['.xml', '.bsl', '.os', '.mxl', '.bin']);
const MAX_ASCENT_LEVELS = 6;

function walkDir(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else if (entry.isFile() && COLLECTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      results.push(fullPath);
    }
  }
  return results;
}

function toRelativeForwardSlash(absolutePath: string, configRoot: string): string {
  return path.relative(configRoot, absolutePath).replace(/\\/g, '/');
}

/**
 * Finds the object descriptor XML for a .bsl file by ascending the directory tree.
 * Looks for a sibling XML: for dir `CommonModules/Foo`, checks `CommonModules/Foo.xml`.
 * Returns the absolute descriptor path, or undefined if not found within MAX_ASCENT_LEVELS.
 */
function findDescriptorForBsl(bslAbsolute: string): string | undefined {
  let current = path.dirname(bslAbsolute);
  for (let level = 0; level < MAX_ASCENT_LEVELS; level++) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    const candidate = path.join(parent, path.basename(current) + '.xml');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    current = parent;
  }
  return undefined;
}

/**
 * Expands each .bsl file to include its object descriptor XML and all sibling files
 * in the object directory. Non-.bsl files are passed through unchanged.
 * Deduplication is case-insensitive; first occurrence order is preserved.
 */
export function expandBslSiblings(
  relativeFiles: readonly string[],
  configRoot: string,
): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  const addUnique = (rel: string): void => {
    const key = rel.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      results.push(rel);
    }
  };

  for (const file of relativeFiles) {
    if (!file.toLowerCase().endsWith('.bsl')) {
      addUnique(file);
      continue;
    }

    const bslAbsolute = path.resolve(configRoot, file);
    const descriptor = findDescriptorForBsl(bslAbsolute);

    if (!descriptor) {
      addUnique(file);
      continue;
    }

    // Add descriptor XML first
    addUnique(toRelativeForwardSlash(descriptor, configRoot));

    // Add all files in the object directory (same basename without extension)
    const objectDir = path.join(
      path.dirname(descriptor),
      path.basename(descriptor, path.extname(descriptor)),
    );

    let dirStat: fs.Stats | undefined;
    try {
      dirStat = fs.statSync(objectDir);
    } catch {
      dirStat = undefined;
    }

    if (dirStat?.isDirectory()) {
      for (const absFile of walkDir(objectDir)) {
        addUnique(toRelativeForwardSlash(absFile, configRoot));
      }
    }
  }

  return results;
}
