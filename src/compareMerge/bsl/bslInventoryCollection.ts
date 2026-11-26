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
  type BslModuleLocationResolver,
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
  /** Raw SHA-256 values are present only when a byte reader supplied the original file bytes. */
  readonly rawFileHashes?: ReadonlyMap<string, string>;
  readonly index: BslModuleIndexResult;
  readonly sourceCount: number;
}

interface ProcessedBslInventoryFile {
  readonly contentHash: string;
  readonly rawFileHash?: string;
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
  locationResolver?: BslModuleLocationResolver;
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
    const resolved = resolveSupportedBslModuleIdentity(fileInput, input.locationResolver);
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
  /** When provided, only these supported modules receive a full routine parse. */
  analysisPaths?: ReadonlySet<string>;
  /** When provided, only these paths are read and included in the composite content hash. */
  readPaths?: ReadonlySet<string>;
  concurrency: number;
  cancellation?: CompareCancellationToken;
  readTextFile?: (filePath: string) => Promise<string>;
  readFileBytes?: (filePath: string) => Promise<Buffer>;
}): Promise<BslInventoryCollection> {
  throwIfCompareCancelled(input.cancellation);
  const allPaths = new Set(input.resolution.files.map((file) => file.filePath));
  const readPaths = input.readPaths ?? allPaths;
  assertPathSetSubset('readPaths', readPaths, allPaths);
  assertPathSetSubset('analysisPaths', input.analysisPaths, readPaths);
  if (input.readPaths !== undefined) {
    assertPathSetSubset('retainedPaths', input.retainedPaths, readPaths);
  }
  const textReader = input.readTextFile ?? defaultTextReader;
  const fileByPath = new Map(input.resolution.files.map((file) => [file.filePath, file]));
  const lastOccurrenceByPath = new Map<string, number>();
  input.resolution.filePaths.forEach((filePath, index) => lastOccurrenceByPath.set(filePath, index));
  const processedByPath = new Map<string, ProcessedBslInventoryFile>();
  const readConcurrency = Math.max(1, Math.floor(input.concurrency) || 1);
  let completedSinceYield = 0;
  let lastYieldAt = performance.now();

  for (let offset = 0; offset < input.resolution.filePaths.length; offset += BSL_INVENTORY_BATCH_SIZE) {
    throwIfCompareCancelled(input.cancellation);
    const batchRows = input.resolution.filePaths
      .slice(offset, offset + BSL_INVENTORY_BATCH_SIZE)
      .map((filePath, index) => ({ filePath, rowIndex: offset + index }))
      .filter((row) => readPaths.has(row.filePath));
    if (batchRows.length === 0) {continue;}
    const batchPaths = batchRows.map((row) => row.filePath);
    const batchFiles = await readBatch({
      filePaths: batchPaths,
      concurrency: readConcurrency,
      readTextFile: textReader,
      readFileBytes: input.readFileBytes,
      cancellation: input.cancellation,
    });
    for (let index = 0; index < batchPaths.length; index += 1) {
      const filePath = batchPaths[index]!;
      const { source, rawFileHash } = batchFiles[index]!;
      if (lastOccurrenceByPath.get(filePath) !== batchRows[index]!.rowIndex) {
        continue;
      }
      throwIfCompareCancelled(input.cancellation);
      const file = fileByPath.get(filePath);
      const indexed = file?.identity
        ? input.analysisPaths !== undefined && !input.analysisPaths.has(filePath)
          ? { identity: file.identity, routines: [], diagnostics: [], analysisState: 'deferred' as const }
          : indexBslModuleSource({ identity: file.identity, source })
        : undefined;
      processedByPath.set(filePath, {
        contentHash: hashText(source),
        ...(rawFileHash ? { rawFileHash } : {}),
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
  const rawFileHashes = input.readFileBytes ? new Map<string, string>() : undefined;
  const modules: BslModuleIndexEntry[] = [];
  const diagnostics: BslModuleDiagnostic[] = [];
  for (const file of input.resolution.files) {
    const processed = processedByPath.get(file.filePath);
    if (processed?.source !== undefined) {
      sources.set(file.filePath, processed.source);
    }
    if (processed?.rawFileHash !== undefined) {
      rawFileHashes?.set(file.filePath, processed.rawFileHash);
    }
    if (processed?.indexed) {
      modules.push(processed.indexed);
      diagnostics.push(...processed.indexed.diagnostics);
    } else if (processed?.diagnostic) {
      diagnostics.push(processed.diagnostic);
    } else if (!processed && file.identity) {
      modules.push({ identity: file.identity, routines: [], diagnostics: [], analysisState: 'deferred' });
    } else if (!processed && file.diagnostic) {
      diagnostics.push(file.diagnostic);
    }
  }

  const hash = createHash('sha256');
  const hashEntries = [...input.resolution.files]
    .filter((file) => readPaths.has(file.filePath))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
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
    ...(rawFileHashes ? { rawFileHashes } : {}),
    index: { modules, diagnostics },
    sourceCount: input.resolution.filePaths.filter((filePath) => readPaths.has(filePath)).length,
  };
}

function assertPathSetSubset(
  name: string,
  candidate: ReadonlySet<string> | undefined,
  allowed: ReadonlySet<string>,
): void {
  if (!candidate) {return;}
  for (const filePath of candidate) {
    if (!allowed.has(filePath)) {
      throw new Error(`${name} contains a path outside its allowed scope: ${filePath}`);
    }
  }
}

interface ReadBslFileResult {
  readonly source: string;
  readonly rawFileHash?: string;
}

async function readBatch(input: {
  readonly filePaths: readonly string[];
  readonly concurrency: number;
  readonly readTextFile: (filePath: string) => Promise<string>;
  readonly readFileBytes?: (filePath: string) => Promise<Buffer>;
  readonly cancellation?: CompareCancellationToken;
}): Promise<ReadBslFileResult[]> {
  const limit = Math.max(1, Math.min(input.concurrency, input.filePaths.length || 1));
  const files = new Array<ReadBslFileResult>(input.filePaths.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;

  async function run(): Promise<void> {
    while (!failed) {
      let index: number;
      try {
        throwIfCompareCancelled(input.cancellation);
        if (nextIndex >= input.filePaths.length) {
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
        const filePath = input.filePaths[index]!;
        if (!input.readFileBytes) {
          files[index] = { source: await input.readTextFile(filePath) };
        } else if (input.readTextFile !== defaultTextReader) {
          const [sourceResult, bytesResult] = await Promise.allSettled([
            input.readTextFile(filePath),
            input.readFileBytes(filePath),
          ]);
          if (sourceResult.status === 'rejected') {throw sourceResult.reason;}
          if (bytesResult.status === 'rejected') {throw bytesResult.reason;}
          files[index] = {
            source: sourceResult.value,
            rawFileHash: rawHash(bytesResult.value),
          };
        } else {
          const bytes = await input.readFileBytes(filePath);
          files[index] = {
            source: bytes.toString('utf8'),
            rawFileHash: rawHash(bytes),
          };
        }
        throwIfCompareCancelled(input.cancellation);
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
  throwIfCompareCancelled(input.cancellation);
  return files;
}

const defaultTextReader = (filePath: string): Promise<string> => fs.readFile(filePath, 'utf-8');

function rawHash(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
