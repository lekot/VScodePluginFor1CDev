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
  hash: string;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

function makeKey(key: DedupKey): string {
  return `${key.bindingId}::${key.infobaseId}`;
}

function hashInput(input: DedupRecordInput): string {
  const sorted = [...input.relativeFiles].map((f) => f.toLowerCase()).sort(compareCodeUnits);
  const payload = {
    files: sorted,
    sig: input.contentSignature ?? null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Computes a lightweight content signature based on file modification times and sizes.
 */
export async function computeFilesContentSignature(
  configRoot: string,
  relativeFiles: readonly string[],
): Promise<string> {
  const parts: string[] = [];
  for (const rel of relativeFiles) {
    try {
      const abs = path.join(configRoot, rel);
      const stat = await fs.promises.stat(abs);
      parts.push(`${rel.toLowerCase()}:${stat.mtimeMs}:${stat.size}`);
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
  if (entry.hash !== hashInput(input)) {
    return { isDuplicate: false };
  }
  return { isDuplicate: true, ageMs };
}

export function recordDeploy(
  key: DedupKey,
  input: DedupRecordInput,
  nowMs: number,
): void {
  cache.set(makeKey(key), { hash: hashInput(input), timestamp: nowMs });
}

export function resetDeployDedupCacheForTests(): void {
  cache.clear();
}
