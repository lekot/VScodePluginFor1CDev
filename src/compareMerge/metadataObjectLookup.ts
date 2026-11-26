import * as path from 'path';

import type { MetadataIdentity } from './domain/compareContracts';
import type { ConfigurationInventory, MetadataObjectUnit } from './inventory/configurationInventory';

export function metadataDescriptorPathKey(filePath: string): string {
  // Descriptor map keys are case-folded on every host so producers and consumers share one policy.
  return path.normalize(filePath).toLowerCase();
}

export function metadataManifestRelativePathKey(relativePath: string): string {
  const normalized = relativePath.replace(/\\/gu, '/');
  let end = normalized.length;
  while (end > 0 && normalized.charCodeAt(end - 1) === 47) {end -= 1;}
  return normalized.slice(0, end).toLowerCase();
}

export function metadataIdentityToObjectUnit(identity: MetadataIdentity): MetadataObjectUnit {
  const descriptorPath = path.normalize(identity.filePath);
  const objectId = identity.uuid ? `uuid:${identity.uuid}` : `name:${identity.qualifiedName}`;
  return {
    objectId,
    qualifiedName: identity.qualifiedName,
    metadataType: identity.metadataType,
    uuid: identity.uuid,
    descriptorPath,
    containerPath: resolveObjectContainerPath(descriptorPath),
  };
}

export function findInventoryObjectByDescriptor(
  inventory: ConfigurationInventory,
  descriptorPath: string,
): MetadataObjectUnit | undefined {
  const normalizedDescriptorPath = metadataDescriptorPathKey(descriptorPath);
  return inventory.objectsByDescriptorPath.get(normalizedDescriptorPath);
}

function resolveObjectContainerPath(descriptorPath: string): string {
  const descriptorDirectory = path.dirname(descriptorPath);
  const descriptorBaseName = path.basename(descriptorPath, path.extname(descriptorPath));
  if (path.basename(descriptorDirectory).toLowerCase() === descriptorBaseName.toLowerCase()) {
    return path.normalize(descriptorDirectory);
  }
  return path.normalize(path.join(descriptorDirectory, descriptorBaseName));
}
