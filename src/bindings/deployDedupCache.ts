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
  readonly contentHash?: string;
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
  hash: string;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

function makeKey(key: DedupKey): string {
  return `${key.bindingId}::${key.infobaseId}`;
}

function hashFilesAndContent(relativeFiles: readonly string[], contentHash?: string): string {
  const sorted = [...relativeFiles].map((f) => f.toLowerCase()).sort(compareCodeUnits);
  const hasher = crypto.createHash('sha256').update(JSON.stringify(sorted));
  if (contentHash) {
    hasher.update(`::${contentHash}`);
  }
  return hasher.digest('hex');
}

export async function computeFilesContentHash(
  configRoot: string,
  relativeFiles: readonly string[],
): Promise<string> {
  const sorted = [...relativeFiles].map((f) => f.toLowerCase()).sort(compareCodeUnits);
  const hasher = crypto.createHash('sha256');
  for (const rel of sorted) {
    const full = path.join(configRoot, rel);
    try {
      const data = await fs.promises.readFile(full);
      hasher.update(`${rel}::`).update(data);
    } catch (err: unknown) {
      hasher.update(`${rel}::missing::${(err as NodeJS.ErrnoException)?.code ?? 'ERR'}`);
    }
  }
  return hasher.digest('hex');
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
  if (entry.hash !== hashFilesAndContent(input.relativeFiles, input.contentHash)) {
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
    hash: hashFilesAndContent(input.relativeFiles, input.contentHash),
    timestamp: nowMs,
  });
}

export function resetDeployDedupCacheForTests(): void {
  cache.clear();
}
