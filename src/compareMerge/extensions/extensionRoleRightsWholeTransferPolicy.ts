import * as path from 'path';

import { getMetadataTypeDescriptorByRootTag } from '../../constants/metadataTypeDescriptors';
import type { ExtensionIndexedObject } from './extensionMetadataIndex';
import type { ExtensionTransferRow } from './extensionTransfer';

export interface AdoptedRoleRightsWholeTransferBlocker {
  readonly sourceId: string;
  readonly relativePath: string;
  readonly qualifiedName: string;
  readonly rootConfirmed: boolean;
}

export function adoptedRoleRightsWholeTransferBlocker(
  row: ExtensionTransferRow,
): AdoptedRoleRightsWholeTransferBlocker | undefined {
  const roleFolder = getMetadataTypeDescriptorByRootTag('Role')?.designerFolder;
  if (!roleFolder) {return undefined;}

  const roles = [row.target, row.incoming].filter((object): object is ExtensionIndexedObject => object !== undefined);
  if (roles.length === 0 || roles.some((object) => !isCanonicalRoleTransferObject(object, roleFolder))) {return undefined;}
  if ((roles.length === 2 && (roles[0].qualifiedName !== roles[1].qualifiedName || roles[0].name !== roles[1].name))
      || !roles.some((object) => object.identity!.ownership === 'adopted' && Boolean(object.identity!.sourceUuid))) {
    return undefined;
  }

  // Once one side proves this is a borrowed Role pair, inspect both physical
  // records. A whole-row transfer can otherwise copy an own CF Rights.xml into
  // the pair or remove a target-only Rights.xml while replacing the descriptor.
  for (const object of roles) {
    const identity = object.identity!;
    const expectedOwner = `${roleFolder}/${identity.name}`;
    const expectedRightsPath = `${expectedOwner}/Ext/Rights.xml`;
    const rightsFiles = object.sidecarFiles.filter((file) =>
      sameExtensionRelativePath(file.relativePath, expectedRightsPath),
    );
    if (rightsFiles.length > 0) {
      const rights = rightsFiles[0]!;
      return {
        sourceId: object.sourceId,
        relativePath: rights.relativePath,
        qualifiedName: object.qualifiedName,
        rootConfirmed: rightsFiles.length === 1 && rights.rootExpandedName === '{http://v8.1c.ru/8.2/roles}Rights',
      };
    }
  }
  return undefined;
}

export function isCanonicalRoleTransferObject(
  object: ExtensionIndexedObject | undefined,
  roleFolder: string,
): object is ExtensionIndexedObject {
  const identity = object?.identity;
  if (!object || !object.valid || !object.supportedRootType || object.unsupportedReason
      || object.metadataType !== 'Role' || object.descriptorRootTag !== 'Role'
      || identity?.type !== 'Role' || !identity.uuid || identity.name !== object.name
      || !object.descriptorRelativePath || !object.sidecarRelativePath) {
    return false;
  }
  const expectedDescriptor = `${roleFolder}/${identity.name}.xml`;
  const expectedOwner = `${roleFolder}/${identity.name}`;
  return sameExtensionRelativePath(object.descriptorRelativePath, expectedDescriptor)
    && sameExtensionRelativePath(object.sidecarRelativePath, expectedOwner)
    && sameExtensionRelativePath(identity.path, expectedDescriptor);
}

export function sameExtensionRelativePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left).replace(/\\/gu, '/');
  const normalizedRight = path.normalize(right).replace(/\\/gu, '/');
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}
