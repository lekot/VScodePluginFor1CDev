import * as path from 'path';

import type { CompareMessage, MatchResult, MetadataIdentity } from './domain/compareContracts';
import type { ArtifactUnit, ConfigurationInventory, MetadataObjectUnit } from './inventory/configurationInventory';
import { KNOWN_ROOT_METADATA_TYPES } from './metadata/metadataIndexer';
import { metadataIdentityToObjectUnit } from './metadataObjectLookup';
import type { LinkedDesignerRootConfigurationSnapshot, LinkedRootObjectCopyRecipe } from './linkedDesignerTypes';
import { blocked, canonicalRelativePath, stripHash } from './linkedDesignerUtils';
import {
  artifactsFor,
  fileObjectNodeIdForIdentity,
  findIndexedPackageObject,
  samePath,
} from './linkedDesignerPackageIndexSupport';
import { rootRegistrationIsAvailable, type RootConfigurationCapture } from './linkedDesignerRootConfiguration';

export async function buildWholeObjectCopyRecipes(input: {
  strategy: 'left' | 'right' | 'full';
  metadata: MatchResult;
  rightInventory: ConfigurationInventory;
  rootConfiguration?: LinkedDesignerRootConfigurationSnapshot;
  rootConfigurationCapture: RootConfigurationCapture;
  identityCounts: ReadonlyMap<string, number>;
  diagnostics: CompareMessage[];
  blockedPresenceNodeIds: Map<string, string>;
}): Promise<Map<string, LinkedRootObjectCopyRecipe>> {
  const recipes = new Map<string, LinkedRootObjectCopyRecipe>();
  if (input.strategy === 'left') {return recipes;}
  const packageBackedRootTypes = new Set(['CommonForm', 'CommonTemplate', 'CommonCommand']);
  for (const identity of input.metadata.unmatchedRight) {
    processWholeObjectCopyIdentity(input, recipes, identity, packageBackedRootTypes);
  }
  return recipes;
}

function processWholeObjectCopyIdentity(
  input: Parameters<typeof buildWholeObjectCopyRecipes>[0],
  recipes: Map<string, LinkedRootObjectCopyRecipe>,
  identity: MetadataIdentity,
  packageBackedRootTypes: ReadonlySet<string>,
): void {
  if (!KNOWN_ROOT_METADATA_TYPES.has(identity.metadataType) || packageBackedRootTypes.has(identity.metadataType)) {return;}
  const parts = wholeObjectQualifiedNameParts(identity);
  if (!parts) {return;}
  const nodeId = fileObjectNodeIdForIdentity(identity, 'copy');
  if (!isUniqueWholeObjectIdentity(input, identity)) {
    failWholeObjectCopy(input, identity, nodeId, 'Имя переносимого корневого объекта неоднозначно; устраните дубликаты и повторите сравнение.');
    return;
  }
  const details = resolveWholeObjectCopyDetails(input, identity);
  if (!details) {
    failWholeObjectCopy(input, identity, nodeId, 'Дескриптор или каталог корневого объекта не ограничены корнем source.');
    return;
  }
  const configurationMode = resolveWholeObjectConfigurationMode(input, identity, parts[1]);
  if (!configurationMode) {
    failWholeObjectCopy(input, identity, nodeId, 'Корневую регистрацию объекта нельзя безопасно добавить: обе Configuration.xml должны подтверждать только source-регистрацию.');
    return;
  }
  addWholeObjectCopyRecipe(recipes, identity, nodeId, parts[1], details, configurationMode);
}

function wholeObjectQualifiedNameParts(identity: MetadataIdentity): [string, string] | undefined {
  const parts = identity.qualifiedName.split('.');
  return parts.length === 2 && parts[0] === identity.metadataType && parts[1]
    ? [parts[0], parts[1]]
    : undefined;
}

function isUniqueWholeObjectIdentity(
  input: Parameters<typeof buildWholeObjectCopyRecipes>[0],
  identity: MetadataIdentity,
): boolean {
  const identityKey = `${identity.sourceId}\0${identity.qualifiedName.normalize('NFC').toLocaleLowerCase('en-US')}`;
  return input.identityCounts.get(identityKey) === 1;
}

function failWholeObjectCopy(
  input: Parameters<typeof buildWholeObjectCopyRecipes>[0],
  identity: MetadataIdentity,
  nodeId: string,
  message: string,
): void {
  input.diagnostics.push(blocked(message, identity.sourceId, identity.qualifiedName));
  input.blockedPresenceNodeIds.set(nodeId, message);
}

interface WholeObjectCopyDetails {
  readonly object: MetadataObjectUnit;
  readonly descriptor?: ArtifactUnit;
  readonly descriptorRelativePath: string;
}

function resolveWholeObjectCopyDetails(
  input: Parameters<typeof buildWholeObjectCopyRecipes>[0],
  identity: MetadataIdentity,
): WholeObjectCopyDetails | undefined {
  const indexed = findIndexedPackageObject(identity, input.rightInventory);
  const object = indexed?.object ?? metadataIdentityToObjectUnit(identity);
  const descriptor = indexed && artifactsFor(indexed.inventory, indexed.object)
    .find((artifact) => artifact.kind === 'metadataXml' && samePath(artifact.filePath, identity.filePath));
  const descriptorRelativePath = canonicalRelativePath(input.rightInventory.rootPath, identity.filePath);
  const containerRelativePath = canonicalRelativePath(input.rightInventory.rootPath, object.containerPath);
  if (!descriptorRelativePath || !containerRelativePath
    || (descriptor && !samePath(descriptor.filePath, identity.filePath))) {
    return undefined;
  }
  return { object, ...(descriptor ? { descriptor } : {}), descriptorRelativePath };
}

function resolveWholeObjectConfigurationMode(
  input: Parameters<typeof buildWholeObjectCopyRecipes>[0],
  identity: MetadataIdentity,
  objectName: string,
): 'registered' | 'legacyLoose' | undefined {
  const capture = input.rootConfigurationCapture;
  if (capture.targetState === 'missing' && capture.sourceState === 'missing') {return 'legacyLoose';}
  const rootRegistration = { rootTag: identity.metadataType, objectName };
  return capture.targetState === 'file' && capture.sourceState === 'file'
    && input.rootConfiguration
    && rootRegistrationIsAvailable({ action: 'copy', rootRegistration }, input.rootConfiguration)
    ? 'registered'
    : undefined;
}

function addWholeObjectCopyRecipe(
  recipes: Map<string, LinkedRootObjectCopyRecipe>,
  identity: MetadataIdentity,
  nodeId: string,
  objectName: string,
  details: WholeObjectCopyDetails,
  configurationMode: 'registered' | 'legacyLoose',
): void {
  const relativeDescriptorFromContainer = path.relative(details.object.containerPath, identity.filePath);
  const descriptorInContainer = relativeDescriptorFromContainer === ''
    || (!relativeDescriptorFromContainer.startsWith('..') && !path.isAbsolute(relativeDescriptorFromContainer));
  recipes.set(nodeId, {
    nodeId,
    action: 'copy',
    qualifiedName: identity.qualifiedName,
    rootRegistration: { rootTag: identity.metadataType, objectName },
    registrationNodeId: nodeId,
    configurationMode,
    sourceContainerPath: details.object.containerPath,
    sourceDescriptorRelativePath: details.descriptorRelativePath,
    ...(details.descriptor ? { sourceDescriptorHash: stripHash(details.descriptor.contentHash) } : {}),
    ...(identity.uuid ? { sourceUuid: identity.uuid } : {}),
    sourceDescriptorInContainer: descriptorInContainer,
  });
}
