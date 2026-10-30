import { createHash } from 'crypto';
import * as path from 'path';
import { pathToFileURL } from 'url';

import type { BslModuleIndexEntry, BslModuleIdentity } from './bsl/bslModuleIndexer';
import type { ExecutableCandidateFactory } from './adapters/mergeAdapter';
import type { BslRoutineDiffProjectionInput } from './projection/compareTreeProjection';
import { diffBslModules } from './bsl/bslRoutineDiff';
import { captureBslRoutineSpan } from './linkedDesignerRoutineSpan';
import { captureMergePath } from './merge/mergeSnapshot';
import { MISSING_TARGET_HASH, type MergeCandidate } from './merge/mergePreview';
import type { MatchResult } from './domain/compareContracts';
import type { ConfigurationInventory, ArtifactUnit } from './inventory/configurationInventory';
import { hashText } from './bsl/bslRoutineLogicalScanner';
import type { MergeFileWitness } from './merge/mergePreview';
import type { LinkedDesignerRootConfigurationSnapshot, LinkedFormModuleSnapshot } from './linkedDesignerTypes';
import { elementChildren, parseXmlDocument, textContent } from './xml/xmlDom';
import { namespaceUriForName } from './adapters/semanticXml/semanticXmlIdentity';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';

export interface MissingFormModuleProjection {
  readonly items: readonly BslRoutineDiffProjectionInput[];
  readonly candidateFactories: ReadonlyMap<string, ExecutableCandidateFactory>;
  readonly modules: readonly LinkedFormModuleSnapshot[];
}

/** Exposes only explicitly selected incoming routines for a proven Form whose target module is absent. */
export async function projectMissingTargetFormModules(input: {
  readonly metadata: MatchResult;
  readonly leftInventory: ConfigurationInventory;
  readonly rightInventory: ConfigurationInventory;
  readonly leftModules: readonly BslModuleIndexEntry[];
  readonly rightModules: readonly BslModuleIndexEntry[];
  readonly leftRootPath: string;
  readonly rightRootPath: string;
  readonly rightSources: ReadonlyMap<string, string>;
  readonly rightSnapshotId: string;
  readonly rootConfiguration?: LinkedDesignerRootConfigurationSnapshot;
}): Promise<MissingFormModuleProjection> {
  const leftById = groupById(input.leftModules);
  const rightById = groupById(input.rightModules);
  const items: BslRoutineDiffProjectionInput[] = [];
  const candidateFactories = new Map<string, ExecutableCandidateFactory>();
  const modules: LinkedFormModuleSnapshot[] = [];
  for (const [moduleId, rightEntries] of rightById) {
    if (leftById.has(moduleId) || rightEntries.length !== 1) {continue;}
    const right = rightEntries[0]!;
    if (right.identity.moduleKind !== 'Form') {continue;}
    const formQualifiedName = formQualifiedNameForModule(moduleId);
    const formMatch = formQualifiedName && input.metadata.matches.find((match) =>
      match.left.qualifiedName === formQualifiedName
      && match.right.qualifiedName === formQualifiedName
      && ['Form', 'CommonForm'].includes(match.left.metadataType)
      && match.left.metadataType === match.right.metadataType);
    if (!formMatch) {continue;}
    const targetForm = input.leftInventory.objects.find((object) => samePath(object.descriptorPath, formMatch.left.filePath));
    const sourceForm = input.rightInventory.objects.find((object) => samePath(object.descriptorPath, formMatch.right.filePath));
    if (!targetForm || !sourceForm || !hasFormArtifacts(input.leftInventory, targetForm) || !hasFormArtifacts(input.rightInventory, sourceForm)) {continue;}
    const targetFormWitnesses = await linkedFormProofWitnesses(input.leftInventory, targetForm, input.metadata.matches, 'left-source', input.rootConfiguration);
    const sourceFormWitnesses = await linkedFormProofWitnesses(input.rightInventory, sourceForm, input.metadata.matches, 'right-source', input.rootConfiguration);
    if (!targetFormWitnesses || !sourceFormWitnesses) {continue;}
    const targetRelativePath = safeRelative(input.rightRootPath, right.identity.filePath);
    if (!targetRelativePath) {continue;}
    const sourceRelativePath = targetRelativePath;
    const targetPath = path.join(input.leftRootPath, ...targetRelativePath.split('/'));
    if (leftInventoryHasBslPath(input.leftInventory, targetRelativePath)) {continue;}
    const sourceArtifact = findArtifact(input.rightInventory, right.identity.filePath, 'bslModule');
    const rightSource = input.rightSources.get(right.identity.filePath);
    if (!sourceArtifact || rightSource === undefined || !rawHashMatches(rightSource, sourceArtifact.contentHash)) {continue;}
    const targetCapture = await captureMergePath(targetPath, { retainContent: false }).catch(() => undefined);
    if (!targetCapture || targetCapture.state !== 'missing') {continue;}

    const syntheticLeft = missingTargetModuleIdentity(right, targetPath, input.leftRootPath);
    const leftEntry: BslModuleIndexEntry = { identity: syntheticLeft, routines: [], diagnostics: [] };
    const diff = diffBslModules({ left: leftEntry, right });
    if (right.diagnostics.some((diagnostic) => diagnostic.blocking) || diff.diagnostics.some((diagnostic) => diagnostic.blocking)) {continue;}
    const routineCandidateIds = new Map<string, string>();
    const sourceHash = normalizeHash(sourceArtifact.contentHash);
    for (const routine of right.routines) {
      const span = captureBslRoutineSpan(rightSource, routine);
      if (!span) {continue;}
      const nodeId = `bsl:routine:${moduleId}:${routine.normalizedName}`;
      const targetUri = pathToFileURL(targetPath).toString();
      candidateFactories.set(nodeId, async () => {
        const current = await captureMergePath(targetPath, { retainContent: false }).catch(() => undefined);
        if (!current || current.state !== 'missing') {
          return {
            ok: false,
            diagnostics: [{
              severity: 'error', code: 'MERGE_BSL_ROUTINE_GUARD_BLOCKED', phase: 'preview',
              sourceId: 'left-source', path: targetPath, nodeId, blocking: true,
              suggestedAction: 'Целевой модуль формы появился после compare; перенос процедуры остановлен.',
            }],
          };
        }
        const newHash = hashText(span.sourceText);
        const candidate: MergeCandidate = {
          kind: 'bslRoutineInsert',
          sourceId: 'right-source',
          snapshotId: input.rightSnapshotId,
          nodeId,
          targetUri,
          expectedOldHash: MISSING_TARGET_HASH,
          newHash,
          sourceWitnesses: [
            { sourceId: 'right-source', relativePath: sourceRelativePath, expectedHash: sourceHash, kind: 'file' },
            ...targetFormWitnesses,
            ...sourceFormWitnesses,
          ],
          bslRoutine: {
            kind: 'insertRoutine', targetPath: targetUri, expectedOldHash: MISSING_TARGET_HASH, newHash,
            routine: { name: routine.name, normalizedName: routine.normalizedName, kind: routine.kind, exported: routine.exported },
            sourceText: span.sourceText, sourceRange: routine.range, sourceTextRange: span.sourceTextRange,
          },
        };
        return { ok: true, candidate };
      });
      routineCandidateIds.set(routine.normalizedName.toLocaleLowerCase('en-US'), nodeId);
    }
    if (routineCandidateIds.size === 0) {continue;}
    items.push({ diff, targetFilePath: targetPath, mergeableRoutineIds: [...routineCandidateIds.values()] });
    modules.push({
      moduleId,
      targetRelativePath,
      sourceRelativePath,
      targetHash: MISSING_TARGET_HASH,
      sourceHash,
      sourceContent: rightSource,
      targetMissing: true,
      routineCandidateIds,
    });
  }
  return { items, candidateFactories, modules };
}

function hasFormArtifacts(inventory: ConfigurationInventory, object: ConfigurationInventory['objects'][number]): boolean {
  const artifacts = inventory.artifactsByObjectId.get(object.objectId) ?? [];
  return artifacts.some((artifact) => artifact.kind === 'metadataXml' && samePath(artifact.filePath, object.descriptorPath))
    && artifacts.some((artifact) => artifact.kind === 'formXml');
}

async function linkedFormProofWitnesses(
  inventory: ConfigurationInventory,
  form: ConfigurationInventory['objects'][number],
  matches: MatchResult['matches'],
  sourceId: 'left-source' | 'right-source',
  rootConfiguration?: LinkedDesignerRootConfigurationSnapshot,
): Promise<MergeFileWitness[] | undefined> {
  const artifacts = inventory.artifactsByObjectId.get(form.objectId) ?? [];
  const descriptor = artifacts.filter((artifact) => artifact.kind === 'metadataXml' && samePath(artifact.filePath, form.descriptorPath));
  if (descriptor.length !== 1) {return undefined;}
  const formRelativePath = `${descriptor[0]!.relativePath.replace(/\\/gu, '/').replace(/\.xml$/iu, '')}/Ext/Form.xml`;
  const formXml = artifacts.filter((artifact) => artifact.kind === 'formXml' && sameRelative(artifact.relativePath, formRelativePath));
  if (formXml.length !== 1) {return undefined;}
  const formDescriptorContent = await captureArtifact(descriptor[0]!);
  const formBodyContent = await captureArtifact(formXml[0]!);
  if (!formDescriptorContent || !formBodyContent
    || !matchesMetadataDescriptor(formDescriptorContent, form.metadataType, form.qualifiedName, form.uuid)) {return undefined;}
  const result: MergeFileWitness[] = [descriptor[0]!, formXml[0]!].map((artifact) => ({
    sourceId,
    relativePath: artifact.relativePath.replace(/\\/gu, '/'),
    expectedHash: normalizeHash(artifact.contentHash),
    kind: 'file',
  }));

  const nestedOwner = nestedFormOwnerName(form.qualifiedName);
  if (!nestedOwner && form.metadataType === 'CommonForm') {
    const rootWitness = rootCommonFormRegistrationWitness(rootConfiguration, sourceId, form.qualifiedName.split('.').pop() ?? form.qualifiedName);
    return rootWitness ? [...result, rootWitness] : undefined;
  }
  if (!nestedOwner) {return result;}
  const ownerMatch = matches.find((match) => {
    const identity = sourceId === 'left-source' ? match.left : match.right;
    return identity.metadataType !== 'Form' && identity.metadataType !== 'CommonForm'
      && sameIdentity(identity.qualifiedName, nestedOwner);
  });
  if (!ownerMatch) {return undefined;}
  const ownerIdentity = sourceId === 'left-source' ? ownerMatch.left : ownerMatch.right;
  const owner = inventory.objects.filter((object) => object.metadataType === ownerIdentity.metadataType
    && sameIdentity(object.qualifiedName, ownerIdentity.qualifiedName));
  if (owner.length !== 1) {return undefined;}
  const ownerDescriptors = (inventory.artifactsByObjectId.get(owner[0]!.objectId) ?? []).filter((artifact) =>
    artifact.kind === 'metadataXml' && samePath(artifact.filePath, owner[0]!.descriptorPath));
  if (ownerDescriptors.length !== 1) {return undefined;}
  const ownerDescriptorContent = await captureArtifact(ownerDescriptors[0]!);
  const formName = form.qualifiedName.slice(form.qualifiedName.lastIndexOf('.') + 1);
  if (!ownerDescriptorContent
    || !matchesMetadataDescriptor(ownerDescriptorContent, owner[0]!.metadataType, owner[0]!.qualifiedName, owner[0]!.uuid)
    || !hasDirectFormRegistration(ownerDescriptorContent, formName)) {return undefined;}
  result.push({
    sourceId,
    relativePath: ownerDescriptors[0]!.relativePath.replace(/\\/gu, '/'),
    expectedHash: normalizeHash(ownerDescriptors[0]!.contentHash),
    kind: 'file',
  });
  return result;
}

function rootCommonFormRegistrationWitness(
  snapshot: LinkedDesignerRootConfigurationSnapshot | undefined,
  sourceId: 'left-source' | 'right-source',
  formName: string,
): MergeFileWitness | undefined {
  const content = sourceId === 'left-source' ? snapshot?.targetContent : snapshot?.sourceContent;
  const expectedHash = sourceId === 'left-source' ? snapshot?.targetHash : snapshot?.sourceHash;
  if (!content || !expectedHash || !hasRootRegistration(content, 'CommonForm', formName)) {return undefined;}
  return { sourceId, relativePath: 'Configuration.xml', expectedHash: normalizeHash(expectedHash), kind: 'file' };
}

async function captureArtifact(artifact: ArtifactUnit): Promise<string | undefined> {
  const captured = await captureMergePath(artifact.filePath, { retainContent: true }).catch(() => undefined);
  if (captured?.state !== 'file' || captured.contentBase64 === undefined || captured.hash !== normalizeHash(artifact.contentHash)) {return undefined;}
  return Buffer.from(captured.contentBase64, 'base64').toString('utf8');
}

function matchesMetadataDescriptor(xml: string, type: string, qualifiedName: string, expectedUuid?: string): boolean {
  try {
    const root = parseXmlDocument(xml).root;
    if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MDCLASSES_NAMESPACE) {return false;}
    const owners = elementChildren(root);
    if (owners.length !== 1 || owners[0]!.localName !== type || namespaceUriForName(owners[0]!) !== MDCLASSES_NAMESPACE) {return false;}
    const properties = elementChildren(owners[0]!).filter((element) => element.localName === 'Properties' && namespaceUriForName(element) === MDCLASSES_NAMESPACE);
    if (properties.length !== 1) {return false;}
    const names = elementChildren(properties[0]!).filter((element) => element.localName === 'Name' && namespaceUriForName(element) === MDCLASSES_NAMESPACE);
    const expectedName = qualifiedName.split('.').pop() ?? qualifiedName;
    if (names.length !== 1 || textContent(names[0]!).trim().normalize('NFC') !== expectedName.normalize('NFC')) {return false;}
    const uuid = owners[0]!.attributes.find((attribute) => attribute.name === 'uuid')?.value;
    return Boolean(expectedUuid && uuid?.toLocaleLowerCase('en-US') === expectedUuid.toLocaleLowerCase('en-US'));
  } catch {
    return false;
  }
}

function hasDirectFormRegistration(xml: string, formName: string): boolean {
  try {
    const root = parseXmlDocument(xml).root;
    if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MDCLASSES_NAMESPACE) {return false;}
    const owners = elementChildren(root);
    if (owners.length !== 1 || namespaceUriForName(owners[0]!) !== MDCLASSES_NAMESPACE) {return false;}
    const ownerNamespace = namespaceUriForName(owners[0]!);
    const childObjects = elementChildren(owners[0]!).filter((element) => element.localName === 'ChildObjects' && namespaceUriForName(element) === ownerNamespace);
    if (childObjects.length !== 1) {return false;}
    const forms = elementChildren(childObjects[0]!).filter((element) => element.localName === 'Form' && namespaceUriForName(element) === ownerNamespace);
    return forms.filter((element) => textContent(element).trim().normalize('NFC') === formName.normalize('NFC')).length === 1;
  } catch {
    return false;
  }
}

function hasRootRegistration(content: Buffer, kind: string, name: string): boolean {
  try {
    const root = parseXmlDocument(content.toString('utf8')).root;
    if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MDCLASSES_NAMESPACE) {return false;}
    const owners = elementChildren(root);
    if (owners.length !== 1 || owners[0]!.localName !== 'Configuration' || namespaceUriForName(owners[0]!) !== MDCLASSES_NAMESPACE) {return false;}
    const childObjects = elementChildren(owners[0]!).filter((element) => element.localName === 'ChildObjects' && namespaceUriForName(element) === MDCLASSES_NAMESPACE);
    if (childObjects.length !== 1) {return false;}
    const registrations = elementChildren(childObjects[0]!).filter((element) => element.localName === kind && namespaceUriForName(element) === MDCLASSES_NAMESPACE);
    return registrations.filter((element) => textContent(element).trim().normalize('NFC') === name.normalize('NFC')).length === 1;
  } catch {
    return false;
  }
}

function nestedFormOwnerName(qualifiedName: string): string | undefined {
  const marker = '.Form.';
  const index = qualifiedName.lastIndexOf(marker);
  return index > 0 ? qualifiedName.slice(0, index) : undefined;
}

function sameIdentity(left: string, right: string): boolean {
  return left.normalize('NFC').toLocaleLowerCase('en-US') === right.normalize('NFC').toLocaleLowerCase('en-US');
}

function leftInventoryHasBslPath(inventory: ConfigurationInventory, relativePath: string): boolean {
  return inventory.objects.some((object) => (inventory.artifactsByObjectId.get(object.objectId) ?? []).some((artifact) =>
    artifact.kind === 'bslModule' && sameRelative(artifact.relativePath, relativePath)));
}

function findArtifact(inventory: ConfigurationInventory, filePath: string, kind: ArtifactUnit['kind']): ArtifactUnit | undefined {
  for (const artifacts of inventory.artifactsByObjectId.values()) {
    const matches = artifacts.filter((artifact) => artifact.kind === kind && samePath(artifact.filePath, filePath));
    if (matches.length > 1) {return undefined;}
    if (matches.length === 1) {return matches[0];}
  }
  return undefined;
}

function missingTargetModuleIdentity(right: BslModuleIndexEntry, targetPath: string, leftRootPath: string): BslModuleIdentity {
  return {
    ...right.identity,
    sourceId: 'left-source', side: 'left', filePath: targetPath, configRoot: leftRootPath,
  };
}

function formQualifiedNameForModule(moduleId: string): string | undefined {
  const suffix = '.FormModule';
  return moduleId.endsWith(suffix) ? moduleId.slice(0, -suffix.length) : undefined;
}

function groupById(modules: readonly BslModuleIndexEntry[]): Map<string, BslModuleIndexEntry[]> {
  const grouped = new Map<string, BslModuleIndexEntry[]>();
  for (const module of modules) {grouped.set(module.identity.moduleId, [...(grouped.get(module.identity.moduleId) ?? []), module]);}
  return grouped;
}

function safeRelative(root: string, filePath: string): string | undefined {
  const relative = path.relative(path.resolve(root), path.resolve(filePath)).replace(/\\/gu, '/');
  return relative && relative !== '.' && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative) ? relative : undefined;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left).replace(/\\/gu, '/');
  const b = path.resolve(right).replace(/\\/gu, '/');
  return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b;
}

function sameRelative(left: string, right: string): boolean {
  const a = left.replace(/\\/gu, '/');
  const b = right.replace(/\\/gu, '/');
  return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b;
}

function rawHashMatches(content: string, expected: string): boolean {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex') === normalizeHash(expected);
}

function normalizeHash(value: string): string {
  return value.startsWith('sha256:') ? value.slice('sha256:'.length).toLocaleLowerCase('en-US') : value.toLocaleLowerCase('en-US');
}
