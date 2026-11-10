import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { performance } from 'perf_hooks';

import {
  indexBslModuleSource,
  resolveSupportedBslModuleIdentity,
  type BslModuleDiagnostic,
  type BslModuleFileInput,
  type BslModuleIndexEntry,
  type BslModuleIndexResult,
} from './bslModuleIndexer';
import { hashText } from './bslRoutineLogicalScanner';
import type { CompareSide } from '../domain/compareContracts';
import type { CompareCancellationToken } from '../compareCancellation';
import { throwIfCompareCancelled } from '../compareCancellation';
import type { ResolvedBslInventoryFile } from './bslSourceRetention';

const BSL_INVENTORY_BATCH_SIZE = 64;
const BSL_COOPERATIVE_YIELD_INTERVAL_MS = 8;

export interface BslInventoryResolution {
  /** Sorted inventory rows, including duplicate file paths so every listed artifact is read. */
  readonly filePaths: readonly string[];
  /** One identity resolution for each distinct exact path, in the same order as the first path occurrence. */
  readonly files: readonly ResolvedBslInventoryFile[];
  readonly sourceCount: number;
}

export interface BslInventoryCollection {
  readonly sources: Map<string, string>;
  readonly contentHash: string;
  readonly index: BslModuleIndexResult;
  readonly sourceCount: number;
}

interface ProcessedBslInventoryFile {
  readonly contentHash: string;
  readonly source?: string;
  readonly indexed?: BslModuleIndexEntry;
  readonly diagnostic?: BslModuleDiagnostic;
}

export async function resolveBslInventoryIdentities(input: {
  sourceId: string;
  side: CompareSide;
  configRoot: string;
  filePaths: readonly string[];
  cancellation?: CompareCancellationToken;
}): Promise<BslInventoryResolution> {
  throwIfCompareCancelled(input.cancellation);
  const filePaths = [...input.filePaths].sort((left, right) => left.localeCompare(right));
  const uniquePaths = [...new Set(filePaths)];
  const files: ResolvedBslInventoryFile[] = [];
  let completedSinceYield = 0;
  let lastYieldAt = performance.now();

  for (const filePath of uniquePaths) {
    throwIfCompareCancelled(input.cancellation);
    const fileInput: BslModuleFileInput = {
      sourceId: input.sourceId,
      side: input.side,
      filePath,
      configRoots: [input.configRoot],
    };
    const resolved = resolveSupportedBslModuleIdentity(fileInput);
    throwIfCompareCancelled(input.cancellation);
    files.push(resolved.identity
      ? { filePath, identity: resolved.identity }
      : { filePath, diagnostic: resolved.diagnostic });

    completedSinceYield += 1;
    if (completedSinceYield >= BSL_INVENTORY_BATCH_SIZE
      || performance.now() - lastYieldAt >= BSL_COOPERATIVE_YIELD_INTERVAL_MS) {
      completedSinceYield = 0;
      await yieldToEventLoop();
      throwIfCompareCancelled(input.cancellation);
      lastYieldAt = performance.now();
    }
  }

  return { filePaths, files, sourceCount: filePaths.length };
}

export async function collectBslInventorySources(input: {
  resolution: BslInventoryResolution;
  retainedPaths: ReadonlySet<string>;
  concurrency: number;
  cancellation?: CompareCancellationToken;
  readTextFile?: (filePath: string) => Promise<string>;
}): Promise<BslInventoryCollection> {
  throwIfCompareCancelled(input.cancellation);
  const reader = input.readTextFile ?? ((filePath: string) => fs.readFile(filePath, 'utf-8'));
  const fileByPath = new Map(input.resolution.files.map((file) => [file.filePath, file]));
  const lastOccurrenceByPath = new Map<string, number>();
  input.resolution.filePaths.forEach((filePath, index) => lastOccurrenceByPath.set(filePath, index));
  const processedByPath = new Map<string, ProcessedBslInventoryFile>();
  const readConcurrency = Math.max(1, Math.floor(input.concurrency) || 1);
  let completedSinceYield = 0;
  let lastYieldAt = performance.now();

  for (let offset = 0; offset < input.resolution.filePaths.length; offset += BSL_INVENTORY_BATCH_SIZE) {
    throwIfCompareCancelled(input.cancellation);
    const batchPaths = input.resolution.filePaths.slice(offset, offset + BSL_INVENTORY_BATCH_SIZE);
    const batchSources = await readBatch(batchPaths, readConcurrency, reader, input.cancellation);
    for (let index = 0; index < batchPaths.length; index += 1) {
      const filePath = batchPaths[index]!;
      const source = batchSources[index]!;
      if (lastOccurrenceByPath.get(filePath) !== offset + index) {
        continue;
      }
      throwIfCompareCancelled(input.cancellation);
      const file = fileByPath.get(filePath);
      const indexed = file?.identity
        ? indexBslModuleSource({ identity: file.identity, source })
        : undefined;
      processedByPath.set(filePath, {
        contentHash: hashText(source),
        ...(input.retainedPaths.has(filePath) ? { source } : {}),
        ...(indexed ? { indexed } : {}),
        ...(!file?.identity && file?.diagnostic ? { diagnostic: file.diagnostic } : {}),
      });
      throwIfCompareCancelled(input.cancellation);

      completedSinceYield += 1;
      if (completedSinceYield >= BSL_INVENTORY_BATCH_SIZE
        || performance.now() - lastYieldAt >= BSL_COOPERATIVE_YIELD_INTERVAL_MS) {
        completedSinceYield = 0;
        await yieldToEventLoop();
        throwIfCompareCancelled(input.cancellation);
        lastYieldAt = performance.now();
      }
    }
  }

  const sources = new Map<string, string>();
  const modules: BslModuleIndexEntry[] = [];
  const diagnostics: BslModuleDiagnostic[] = [];
  for (const file of input.resolution.files) {
    const processed = processedByPath.get(file.filePath);
    if (!processed) {
      throw new Error(`BSL inventory source was not processed: ${file.filePath}`);
    }
    if (processed.source !== undefined) {
      sources.set(file.filePath, processed.source);
    }
    if (processed.indexed) {
      modules.push(processed.indexed);
      diagnostics.push(...processed.indexed.diagnostics);
    } else if (processed.diagnostic) {
      diagnostics.push(processed.diagnostic);
    }
  }

  const hash = createHash('sha256');
  const hashEntries = [...input.resolution.files].sort((left, right) => left.filePath.localeCompare(right.filePath));
  for (const file of hashEntries) {
    const processed = processedByPath.get(file.filePath)!;
    hash.update(path.normalize(file.filePath).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(processed.contentHash);
    hash.update('\0');
  }

  return {
    sources,
    contentHash: hash.digest('hex'),
    index: { modules, diagnostics },
    sourceCount: input.resolution.sourceCount,
  };
}

async function readBatch(
  filePaths: readonly string[],
  concurrency: number,
  reader: (filePath: string) => Promise<string>,
  cancellation: CompareCancellationToken | undefined
): Promise<string[]> {
  const limit = Math.max(1, Math.min(concurrency, filePaths.length || 1));
  const sources = new Array<string>(filePaths.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;

  async function run(): Promise<void> {
    while (!failed) {
      let index: number;
      try {
        throwIfCompareCancelled(cancellation);
        if (nextIndex >= filePaths.length) {
          return;
        }
        index = nextIndex;
        nextIndex += 1;
      } catch (error) {
        failed = true;
        failure ??= error;
        return;
      }

      try {
        sources[index] = await reader(filePaths[index]!);
        throwIfCompareCancelled(cancellation);
      } catch (error) {
        failed = true;
        failure ??= error;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, run));
  if (failed) {
    throw failure;
  }
  throwIfCompareCancelled(cancellation);
  return sources;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
