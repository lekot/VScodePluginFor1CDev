import * as path from 'path';

import type { ArtifactUnit, ConfigurationInventory, MetadataObjectUnit } from '../adapters/mergeAdapter';
import type { ExtensionIndexedObject, ExtensionMetadataIndex } from './extensionMetadataIndex';
import { normalizeArtifactPath, ownerRelativePath } from './extensionSemanticSidecars';

/** Converts one captured metadata index into the adapter's immutable inventory view. */
export function toExtensionSemanticInventory(index: ExtensionMetadataIndex): ConfigurationInventory {
  const root = index.canonicalRootPath ?? index.rootPath;
  const objects: MetadataObjectUnit[] = [];
  const artifactsByObjectId = new Map<string, ArtifactUnit[]>();
  for (const object of index.objects) {
    if (!object.descriptorRelativePath) {continue;}
    const unit = toObjectUnit(root, object);
    objects.push(unit);
    const artifacts: ArtifactUnit[] = [];
    if (object.descriptorHash) {
      artifacts.push({
        artifactId: `${unit.objectId}:descriptor`, ownerObjectId: unit.objectId, kind: 'metadataXml',
        relativePath: object.descriptorRelativePath, filePath: unit.descriptorPath,
        contentHash: object.descriptorHash, mergeMode: 'xmlPatch',
      });
    }
    for (const file of object.sidecarFiles) {
      const relative = ownerRelativePath(object, file.relativePath);
      const baseName = path.posix.basename(relative.replace(/\\/gu, '/')).toLowerCase();
      const kind = baseName === 'form.xml' ? 'formXml'
        : baseName === 'predefined.xml' ? 'predefinedXml'
          : baseName === 'rights.xml' && file.rootExpandedName === '{http://v8.1c.ru/8.2/roles}Rights' ? 'roleRightsXml'
            : baseName === 'template.xml' && file.rootExpandedName === '{http://v8.1c.ru/8.1/data-composition-system/schema}DataCompositionSchema' ? 'dcsXml'
              : undefined;
      if (!kind) {continue;}
      artifacts.push({
        artifactId: `${unit.objectId}:${normalizeArtifactPath(file.relativePath)}`, ownerObjectId: unit.objectId,
        kind, relativePath: file.relativePath, filePath: path.join(root, file.relativePath),
        contentHash: file.hash, mergeMode: 'xmlPatch',
      });
    }
    artifactsByObjectId.set(unit.objectId, artifacts);
  }
  return { rootPath: root, objects, artifactsByObjectId };
}

function toObjectUnit(root: string, object: ExtensionIndexedObject): MetadataObjectUnit {
  const descriptorPath = path.join(root, object.descriptorRelativePath!);
  const containerPath = object.sidecarRelativePath
    ? path.join(root, object.sidecarRelativePath)
    : path.dirname(descriptorPath);
  return {
    objectId: `${object.sourceId}:${object.qualifiedName.toLowerCase()}:${object.identity?.uuid.toLowerCase() ?? 'invalid'}`,
    qualifiedName: object.qualifiedName,
    metadataType: object.metadataType,
    ...(object.identity?.uuid ? { uuid: object.identity.uuid } : {}),
    descriptorPath,
    containerPath,
  };
}
