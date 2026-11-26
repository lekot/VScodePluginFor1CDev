import * as fs from 'fs/promises';
import * as path from 'path';

import type { MetadataIdentity } from '../domain/compareContracts';
import { throwIfCompareCancelled, type CompareCancellationToken } from '../compareCancellation';
import { indexMetadataFolder } from '../metadata/metadataIndexer';

export type ConfigurationArtifactKindHint =
  | 'metadataXml'
  | 'formXml'
  | 'predefinedXml'
  | 'bslModule'
  | 'rootProbeRequired'
  | 'binaryOrOpaqueFile';

export interface ConfigurationFileManifestEntry {
  readonly filePath: string;
  readonly relativePath: string;
  readonly ownerObjectId: string;
  readonly isDescriptor: boolean;
  readonly artifactKindHint: ConfigurationArtifactKindHint;
}

export interface ConfigurationFileManifestDirectory {
  readonly filePath: string;
  readonly relativePath: string;
  readonly ownerObjectId: string;
}

export interface ConfigurationFileManifestObject {
  readonly objectId: string;
  readonly qualifiedName: string;
  readonly metadataType: string;
  readonly uuid?: string;
  readonly descriptorPath: string;
  readonly containerPath: string;
}

export interface ConfigurationFileManifest {
  readonly rootPath: string;
  readonly objects: readonly ConfigurationFileManifestObject[];
  readonly entries: readonly ConfigurationFileManifestEntry[];
  readonly directoriesByOwnerObjectId: ReadonlyMap<string, readonly ConfigurationFileManifestDirectory[]>;
  readonly objectsByDescriptorPath: ReadonlyMap<string, ConfigurationFileManifestObject>;
  readonly entriesByOwnerObjectId: ReadonlyMap<string, readonly ConfigurationFileManifestEntry[]>;
  readonly entriesByRelativePath: ReadonlyMap<string, readonly ConfigurationFileManifestEntry[]>;
  readonly directoryPathsByRelativePath: ReadonlySet<string>;
  readonly subtreeFileCountsByDirectory: ReadonlyMap<string, number>;
  readonly subtreeDirectoryCountsByDirectory: ReadonlyMap<string, number>;
}

interface ManifestObject extends ConfigurationFileManifestObject {
  readonly descriptorDirectory: string;
}

interface OwnerIndex {
  readonly exactDescriptorByPath: ReadonlyMap<string, ManifestObject>;
  readonly containerByPath: ReadonlyMap<string, ManifestObject>;
  readonly directSidecarDirByPath: ReadonlyMap<string, ManifestObject>;
  readonly rootPath: string;
}

const DIRECTORY_READ_CONCURRENCY = 8;

/** Enumerates metadata-owned paths without reading file contents. */
export async function buildConfigurationFileManifest(
  rootPath: string,
  options: {
    readonly identities?: readonly MetadataIdentity[];
    readonly cancellation?: CompareCancellationToken;
  } = {},
): Promise<ConfigurationFileManifest> {
  throwIfCompareCancelled(options.cancellation);
  const normalizedRootPath = path.normalize(rootPath);
  const identities = options.identities ?? await indexMetadataFolder({
    sourceId: 'configuration-file-manifest',
    side: 'left',
    folderPath: normalizedRootPath,
    cancellation: options.cancellation,
  });
  const objects = createManifestObjects(identities);

  const ownerIndex = buildOwnerIndex(normalizedRootPath, objects);
  const candidatePaths = new Set(objects.map((object) => object.descriptorPath));
  const candidateDirectories = new Set<string>();
  await collectMetadataOwnedPaths(objects.map((object) => object.containerPath), candidatePaths, candidateDirectories, options.cancellation);
  const objectsByDescriptorPath = indexManifestObjects(objects);
  const ownedEntries = collectOwnedFileEntries(candidatePaths, normalizedRootPath, ownerIndex, options.cancellation);
  const directoriesByOwnerObjectId = collectOwnedDirectoryEntries(
    candidateDirectories,
    normalizedRootPath,
    ownerIndex,
    options.cancellation
  );
  const treeIndexes = buildManifestTreeIndexes(ownedEntries.entries, directoriesByOwnerObjectId);
  throwIfCompareCancelled(options.cancellation);

  return {
    rootPath: normalizedRootPath,
    objects: objects.map(stripInternalObjectFields),
    entries: ownedEntries.entries,
    directoriesByOwnerObjectId,
    objectsByDescriptorPath,
    entriesByOwnerObjectId: ownedEntries.entriesByOwnerObjectId,
    entriesByRelativePath: treeIndexes.entriesByRelativePath,
    directoryPathsByRelativePath: treeIndexes.directoryPathsByRelativePath,
    subtreeFileCountsByDirectory: treeIndexes.subtreeFileCountsByDirectory,
    subtreeDirectoryCountsByDirectory: treeIndexes.subtreeDirectoryCountsByDirectory,
  };
}

interface OwnedFileEntries {
  readonly entries: ConfigurationFileManifestEntry[];
  readonly entriesByOwnerObjectId: Map<string, ConfigurationFileManifestEntry[]>;
}

interface ManifestTreeIndexes {
  readonly entriesByRelativePath: Map<string, ConfigurationFileManifestEntry[]>;
  readonly directoryPathsByRelativePath: Set<string>;
  readonly subtreeFileCountsByDirectory: Map<string, number>;
  readonly subtreeDirectoryCountsByDirectory: Map<string, number>;
}

function createManifestObjects(identities: readonly MetadataIdentity[]): ManifestObject[] {
  return identities.map((identity) => {
    const descriptorPath = path.normalize(identity.filePath);
    const descriptorDirectory = path.dirname(descriptorPath);
    return {
      objectId: metadataObjectId(identity),
      qualifiedName: identity.qualifiedName,
      metadataType: identity.metadataType,
      uuid: identity.uuid,
      descriptorPath,
      containerPath: resolveObjectContainerPath(descriptorPath),
      descriptorDirectory,
    };
  }).sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName));
}

function indexManifestObjects(objects: readonly ManifestObject[]): Map<string, ConfigurationFileManifestObject> {
  const objectsByDescriptorPath = new Map<string, ConfigurationFileManifestObject>();
  for (const object of objects) {
    objectsByDescriptorPath.set(normalizeKey(object.descriptorPath), stripInternalObjectFields(object));
  }
  return objectsByDescriptorPath;
}

function collectOwnedFileEntries(
  candidatePaths: ReadonlySet<string>,
  normalizedRootPath: string,
  ownerIndex: OwnerIndex,
  cancellation?: CompareCancellationToken
): OwnedFileEntries {
  const entriesByOwnerObjectId = new Map<string, ConfigurationFileManifestEntry[]>();
  const entries: ConfigurationFileManifestEntry[] = [];
  for (const filePath of [...candidatePaths].sort((left, right) => left.localeCompare(right))) {
    throwIfCompareCancelled(cancellation);
    const owner = findOwner(filePath, ownerIndex);
    if (!owner) {continue;}
    const isDescriptor = samePath(filePath, owner.descriptorPath);
    const entry: ConfigurationFileManifestEntry = {
      filePath,
      relativePath: path.relative(normalizedRootPath, filePath),
      ownerObjectId: owner.objectId,
      isDescriptor,
      artifactKindHint: artifactKindHint(filePath, isDescriptor),
    };
    entries.push(entry);
    const ownedEntries = entriesByOwnerObjectId.get(owner.objectId) ?? [];
    ownedEntries.push(entry);
    entriesByOwnerObjectId.set(owner.objectId, ownedEntries);
  }
  for (const ownedEntries of entriesByOwnerObjectId.values()) {
    ownedEntries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }
  return { entries, entriesByOwnerObjectId };
}

function collectOwnedDirectoryEntries(
  candidateDirectories: ReadonlySet<string>,
  normalizedRootPath: string,
  ownerIndex: OwnerIndex,
  cancellation?: CompareCancellationToken
): Map<string, ConfigurationFileManifestDirectory[]> {
  const directoriesByOwnerObjectId = new Map<string, ConfigurationFileManifestDirectory[]>();
  for (const filePath of [...candidateDirectories].sort((left, right) => left.localeCompare(right))) {
    throwIfCompareCancelled(cancellation);
    const owner = findDirectoryOwner(filePath, ownerIndex);
    if (!owner) {continue;}
    const directory: ConfigurationFileManifestDirectory = {
      filePath,
      relativePath: path.relative(normalizedRootPath, filePath),
      ownerObjectId: owner.objectId,
    };
    const ownedDirectories = directoriesByOwnerObjectId.get(owner.objectId) ?? [];
    ownedDirectories.push(directory);
    directoriesByOwnerObjectId.set(owner.objectId, ownedDirectories);
  }
  for (const ownedDirectories of directoriesByOwnerObjectId.values()) {
    ownedDirectories.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }
  return directoriesByOwnerObjectId;
}

function buildManifestTreeIndexes(
  entries: readonly ConfigurationFileManifestEntry[],
  directoriesByOwnerObjectId: ReadonlyMap<string, readonly ConfigurationFileManifestDirectory[]>
): ManifestTreeIndexes {
  const entriesByRelativePath = indexEntriesByRelativePath(entries);
  const allDirectories = [...directoriesByOwnerObjectId.values()].flat();
  const directoryPathsByRelativePath = new Set(allDirectories.map((directory) => normalizeRelativeKey(directory.relativePath)));
  const subtreeFileCountsByDirectory = countSubtreeFiles(entries);
  const subtreeDirectoryCountsByDirectory = countSubtreeDirectories(allDirectories);
  return {
    entriesByRelativePath,
    directoryPathsByRelativePath,
    subtreeFileCountsByDirectory,
    subtreeDirectoryCountsByDirectory,
  };
}

function indexEntriesByRelativePath(
  entries: readonly ConfigurationFileManifestEntry[]
): Map<string, ConfigurationFileManifestEntry[]> {
  const entriesByRelativePath = new Map<string, ConfigurationFileManifestEntry[]>();
  for (const entry of entries) {
    const key = normalizeRelativeKey(entry.relativePath);
    const matches = entriesByRelativePath.get(key) ?? [];
    matches.push(entry);
    entriesByRelativePath.set(key, matches);
  }
  return entriesByRelativePath;
}

function countSubtreeFiles(entries: readonly ConfigurationFileManifestEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const directoryKey of parentDirectoryKeys(entry.relativePath)) {
      counts.set(directoryKey, (counts.get(directoryKey) ?? 0) + 1);
    }
  }
  return counts;
}

function countSubtreeDirectories(
  directories: readonly ConfigurationFileManifestDirectory[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const directory of directories) {
    for (const directoryKey of ancestorDirectoryKeys(directory.relativePath, true)) {
      counts.set(directoryKey, (counts.get(directoryKey) ?? 0) + 1);
    }
  }
  return counts;
}

export function metadataObjectId(identity: Pick<MetadataIdentity, 'uuid' | 'qualifiedName'>): string {
  return identity.uuid ? `uuid:${identity.uuid}` : `name:${identity.qualifiedName}`;
}

function stripInternalObjectFields(object: ManifestObject): ConfigurationFileManifestObject {
  return {
    objectId: object.objectId,
    qualifiedName: object.qualifiedName,
    metadataType: object.metadataType,
    ...(object.uuid ? { uuid: object.uuid } : {}),
    descriptorPath: object.descriptorPath,
    containerPath: object.containerPath,
  };
}

async function collectMetadataOwnedPaths(
  initialDirectories: readonly string[],
  files: Set<string>,
  directories: Set<string>,
  cancellation?: CompareCancellationToken,
): Promise<void> {
  const queue: string[] = [];
  const visitedDirectories = new Set<string>();
  const initialDirectoryKeys = new Set(initialDirectories.map((directoryPath) => normalizeDirectoryVisitKey(directoryPath)));
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
        directories.add(path.normalize(directoryPath));
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
        const missingInitialContainer = isNotFoundError(error)
          && initialDirectoryKeys.has(normalizeDirectoryVisitKey(directoryPath));
        if (!failed && !missingInitialContainer) {setFailure(error);}
      } finally {
        outstandingDirectories -= 1;
        signalWorkers();
      }
    }
  };

  await Promise.all(Array.from({ length: initialDirectories.length > 0 ? DIRECTORY_READ_CONCURRENCY : 0 }, () => worker()));
  if (failed) {throw failure;}
  throwIfCompareCancelled(cancellation);
}

function buildOwnerIndex(rootPath: string, objects: readonly ManifestObject[]): OwnerIndex {
  const exactDescriptorByPath = new Map<string, ManifestObject>();
  const containerByPath = new Map<string, ManifestObject>();
  const directSidecarDirByPath = new Map<string, ManifestObject>();
  for (const object of objects) {
    exactDescriptorByPath.set(normalizeKey(object.descriptorPath), object);
    containerByPath.set(normalizeKey(object.containerPath), object);
    if (samePath(object.containerPath, object.descriptorDirectory)) {
      directSidecarDirByPath.set(normalizeKey(object.descriptorDirectory), object);
    }
  }
  return { exactDescriptorByPath, containerByPath, directSidecarDirByPath, rootPath: path.normalize(rootPath) };
}

function findOwner(filePath: string, index: OwnerIndex): ManifestObject | undefined {
  const normalizedFilePath = path.normalize(filePath);
  const exact = index.exactDescriptorByPath.get(normalizeKey(normalizedFilePath));
  if (exact) {return exact;}
  const sidecar = index.directSidecarDirByPath.get(normalizeKey(path.dirname(normalizedFilePath)));
  if (sidecar) {return sidecar;}
  let cursor = path.dirname(normalizedFilePath);
  while (isSameOrInside(cursor, index.rootPath)) {
    const owner = index.containerByPath.get(normalizeKey(cursor));
    if (owner) {return owner;}
    const parent = path.dirname(cursor);
    if (samePath(parent, cursor)) {break;}
    cursor = parent;
  }
  return undefined;
}

function findDirectoryOwner(directoryPath: string, index: OwnerIndex): ManifestObject | undefined {
  const normalizedPath = path.normalize(directoryPath);
  const exactContainer = index.containerByPath.get(normalizeKey(normalizedPath));
  if (exactContainer) {return exactContainer;}
  const sidecar = index.directSidecarDirByPath.get(normalizeKey(normalizedPath));
  if (sidecar) {return sidecar;}
  let cursor = path.dirname(normalizedPath);
  while (isSameOrInside(cursor, index.rootPath)) {
    const owner = index.containerByPath.get(normalizeKey(cursor));
    if (owner) {return owner;}
    const parent = path.dirname(cursor);
    if (samePath(parent, cursor)) {break;}
    cursor = parent;
  }
  return undefined;
}

function resolveObjectContainerPath(descriptorPath: string): string {
  const descriptorDirectory = path.dirname(descriptorPath);
  const descriptorBaseName = path.basename(descriptorPath, path.extname(descriptorPath));
  if (path.basename(descriptorDirectory).toLowerCase() === descriptorBaseName.toLowerCase()) {
    return path.normalize(descriptorDirectory);
  }
  return path.normalize(path.join(descriptorDirectory, descriptorBaseName));
}

function artifactKindHint(filePath: string, isDescriptor: boolean): ConfigurationArtifactKindHint {
  if (isDescriptor) {return 'metadataXml';}
  if (path.extname(filePath).toLowerCase() === '.bsl') {return 'bslModule';}
  const basename = path.basename(filePath).toLowerCase();
  if (basename === 'form.xml') {return 'formXml';}
  if (basename === 'predefined.xml') {return 'predefinedXml';}
  if (basename === 'rights.xml' || basename === 'template.xml') {return 'rootProbeRequired';}
  return 'binaryOrOpaqueFile';
}

function isPathInside(filePath: string, folderPath: string): boolean {
  const relativePath = path.relative(folderPath, filePath);
  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function isSameOrInside(filePath: string, folderPath: string): boolean {
  return samePath(filePath, folderPath) || isPathInside(filePath, folderPath);
}

function samePath(left: string, right: string): boolean {
  return normalizeKey(left) === normalizeKey(right);
}

function normalizeKey(filePath: string): string {
  return path.normalize(filePath).toLowerCase();
}

function normalizeRelativeKey(relativePath: string): string {
  return relativePath.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase();
}

function parentDirectoryKeys(relativePath: string): string[] {
  return ancestorDirectoryKeys(relativePath, false);
}

function ancestorDirectoryKeys(relativePath: string, includeSelf: boolean): string[] {
  const normalized = normalizeRelativeKey(relativePath);
  const segments = normalized.split('/').filter(Boolean);
  const result: string[] = [];
  const lastExclusive = includeSelf ? segments.length : segments.length - 1;
  for (let length = lastExclusive; length > 0; length -= 1) {
    result.push(segments.slice(0, length).join('/'));
  }
  return result;
}

function normalizeDirectoryVisitKey(directoryPath: string): string {
  const absolutePath = path.resolve(directoryPath);
  return process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}
