import * as fs from 'fs';
import * as path from 'path';
import { hashContent } from './configurationSession/atomicFileStorage';
import type { MutationExpectation } from './configurationSession/mutationPlan';

export interface MutationExpectationErrorFactories {
  readonly symbolicLink?: (targetPath: string) => Error;
  readonly unsupportedEntry?: (targetPath: string) => Error;
}

/** Reads a path without following links and maps only ENOENT to the missing state. */
export async function readMutationExpectation(
  targetPath: string,
  errors: MutationExpectationErrorFactories = {},
): Promise<MutationExpectation> {
  try {
    const stat = await fs.promises.lstat(targetPath);
    if (stat.isSymbolicLink()) {
      throw errors.symbolicLink?.(targetPath)
        ?? new Error(`Symbolic-link metadata path is forbidden: ${targetPath}`);
    }
    if (stat.isDirectory()) {
      return { state: 'directory' };
    }
    if (stat.isFile()) {
      return { state: 'file', hash: hashContent(await fs.promises.readFile(targetPath)) };
    }
    throw errors.unsupportedEntry?.(targetPath)
      ?? new Error(`Unsupported metadata filesystem entry: ${targetPath}`);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return { state: 'missing' };
    }
    throw error;
  }
}

/** Lists Designer XML siblings; an absent type folder is an empty sibling set. */
export async function listXmlSiblingNames(typeFolderPath: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(typeFolderPath, { withFileTypes: true });
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.xml'))
    .map((entry) => path.basename(entry.name, path.extname(entry.name)));
}

function isErrorCode(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}
