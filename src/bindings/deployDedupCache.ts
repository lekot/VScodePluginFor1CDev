import * as crypto from 'crypto';

export interface DedupKey {
  readonly bindingId: string;
  readonly infobaseId: string;
}

export interface DedupRecordInput {
  readonly relativeFiles: readonly string[];
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

function hashFiles(relativeFiles: readonly string[]): string {
  const sorted = [...relativeFiles].map((f) => f.toLowerCase()).sort();
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
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
  if (entry.hash !== hashFiles(input.relativeFiles)) {
    return { isDuplicate: false };
  }
  return { isDuplicate: true, ageMs };
}

export function recordDeploy(
  key: DedupKey,
  input: DedupRecordInput,
  nowMs: number,
): void {
  cache.set(makeKey(key), { hash: hashFiles(input.relativeFiles), timestamp: nowMs });
}

export function resetDeployDedupCacheForTests(): void {
  cache.clear();
}
