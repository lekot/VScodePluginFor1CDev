import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { compareCodeUnits } from '../utils/compareCodeUnits';

export interface DedupKey {
  readonly bindingId: string;
  readonly infobaseId: string;
}

export interface DedupRecordInput {
  readonly relativeFiles: readonly string[];
  readonly contentSignature?: string;
}

export interface DedupCheckResult {
  readonly isDuplicate: boolean;
  readonly ageMs?: number;
}

// Prevents double-firing on network FS where save events can arrive twice
// within a short window, or when the user triggers deploy twice quickly.
// 2 seconds is wide enough to absorb FS event debounce lag but narrow
// enough not to block genuine back-to-back deploys on different objects.
const DEDUP_WINDOW_MS = 2000;

interface CacheEntry {
  fileHash: string;
  contentSignature?: string;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

function makeKey(key: DedupKey): string {
  return `${key.bindingId}::${key.infobaseId}`;
}

function hashFiles(relativeFiles: readonly string[]): string {
  const sorted = [...relativeFiles].map((f) => f.toLowerCase()).sort(compareCodeUnits);
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/**
 * Computes a robust content signature based on SHA-256 content hashes of the deployed files.
 */
export async function computeFilesContentSignature(
  configRoot: string,
  relativeFiles: readonly string[],
): Promise<string> {
  const parts: string[] = [];
  for (const rel of relativeFiles) {
    try {
      const abs = path.join(configRoot, rel);
      const content = await fs.promises.readFile(abs);
      const fileContentHash = crypto.createHash('sha256').update(content).digest('hex');
      parts.push(`${rel.toLowerCase()}:${fileContentHash}`);
    } catch {
      parts.push(`${rel.toLowerCase()}:missing`);
    }
  }
  parts.sort(compareCodeUnits);
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

export function checkRecentDeploy(
  key: DedupKey,
  input: DedupRecordInput,
  nowMs: number,
): DedupCheckResult {
  const entry = cache.get(makeKey(key));
  if (!entry) {
    return { isDuplicate: false };
  }
  const ageMs = nowMs - entry.timestamp;
  if (ageMs >= DEDUP_WINDOW_MS) {
    return { isDuplicate: false };
  }
  const currentFileHash = hashFiles(input.relativeFiles);
  if (entry.fileHash !== currentFileHash) {
    return { isDuplicate: false };
  }
  // If both recorded and candidate inputs have content signatures, compare them.
  // A changed content signature means new content was saved -> not a duplicate (#185).
  if (
    entry.contentSignature !== undefined &&
    input.contentSignature !== undefined &&
    entry.contentSignature !== input.contentSignature
  ) {
    return { isDuplicate: false };
  }
  return { isDuplicate: true, ageMs };
}

export function recordDeploy(
  key: DedupKey,
  input: DedupRecordInput,
  nowMs: number,
): void {
  cache.set(makeKey(key), {
    fileHash: hashFiles(input.relativeFiles),
    contentSignature: input.contentSignature,
    timestamp: nowMs,
  });
}

export function resetDeployDedupCacheForTests(): void {
  cache.clear();
}
