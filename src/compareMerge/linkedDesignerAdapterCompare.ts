import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';

import type { AdapterCompareInput, AdapterCompareResult, MetadataObjectMatch, MetadataObjectUnit } from './adapters/mergeAdapter';
import type { ArtifactUnit, ConfigurationInventory } from './inventory/configurationInventory';
import { attachMetadataReferenceContext, buildMetadataReferenceContext } from './adapters/metadataReferenceContext';
import { metadataXmlAdapter } from './adapters/xmlMetadataAdapter';
import { formXmlAdapter } from './adapters/formXmlAdapter';
import { predefinedXmlAdapter } from './adapters/predefinedXmlAdapter';
import { roleRightsXmlAdapter } from './adapters/roleRightsXmlAdapter';
import { dcsXmlAdapter } from './adapters/dcsXmlAdapter';
import { parseXmlDocument, elementChildren, textContent } from './xml/xmlDom';
import { namespaceUriForName } from './adapters/semanticXml/semanticXmlIdentity';
import { stripHash } from './linkedDesignerUtils';
import type { CompareSession } from './domain/compareSession';
import { throwIfCompareCancelled, type CompareCancellationToken } from './compareCancellation';
import type { CompareJoinStrategy } from './configurationCompareWorkspace';
import type { LinkedDefaultFormDependency, LinkedDesignerPackageRecipe, LinkedEventDependency, LinkedFormModuleSnapshot } from './linkedDesignerTypes';
import { buildLinkedDesignerAdapterContext, collectDefaultFormDependencies, collectEventRoutineDependencies, findFormModuleSnapshot } from './linkedDesignerContext';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';

export async function compareLinkedDesignerXmlArtifact(
  input: {
    readonly strategy: CompareJoinStrategy;
    readonly leftInventory: ConfigurationInventory;
    readonly rightInventory: ConfigurationInventory;
    readonly session: CompareSession;
    readonly cancellation?: CompareCancellationToken;
    readonly readTextFile?: (filePath: string) => Promise<string>;
    readonly linkedDesignerPackages: readonly LinkedDesignerPackageRecipe[];
    readonly linkedModules: readonly LinkedFormModuleSnapshot[];
    readonly eventRoutineDependencies: Map<string, LinkedEventDependency>;
    readonly defaultFormDependencies: Map<string, LinkedDefaultFormDependency>;
  },
  match: MetadataObjectMatch,
  artifactPair: { left: ArtifactUnit; right: ArtifactUnit },
  artifactKind: 'metadataXml' | 'formXml' | 'predefinedXml' | 'roleRightsXml' | 'dcsXml',
  metadataReferenceContext: Awaited<ReturnType<typeof buildMetadataReferenceContext>>,
): Promise<AdapterCompareResult> {
  throwIfCompareCancelled(input.cancellation);
  const leftFormObject = artifactKind === 'formXml' ? formObjectForArtifact(input.leftInventory, artifactPair.left) : undefined;
  const rightFormObject = artifactKind === 'formXml' ? formObjectForArtifact(input.rightInventory, artifactPair.right) : undefined;
  const pairedFormName = leftFormObject && rightFormObject
    && leftFormObject.metadataType === rightFormObject.metadataType
    && normalizeQualifiedName(leftFormObject.qualifiedName) === normalizeQualifiedName(rightFormObject.qualifiedName)
    ? leftFormObject.qualifiedName
    : undefined;
  const readTextFile = input.readTextFile ?? ((filePath: string) => fs.readFile(filePath, 'utf-8'));
  const [leftSnapshot, rightSnapshot] = await Promise.all([
    readTextFile(artifactPair.left.filePath),
    readTextFile(artifactPair.right.filePath),
  ]);
  throwIfCompareCancelled(input.cancellation);
  const adapterInput: AdapterCompareInput = {
    strategy: input.strategy,
    leftInventory: input.leftInventory,
    rightInventory: input.rightInventory,
    match,
    session: input.session,
    artifactPaths: { left: artifactPair.left.filePath, right: artifactPair.right.filePath },
    snapshots: { left: leftSnapshot, right: rightSnapshot },
    linkedDesignerContext: buildLinkedDesignerAdapterContext({
      match,
      artifactKind,
      ...(pairedFormName ? { formQualifiedName: pairedFormName } : {}),
      leftSnapshot,
      rightSnapshot,
      leftInventory: input.leftInventory,
      packages: input.linkedDesignerPackages,
      modules: input.linkedModules,
    }),
  };
  const context = artifactKind === 'dcsXml'
    ? await attachDcsOwnerVersions(metadataReferenceContext, artifactPair, input, readTextFile)
    : metadataReferenceContext;
  attachMetadataReferenceContext(adapterInput, context);

  let result: AdapterCompareResult;
  switch (artifactKind) {
    case 'metadataXml': result = await metadataXmlAdapter.compare(adapterInput); break;
    case 'formXml': result = await formXmlAdapter.compare(adapterInput); break;
    case 'predefinedXml': result = await predefinedXmlAdapter.compare(adapterInput); break;
    case 'roleRightsXml': result = await roleRightsXmlAdapter.compare(adapterInput); break;
    case 'dcsXml': result = await dcsXmlAdapter.compare(adapterInput); break;
  }
  if (artifactKind === 'formXml' && match.right) {
    const module = pairedFormName ? findFormModuleSnapshot(pairedFormName, input.linkedModules) : undefined;
    if (module) {
      collectEventRoutineDependencies(result.nodes, adapterInput.linkedDesignerContext?.formEventHandlers ?? [], module, input.eventRoutineDependencies);
    }
  }
  if (artifactKind === 'metadataXml') {
    collectDefaultFormDependencies(result.nodes, adapterInput.linkedDesignerContext?.defaultObjectForms ?? [], input.defaultFormDependencies);
  }
  return result;
}

function formObjectForArtifact(
  inventory: ConfigurationInventory,
  artifact: ArtifactUnit,
): MetadataObjectUnit | undefined {
  if (!artifact.ownerObjectId) {return undefined;}
  const owner = inventory.objects.find((object) => object.objectId === artifact.ownerObjectId);
  return owner && (owner.metadataType === 'Form' || owner.metadataType === 'CommonForm') ? owner : undefined;
}

function normalizeQualifiedName(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

async function attachDcsOwnerVersions(
  context: Awaited<ReturnType<typeof buildMetadataReferenceContext>>,
  artifactPair: { left: ArtifactUnit; right: ArtifactUnit },
  input: { readonly leftInventory: ConfigurationInventory; readonly rightInventory: ConfigurationInventory },
  readTextFile: (filePath: string) => Promise<string>,
): Promise<Awaited<ReturnType<typeof buildMetadataReferenceContext>>> {
  const leftOwner = ownerForArtifact(input.leftInventory, artifactPair.left);
  const rightOwner = ownerForArtifact(input.rightInventory, artifactPair.right);
  const left = leftOwner ? descriptorArtifact(input.leftInventory, leftOwner) : undefined;
  const right = rightOwner ? descriptorArtifact(input.rightInventory, rightOwner) : undefined;
  const witnesses = [...context.witnesses];
  if (left) {witnesses.push({ sourceId: 'left-source', relativePath: left.relativePath, expectedHash: stripHash(left.contentHash), kind: 'file' });}
  if (right) {witnesses.push({ sourceId: 'right-source', relativePath: right.relativePath, expectedHash: stripHash(right.contentHash), kind: 'file' });}
  let targetVersion: string | undefined;
  let incomingVersion: string | undefined;
  try {
    if (left && leftOwner) {targetVersion = await capturedOwnerDescriptorVersion(left, leftOwner, readTextFile);}
    if (right && rightOwner) {incomingVersion = await capturedOwnerDescriptorVersion(right, rightOwner, readTextFile);}
  } catch {
    // The DCS validator emits a blocking missing-context diagnostic below.
  }
  const ownerDescriptorVersions = targetVersion && incomingVersion
    ? { target: targetVersion, incoming: incomingVersion }
    : undefined;
  return {
    ...context,
    ...(ownerDescriptorVersions ? { ownerDescriptorVersions } : {}),
    witnesses,
  };
}

async function capturedOwnerDescriptorVersion(
  artifact: import('./adapters/mergeAdapter').ArtifactUnit,
  expectedOwner: MetadataObjectUnit,
  readTextFile: (filePath: string) => Promise<string>,
): Promise<string | undefined> {
  const source = await readTextFile(artifact.filePath);
  const actualHash = createHash('sha256').update(Buffer.from(source, 'utf8')).digest('hex');
  if (actualHash !== stripHash(artifact.contentHash)) {return undefined;}
  return readOwnerDescriptorVersion(source, expectedOwner);
}

function ownerForArtifact(inventory: ConfigurationInventory, artifact: ArtifactUnit): MetadataObjectUnit | undefined {
  if (!artifact.ownerObjectId) {return undefined;}
  const owners = inventory.objects.filter((object) => object.objectId === artifact.ownerObjectId);
  return owners.length === 1 ? owners[0] : undefined;
}

function descriptorArtifact(inventory: ConfigurationInventory, owner: MetadataObjectUnit): ArtifactUnit | undefined {
  const descriptors = (inventory.artifactsByObjectId.get(owner.objectId) ?? []).filter((artifact) =>
    artifact.kind === 'metadataXml' && samePath(artifact.filePath, owner.descriptorPath));
  return descriptors.length === 1 ? descriptors[0] : undefined;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return (process.platform === 'win32' ? normalizedLeft.toLocaleLowerCase('en-US') : normalizedLeft) ===
    (process.platform === 'win32' ? normalizedRight.toLocaleLowerCase('en-US') : normalizedRight);
}

function readOwnerDescriptorVersion(source: string, expectedOwner: MetadataObjectUnit): string | undefined {
  const root = parseXmlDocument(source).root;
  if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MDCLASSES_NAMESPACE) {return undefined;}
  const metadata = elementChildren(root);
  if (metadata.length !== 1 || metadata[0]!.localName !== expectedOwner.metadataType
    || namespaceUriForName(metadata[0]!) !== MDCLASSES_NAMESPACE) {return undefined;}
  const metadataName = metadata[0]!;
  const properties = elementChildren(metadataName).filter((element) => element.localName === 'Properties' && namespaceUriForName(element) === MDCLASSES_NAMESPACE);
  if (properties.length !== 1 || namespaceUriForName(properties[0]!) !== MDCLASSES_NAMESPACE) {return undefined;}
  const names = elementChildren(properties[0]!).filter((element) => element.localName === 'Name' && namespaceUriForName(element) === MDCLASSES_NAMESPACE);
  const expectedName = expectedOwner.qualifiedName.split('.').pop() ?? expectedOwner.qualifiedName;
  if (names.length !== 1 || textContent(names[0]!).trim().normalize('NFC') !== expectedName.normalize('NFC')) {return undefined;}
  const descriptorUuid = metadataName.attributes.find((attribute) => attribute.name === 'uuid')?.value;
  if (!expectedOwner.uuid || descriptorUuid?.toLocaleLowerCase('en-US') !== expectedOwner.uuid.toLocaleLowerCase('en-US')) {return undefined;}
  const versions = root.attributes.filter((attribute) => attribute.name === 'version');
  return versions.length === 1 ? versions[0]!.value.trim() || undefined : undefined;
}
