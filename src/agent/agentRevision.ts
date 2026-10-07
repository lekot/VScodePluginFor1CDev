// src/agent/agentRevision.ts
// Utility for SHA-256 metadata revision calculation and optimistic locking validation.

import * as fs from 'fs';
import * as path from 'path';
import { hashContent } from '../services/configurationSession/atomicFileStorage';

export const ZERO_REVISION = '0'.repeat(64);

export interface MutationPlannedChanges {
  files: string[];
  summary: string;
}

export interface RevisionValidationResult {
  ok: boolean;
  currentRev: string;
}

/**
 * Calculates deterministic SHA-256 revision hash of a file or directory.
 * If target does not exist, returns 64 zeroes.
 */
export async function calculateRevision(targetPath: string): Promise<string> {
  try {
    const stat = await fs.promises.lstat(targetPath);
    if (stat.isFile()) {
      const bytes = await fs.promises.readFile(targetPath);
      return hashContent(bytes);
    }
    if (stat.isDirectory()) {
      return await calculateDirectoryRevision(targetPath);
    }
    return ZERO_REVISION;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return ZERO_REVISION;
    }
    throw err;
  }
}

async function calculateDirectoryRevision(dirPath: string): Promise<string> {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const hashes: string[] = [];
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isFile()) {
      const content = await fs.promises.readFile(full);
      hashes.push(`${entry.name}:${hashContent(content)}`);
    } else if (entry.isDirectory()) {
      hashes.push(`${entry.name}:${await calculateDirectoryRevision(full)}`);
    }
  }
  return hashContent(hashes.join('\n'));
}

/**
 * Checks if ifRev matches current revision of target.
 */
export async function validateIfRev(targetPath: string, ifRev?: string): Promise<RevisionValidationResult> {
  const currentRev = await calculateRevision(targetPath);
  if (ifRev === undefined) {
    return { ok: true, currentRev };
  }
  return { ok: ifRev === currentRev, currentRev };
}

/**
 * Validates syntax of ifRev parameter (must be 64-char lowercase hex string).
 */
export function isValidRevisionFormat(rev: string): boolean {
  return /^[a-f0-9]{64}$/.test(rev);
}
