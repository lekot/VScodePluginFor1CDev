import { performance } from 'perf_hooks';

import type { CompareCancellationToken } from './compareCancellation';
import { throwIfCompareCancelled } from './compareCancellation';
import type { ConfigurationInventory } from './inventory/configurationInventory';
import type { CompareSession } from './domain/compareSession';
import type { MetadataIdentityMatch } from './domain/compareContracts';
import type { CompareJoinStrategy, MetadataObjectMatch, AdapterCompareResult } from './adapters/mergeAdapter';
import { fileObjectAdapter } from './adapters/fileObjectAdapter';
import { ambiguousArtifactPairResult, findArtifactPairs } from './adapters/artifactPairing';
import { buildMetadataReferenceContext } from './adapters/metadataReferenceContext';
import { matchMetadataIdentities } from './metadata/metadataMatcher';
import { compareLinkedDesignerXmlArtifact } from './linkedDesignerAdapterCompare';
import {
  type LinkedDesignerPackageRecipe,
  type LinkedFormModuleSnapshot,
} from './linkedDesignerMaterializer';
import { findInventoryObjectByDescriptor, metadataIdentityToObjectUnit } from './metadataObjectLookup';

export const COMPARE_PROGRESS_MIN_INTERVAL_MS = 100;
const COMPARE_MAP_YIELD_BATCH = 64;

export type CompareProgressThrottle = ((completed: number, total: number) => boolean) & {
  publicationFinished(startedAt: number): void;
};

/** Wait for every side of a parallel build stage before propagating its first failure. */
export async function awaitAllSettled<T>(tasks: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(tasks);
  const values: T[] = new Array<T>(settled.length);
  let firstFailure: PromiseRejectedResult | undefined;
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    if (result.status === 'rejected') {
      firstFailure ??= result;
    } else {
      values[index] = result.value;
    }
  }
  if (firstFailure) {
    throw firstFailure.reason;
  }
  return values;
}

export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
  cancellation?: CompareCancellationToken,
  onProgress?: (completed: number, total: number, completedResults: readonly R[]) => void
): Promise<R[]> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array<R>(items.length);
  const completedIndexes = onProgress ? new Uint8Array(items.length) : undefined;
  const shouldPublishProgress = onProgress ? createCompareProgressThrottle() : undefined;
  let nextIndex = 0;
  let completedCount = 0;
  let failure: { error: unknown } | undefined;
  let completedSinceYield = 0;

  async function run(): Promise<void> {
    while (!failure) {
      let index: number;
      try {
        throwIfCompareCancelled(cancellation);
        if (nextIndex >= items.length) {
          return;
        }
        index = nextIndex;
        nextIndex += 1;
      } catch (error) {
        failure ??= { error };
        return;
      }

      try {
        results[index] = await worker(items[index]);
        throwIfCompareCancelled(cancellation);
        if (failure) {
          return;
        }
        if (completedIndexes) {
          completedIndexes[index] = 1;
        }
        completedCount += 1;
        completedSinceYield += 1;
        if (onProgress && shouldPublishProgress?.(completedCount, items.length)) {
          const publicationStartedAt = performance.now();
          try {
            const completedResults: R[] = [];
            for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
              if (completedIndexes?.[resultIndex]) {
                completedResults.push(results[resultIndex]!);
              }
            }
            try {
              onProgress(completedCount, items.length, completedResults);
            } catch {
              // Progress reporting is advisory; callback failures must not cancel workers.
            }
          } finally {
            shouldPublishProgress.publicationFinished(publicationStartedAt);
          }
        }
        if (completedSinceYield >= COMPARE_MAP_YIELD_BATCH) {
          completedSinceYield = 0;
          await new Promise<void>((resolve) => setImmediate(resolve));
          throwIfCompareCancelled(cancellation);
        }
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, run));
  if (failure) {
    throw failure.error;
  }
  return results;
}

export async function buildAdapterCompareResults(input: {
  targetSourceId: string;
  strategy: CompareJoinStrategy;
  leftInventory: ConfigurationInventory;
  rightInventory: ConfigurationInventory;
  metadata: ReturnType<typeof matchMetadataIdentities>;
  session: CompareSession;
  cancellation?: CompareCancellationToken;
  concurrency: number;
  readTextFile?: (filePath: string) => Promise<string>;
  linkedDesignerPackages: readonly LinkedDesignerPackageRecipe[];
  linkedModules: readonly LinkedFormModuleSnapshot[];
  eventRoutineDependencies: Map<string, {
    moduleId: string;
    handlerName: string;
    targetHasHandler: boolean;
    incomingRoutineNodeId?: string;
  }>;
  defaultFormDependencies: Map<string, import('./linkedDesignerMaterializer').LinkedDefaultFormDependency>;
  onProgress?: (completed: number, total: number, results: readonly AdapterCompareResult[]) => void;
}): Promise<AdapterCompareResult[]> {
  throwIfCompareCancelled(input.cancellation);
  const metadataReferenceContext = await buildMetadataReferenceContext({
    inventory: input.leftInventory,
    sourceId: input.targetSourceId,
    readTextFile: input.readTextFile,
  });
  const matches = buildMetadataObjectMatches(input);
  input.onProgress?.(0, matches.length, []);

  const results = await mapLimit(matches, input.concurrency, async (match) => {
    throwIfCompareCancelled(input.cancellation);
    const matchResults: AdapterCompareResult[] = [
      await fileObjectAdapter.compare({
        strategy: input.strategy,
        leftInventory: input.leftInventory,
        rightInventory: input.rightInventory,
        match,
        session: input.session,
        snapshots: { left: '', right: '' },
      }),
    ];

    if (!match.left || !match.right) {
      return matchResults;
    }

    for (const artifactKind of ['metadataXml', 'formXml', 'predefinedXml', 'roleRightsXml', 'dcsXml'] as const) {
      throwIfCompareCancelled(input.cancellation);
      const pairing = findArtifactPairs(
        input.leftInventory,
        input.rightInventory,
        match,
        artifactKind
      );
      if (pairing.ambiguousRelativePaths.length > 0) {
        matchResults.push(ambiguousArtifactPairResult(input.targetSourceId));
        continue;
      }
      for (const artifactPair of pairing.pairs) {
        if (artifactPair.left.contentHash === artifactPair.right.contentHash) {
          continue;
        }
        matchResults.push(
          await compareLinkedDesignerXmlArtifact(
            input,
            match,
            artifactPair,
            artifactKind,
            metadataReferenceContext
          )
        );
      }
    }
    return matchResults;
  }, input.cancellation, input.onProgress
    ? (completed, total, matchResults) => input.onProgress!(completed, total, matchResults.flat())
    : undefined);

  return results
    .flat()
    .filter((result) => result.nodes.length > 0 || result.diagnostics.length > 0);
}

function buildMetadataObjectMatches(input: {
  strategy: CompareJoinStrategy;
  leftInventory: ConfigurationInventory;
  rightInventory: ConfigurationInventory;
  metadata: ReturnType<typeof matchMetadataIdentities>;
}): MetadataObjectMatch[] {
  const matches: MetadataObjectMatch[] = [
    ...input.metadata.matches.map((identity: MetadataIdentityMatch) => ({
      left: findInventoryObjectByDescriptor(input.leftInventory, identity.left.filePath),
      right: findInventoryObjectByDescriptor(input.rightInventory, identity.right.filePath),
      identity,
      leftIdentity: identity.left,
      rightIdentity: identity.right,
    })),
    ...input.metadata.unmatchedLeft.map((identity) => ({
      left:
        findInventoryObjectByDescriptor(input.leftInventory, identity.filePath) ??
        (input.strategy === 'full' ? metadataIdentityToObjectUnit(identity) : undefined),
      leftIdentity: identity,
    })),
    ...input.metadata.unmatchedRight.map((identity) => ({
      right:
        findInventoryObjectByDescriptor(input.rightInventory, identity.filePath) ??
        (input.strategy === 'full' ? metadataIdentityToObjectUnit(identity) : undefined),
      rightIdentity: identity,
    })),
  ];

  return matches.filter((match) => match.left || match.right);
}

export function createCompareProgressThrottle(
  now: () => number = () => performance.now(),
  minIntervalMs = COMPARE_PROGRESS_MIN_INTERVAL_MS
): CompareProgressThrottle {
  let nextAllowedAt: number | undefined;
  const shouldPublish = ((completed: number, total: number) => {
    const current = now();
    if (completed === 1 && total > 0) {
      nextAllowedAt = current + minIntervalMs;
      return true;
    }
    if (completed === total && total > 0) {
      nextAllowedAt = current + minIntervalMs;
      return true;
    }
    if (nextAllowedAt === undefined || current >= nextAllowedAt) {
      nextAllowedAt = current + minIntervalMs;
      return true;
    }
    return false;
  }) as CompareProgressThrottle;

  shouldPublish.publicationFinished = (startedAt) => {
    const finishedAt = now();
    const duration = Math.max(0, finishedAt - startedAt);
    // A 9x cooldown keeps the synchronous projection near a 10% steady-state budget.
    nextAllowedAt = finishedAt + Math.max(minIntervalMs, 9 * duration);
  };

  return shouldPublish;
}
