import * as path from 'path';

import type { MetadataIdentity } from './domain/compareContracts';
import type { ConfigurationInventory, MetadataObjectUnit } from './inventory/configurationInventory';

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
  const normalizedDescriptorPath = path.normalize(descriptorPath).toLowerCase();
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
