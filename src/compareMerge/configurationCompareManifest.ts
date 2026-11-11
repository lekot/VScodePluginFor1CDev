import * as path from 'path';

import type { MetadataIdentity, MatchResult } from './domain/compareContracts';
import { awaitAllSettled } from './compareBuildPipeline';
import { throwIfCompareCancelled, type CompareCancellationToken } from './compareCancellation';
import { indexMetadataFolder } from './metadata/metadataIndexer';
import { matchMetadataIdentities } from './metadata/metadataMatcher';

/** Builds the complete two-sided metadata manifest used by configuration comparison. */
export async function discoverConfigurationCompareManifest(input: {
  left: { sourceId: string; rootPath: string; allowMissingRoot?: boolean };
  right: { sourceId: string; rootPath: string; allowMissingRoot?: boolean };
  metadataReadConcurrency: number;
  directoryReadConcurrency: number;
  cancellation?: CompareCancellationToken;
}): Promise<{
  leftMetadata: MetadataIdentity[];
  rightMetadata: MetadataIdentity[];
  metadata: MatchResult;
}> {
  throwIfCompareCancelled(input.cancellation);
  const [leftMetadata, rightMetadata] = await awaitAllSettled([
    indexManifestSide({
      sourceId: input.left.sourceId,
      side: 'left',
      folderPath: input.left.rootPath,
      allowMissingRoot: input.left.allowMissingRoot,
      cancellation: input.cancellation,
      concurrency: input.metadataReadConcurrency,
      directoryConcurrency: input.directoryReadConcurrency,
    }),
    indexManifestSide({
      sourceId: input.right.sourceId,
      side: 'right',
      folderPath: input.right.rootPath,
      allowMissingRoot: input.right.allowMissingRoot,
      cancellation: input.cancellation,
      concurrency: input.metadataReadConcurrency,
      directoryConcurrency: input.directoryReadConcurrency,
    }),
  ]);
  throwIfCompareCancelled(input.cancellation);
  const metadata = matchMetadataIdentities({ left: leftMetadata, right: rightMetadata });
  throwIfCompareCancelled(input.cancellation);
  return { leftMetadata, rightMetadata, metadata };
}

async function indexManifestSide(input: {
  sourceId: string;
  side: 'left' | 'right';
  folderPath: string;
  allowMissingRoot?: boolean;
  cancellation?: CompareCancellationToken;
  concurrency: number;
  directoryConcurrency: number;
}): Promise<MetadataIdentity[]> {
  try {
    return await indexMetadataFolder({
      sourceId: input.sourceId,
      side: input.side,
      folderPath: input.folderPath,
      cancellation: input.cancellation,
      concurrency: input.concurrency,
      directoryConcurrency: input.directoryConcurrency,
    });
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException | undefined;
    if (input.allowMissingRoot
      && fileError?.code === 'ENOENT'
      && typeof fileError.path === 'string'
      && path.resolve(fileError.path) === path.resolve(input.folderPath)) {
      throwIfCompareCancelled(input.cancellation);
      return [];
    }
    throw error;
  }
}
