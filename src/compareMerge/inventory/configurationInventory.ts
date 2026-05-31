import * as fs from 'fs/promises';
import * as path from 'path';

import { indexMetadataFolder } from '../metadata/metadataIndexer';
import {
  createArtifactUnit,
  type ArtifactKind,
  type ArtifactMergeMode,
  type ArtifactUnit,
} from './configurationArtifacts';

export { type ArtifactKind, type ArtifactMergeMode, type ArtifactUnit };

export interface ConfigurationInventory {
  rootPath: string;
  objects: MetadataObjectUnit[];
  artifactsByObjectId: ReadonlyMap<string, ArtifactUnit[]>;
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

export async function buildConfigurationInventory(rootPath: string): Promise<ConfigurationInventory> {
  const normalizedRootPath = path.normalize(rootPath);
  const identities = await indexMetadataFolder({
    sourceId: 'configuration-inventory',
    side: 'left',
    folderPath: normalizedRootPath,
  });
  const objects: ObjectCandidate[] = identities
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

  const files = await collectFiles(normalizedRootPath);
  const artifactsByObjectId = new Map<string, ArtifactUnit[]>();

  for (const object of objects) {
    artifactsByObjectId.set(object.objectId, []);
  }

  for (const filePath of files) {
    const owner = findArtifactOwner(filePath, objects);
    if (!owner) {
      continue;
    }

    const artifact = await createArtifactUnit({
      rootPath: normalizedRootPath,
      ownerObjectId: owner.objectId,
      filePath,
      descriptorPath: owner.descriptorPath,
    });
    artifactsByObjectId.get(owner.objectId)?.push(artifact);
  }

  for (const artifacts of artifactsByObjectId.values()) {
    artifacts.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  return {
    rootPath: normalizedRootPath,
    objects,
    artifactsByObjectId,
  };
}

async function collectFiles(folderPath: string): Promise<string[]> {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(path.normalize(entryPath));
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
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
  objects: readonly ObjectCandidate[]
): ObjectCandidate | undefined {
  const matchingObjects = objects.filter(
    (object) =>
      samePath(filePath, object.descriptorPath) ||
      isPathInside(filePath, object.containerPath) ||
      isDirectDescriptorSidecar(filePath, object)
  );

  return matchingObjects.sort(
    (left, right) => ownerSpecificity(right) - ownerSpecificity(left)
  )[0];
}

function isDirectDescriptorSidecar(filePath: string, object: ObjectCandidate): boolean {
  return (
    samePath(path.dirname(filePath), object.descriptorDirectory) &&
    samePath(object.containerPath, object.descriptorDirectory)
  );
}

function ownerSpecificity(object: ObjectCandidate): number {
  return Math.max(object.containerPath.length, object.descriptorPath.length);
}

function isPathInside(filePath: string, folderPath: string): boolean {
  const relativePath = path.relative(folderPath, filePath);
  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function samePath(left: string, right: string): boolean {
  return path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();
}
