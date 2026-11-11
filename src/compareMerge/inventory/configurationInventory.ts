import * as fs from 'fs/promises';
import * as path from 'path';

import type { MetadataIdentity } from '../domain/compareContracts';
import { indexMetadataFolder } from '../metadata/metadataIndexer';
import {
  createArtifactUnit,
  type ArtifactKind,
  type ArtifactMergeMode,
  type ArtifactUnit,
} from './configurationArtifacts';
import {
  type CompareCancellationToken,
  throwIfCompareCancelled,
} from '../compareCancellation';

export { type ArtifactKind, type ArtifactMergeMode, type ArtifactUnit };

export interface ConfigurationInventory {
  rootPath: string;
  objects: MetadataObjectUnit[];
  artifactsByObjectId: ReadonlyMap<string, ArtifactUnit[]>;
  objectsByDescriptorPath: ReadonlyMap<string, MetadataObjectUnit>;
}

export interface MetadataObjectUnit {
  objectId: string;
  qualifiedName: string;
  metadataType: string;
  uuid?: string;
  descriptorPath: string;
  containerPath: string;
}

interface ObjectCandidate extends MetadataObjectUnit {
  descriptorDirectory: string;
}

export interface BuildConfigurationInventoryOptions {
  identities?: readonly MetadataIdentity[];
  includeDescriptorPaths?: ReadonlySet<string>;
  cancellation?: CompareCancellationToken;
  artifactConcurrency?: number;
}

const DIRECTORY_READ_CONCURRENCY = 8;

interface ArtifactOwnerIndex {
  exactDescriptorByPath: ReadonlyMap<string, ObjectCandidate>;
  containerByPath: ReadonlyMap<string, ObjectCandidate>;
  directSidecarDirByPath: ReadonlyMap<string, ObjectCandidate>;
  rootPath: string;
}

export async function buildConfigurationInventory(
  rootPath: string,
  options: BuildConfigurationInventoryOptions = {}
): Promise<ConfigurationInventory> {
  throwIfCompareCancelled(options.cancellation);
  const normalizedRootPath = path.normalize(rootPath);
  const metadataIdentities = options.identities ?? await indexMetadataFolder({
    sourceId: 'configuration-inventory',
    side: 'left',
    folderPath: normalizedRootPath,
    cancellation: options.cancellation,
  });
  const includeDescriptorPaths = options.includeDescriptorPaths
    ? new Set([...options.includeDescriptorPaths].map(normalizeKey))
    : undefined;
  const allObjects: ObjectCandidate[] = metadataIdentities
    .map((identity) => {
      const descriptorPath = path.normalize(identity.filePath);
      const objectId = identity.uuid
        ? `uuid:${identity.uuid}`
        : `name:${identity.qualifiedName}`;

      return {
        objectId,
        qualifiedName: identity.qualifiedName,
        metadataType: identity.metadataType,
        uuid: identity.uuid,
        descriptorPath,
        containerPath: resolveObjectContainerPath(descriptorPath),
        descriptorDirectory: path.dirname(descriptorPath),
      };
    })
    .sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName));
  const objects = includeDescriptorPaths
    ? allObjects.filter((object) => includeDescriptorPaths.has(normalizeKey(object.descriptorPath)))
    : allObjects;

  const files = includeDescriptorPaths
    ? await collectFilesForObjects(objects, options.cancellation)
    : await collectFiles(normalizedRootPath, options.cancellation);
  const artifactsByObjectId = new Map<string, ArtifactUnit[]>();
  const ownerIndex = buildArtifactOwnerIndex(normalizedRootPath, allObjects);
  const objectsByDescriptorPath = new Map<string, MetadataObjectUnit>();
  const includedObjectIds = new Set(objects.map((object) => object.objectId));

  for (const object of objects) {
    artifactsByObjectId.set(object.objectId, []);
    objectsByDescriptorPath.set(normalizeKey(object.descriptorPath), object);
  }

  const ownedFiles: { filePath: string; owner: ObjectCandidate }[] = [];
  for (const filePath of files) {
    const owner = findArtifactOwner(filePath, ownerIndex);
    if (!owner || !includedObjectIds.has(owner.objectId)) {
      continue;
    }
    ownedFiles.push({ filePath, owner });
  }

  const artifacts = await mapLimit(ownedFiles, options.artifactConcurrency ?? 16, async ({ filePath, owner }) => {
    throwIfCompareCancelled(options.cancellation);
    const artifact = await createArtifactUnit({
      rootPath: normalizedRootPath,
      ownerObjectId: owner.objectId,
      filePath,
      descriptorPath: owner.descriptorPath,
    });
    throwIfCompareCancelled(options.cancellation);
    return artifact;
  });
  for (const artifact of artifacts) {
    if (artifact.ownerObjectId) {
      artifactsByObjectId.get(artifact.ownerObjectId)?.push(artifact);
    }
  }

  for (const artifacts of artifactsByObjectId.values()) {
    artifacts.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }
  throwIfCompareCancelled(options.cancellation);

  return {
    rootPath: normalizedRootPath,
    objects,
    artifactsByObjectId,
    objectsByDescriptorPath,
  };
}

async function collectFiles(
  folderPath: string,
  cancellation?: CompareCancellationToken,
): Promise<string[]> {
  return collectFilesFromDirectories([folderPath], new Set(), cancellation, false);
}

async function collectFilesForObjects(
  objects: readonly ObjectCandidate[],
  cancellation?: CompareCancellationToken,
): Promise<string[]> {
  const files = new Set<string>();
  for (const object of objects) {
    throwIfCompareCancelled(cancellation);
    files.add(path.normalize(object.descriptorPath));
  }

  return collectFilesFromDirectories(objects.map((object) => object.containerPath), files, cancellation, true);
}

async function collectFilesFromDirectories(
  initialDirectories: readonly string[],
  initialFiles: ReadonlySet<string>,
  cancellation?: CompareCancellationToken,
  ignoreNotFoundDirectories = false,
): Promise<string[]> {
  const files = new Set(initialFiles);
  const queue: string[] = [];
  const visitedDirectories = new Set<string>();
  const waitingWorkers = new Set<() => void>();
  let nextDirectory = 0;
  let outstandingDirectories = 0;
  let failed = false;
  let failure: unknown;

  const signalWorkers = (): void => {
    for (const wake of waitingWorkers) {wake();}
    waitingWorkers.clear();
  };
  const enqueueDirectory = (directoryPath: string): void => {
    const normalizedPath = path.normalize(directoryPath);
    const key = normalizeDirectoryVisitKey(normalizedPath);
    if (visitedDirectories.has(key)) {return;}
    visitedDirectories.add(key);
    queue.push(normalizedPath);
    outstandingDirectories += 1;
    signalWorkers();
  };
  const setFailure = (error: unknown): void => {
    if (!failed) {
      failure = error;
      failed = true;
    }
    signalWorkers();
  };

  for (const directoryPath of initialDirectories) {enqueueDirectory(directoryPath);}

  const worker = async (): Promise<void> => {
    while (!failed) {
      if (failed) {return;}
      try {
        throwIfCompareCancelled(cancellation);
      } catch (error) {
        setFailure(error);
        return;
      }

      const directoryPath = queue[nextDirectory];
      if (!directoryPath) {
        if (outstandingDirectories === 0) {return;}
        await new Promise<void>((resolve) => waitingWorkers.add(resolve));
        continue;
      }
      nextDirectory += 1;

      try {
        const entries = await fs.readdir(directoryPath, { withFileTypes: true });
        throwIfCompareCancelled(cancellation);
        if (failed) {continue;}
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          throwIfCompareCancelled(cancellation);
          const entryPath = path.join(directoryPath, entry.name);
          if (entry.isDirectory()) {
            enqueueDirectory(entryPath);
          } else if (entry.isFile()) {
            files.add(path.normalize(entryPath));
          }
        }
      } catch (error) {
        try {
          throwIfCompareCancelled(cancellation);
        } catch (cancelled) {
          setFailure(cancelled);
        }
        if (!failed && (!ignoreNotFoundDirectories || !isNotFoundError(error))) {setFailure(error);}
      } finally {
        outstandingDirectories -= 1;
        signalWorkers();
      }
    }
  };

  const workerCount = initialDirectories.length > 0 ? DIRECTORY_READ_CONCURRENCY : 0;
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (failed) {throw failure;}
  throwIfCompareCancelled(cancellation);
  return [...files].sort((left, right) => left.localeCompare(right));
}

function resolveObjectContainerPath(descriptorPath: string): string {
  const descriptorDirectory = path.dirname(descriptorPath);
  const descriptorBaseName = path.basename(descriptorPath, path.extname(descriptorPath));
  if (path.basename(descriptorDirectory).toLowerCase() === descriptorBaseName.toLowerCase()) {
    return path.normalize(descriptorDirectory);
  }

  const siblingObjectDirectory = path.join(descriptorDirectory, descriptorBaseName);

  return path.normalize(siblingObjectDirectory);
}

function findArtifactOwner(
  filePath: string,
  index: ArtifactOwnerIndex
): ObjectCandidate | undefined {
  const normalizedFilePath = path.normalize(filePath);
  const exact = index.exactDescriptorByPath.get(normalizeKey(normalizedFilePath));
  if (exact) {
    return exact;
  }

  const sidecar = index.directSidecarDirByPath.get(normalizeKey(path.dirname(normalizedFilePath)));
  if (sidecar) {
    return sidecar;
  }

  let cursor = path.dirname(normalizedFilePath);
  while (isSameOrInside(cursor, index.rootPath)) {
    const owner = index.containerByPath.get(normalizeKey(cursor));
    if (owner) {
      return owner;
    }
    const parent = path.dirname(cursor);
    if (samePath(parent, cursor)) {
      break;
    }
    cursor = parent;
  }

  return undefined;
}

function buildArtifactOwnerIndex(
  rootPath: string,
  objects: readonly ObjectCandidate[]
): ArtifactOwnerIndex {
  const exactDescriptorByPath = new Map<string, ObjectCandidate>();
  const containerByPath = new Map<string, ObjectCandidate>();
  const directSidecarDirByPath = new Map<string, ObjectCandidate>();

  for (const object of objects) {
    exactDescriptorByPath.set(normalizeKey(object.descriptorPath), object);
    containerByPath.set(normalizeKey(object.containerPath), object);
    if (samePath(object.containerPath, object.descriptorDirectory)) {
      directSidecarDirByPath.set(normalizeKey(object.descriptorDirectory), object);
    }
  }

  return {
    exactDescriptorByPath,
    containerByPath,
    directSidecarDirByPath,
    rootPath: path.normalize(rootPath),
  };
}

function isPathInside(filePath: string, folderPath: string): boolean {
  const relativePath = path.relative(folderPath, filePath);
  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function samePath(left: string, right: string): boolean {
  return normalizeKey(left) === normalizeKey(right);
}

function isSameOrInside(filePath: string, folderPath: string): boolean {
  return samePath(filePath, folderPath) || isPathInside(filePath, folderPath);
}

function normalizeKey(filePath: string): string {
  return path.normalize(filePath).toLowerCase();
}

function normalizeDirectoryVisitKey(directoryPath: string): string {
  const absolutePath = path.resolve(directoryPath);
  return process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;

  async function run(): Promise<void> {
    while (!failed && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        if (!failed) {
          failure = error;
          failed = true;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, run));
  if (failed) {throw failure;}
  return results;
}
