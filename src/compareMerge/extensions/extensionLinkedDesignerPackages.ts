import * as path from 'path';

import type { CompareMessage } from '../domain/compareContracts';
import type { AdapterCompareInput } from '../adapters/mergeAdapter';
import type { MergeFileWitness } from '../merge/mergePreview';
import { MISSING_TARGET_HASH } from '../merge/mergePreview';
import { captureMergePath } from '../merge/mergeSnapshot';
import { requiredLinkedDesignerBodyPath } from '../linkedDesignerPackageRules';
import { elementChildren, parseXmlDocument, textContent, type XmlElement } from '../xml/xmlDom';
import { namespaceUriForName } from '../adapters/semanticXml/semanticXmlIdentity';
import type { ExtensionCapturedFile, ExtensionIndexedObject, ExtensionMetadataIndex } from './extensionMetadataIndex';
import type { ExtensionTransferRow } from './extensionTransfer';
import { LINKED_FORM_REFERENCE_PROPERTIES } from '../linkedDesignerUtils';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';

export interface ExtensionLinkedDesignerPackageMember {
  readonly sourceRelativePath?: string;
  readonly targetRelativePath: string;
  readonly sourceHash?: string;
  readonly expectedTargetHash: string;
  readonly content?: Buffer;
  /** Candidate-scoped definition proof; used only for the registered metadata descriptor member. */
  readonly descriptorUuidWitnesses?: readonly MergeFileWitness[];
}

export interface ExtensionLinkedDesignerPackage {
  readonly packageId: string;
  readonly rowId: string;
  readonly action: 'copy' | 'delete';
  readonly kind: 'Form' | 'Template' | 'Command';
  readonly name: string;
  readonly qualifiedName: string;
  readonly members: readonly ExtensionLinkedDesignerPackageMember[];
  readonly incompatibleDeletePaths: readonly string[];
  /** Captured owner/base dependencies leased by every member write in this atomic package. */
  readonly dependencyWitnesses?: readonly MergeFileWitness[];
}

export interface ExtensionLinkedDesignerPackageIndex {
  readonly packages: readonly ExtensionLinkedDesignerPackage[];
  readonly capabilities: NonNullable<AdapterCompareInput['linkedDesignerContext']>;
  readonly diagnostics: readonly CompareMessage[];
}

const PACKAGE_FOLDERS: Readonly<Record<ExtensionLinkedDesignerPackage['kind'], string>> = {
  Form: 'Forms',
  Template: 'Templates',
  Command: 'Commands',
};

/** Captures nested package members only for registrations that changed on this owner. */
export async function indexExtensionLinkedDesignerPackages(input: {
  readonly row: ExtensionTransferRow;
  readonly target: ExtensionMetadataIndex;
  readonly incoming: ExtensionMetadataIndex;
  /** Adopted owners preserve target-side Form registrations and linked files. */
  readonly preserveTargetFormPackages?: boolean;
}): Promise<ExtensionLinkedDesignerPackageIndex> {
  const targetObject = input.row.target;
  const incomingObject = input.row.incoming;
  if (!targetObject?.descriptorContent || !incomingObject?.descriptorContent
      || !targetObject.sidecarRelativePath || !incomingObject.sidecarRelativePath) {
    return { packages: [], capabilities: { registrations: [], defaultObjectForms: [], formEventHandlers: [] }, diagnostics: [] };
  }
  const diagnostics: CompareMessage[] = [];
  const targetRegistrations = readRegistrations(targetObject.descriptorContent.toString('utf8'), targetObject);
  const incomingRegistrations = readRegistrations(incomingObject.descriptorContent.toString('utf8'), incomingObject);
  if (!targetRegistrations.ok || !incomingRegistrations.ok) {
    return {
      packages: [],
      capabilities: { registrations: [], defaultObjectForms: [], formEventHandlers: [] },
      diagnostics: [blocked('ChildObjects нельзя однозначно прочитать; связанные Designer-пакеты доступны только для чтения.', incomingObject.sourceId, input.row.id)],
    };
  }
  const targetByKey = registrationsByKey(targetRegistrations.values);
  const incomingByKey = registrationsByKey(incomingRegistrations.values);
  const duplicateKeys = [...targetByKey.values(), ...incomingByKey.values()].filter((items) => items.length !== 1);
  if (duplicateKeys.length > 0) {
    return {
      packages: [],
      capabilities: { registrations: [], defaultObjectForms: [], formEventHandlers: [] },
      diagnostics: [blocked('Имя Form/Template/Command повторяется у владельца; связанное сопоставление неоднозначно.', incomingObject.sourceId, input.row.id)],
    };
  }

  const packages: ExtensionLinkedDesignerPackage[] = [];
  for (const [key, registrations] of incomingByKey) {
    if (targetByKey.has(key)) {continue;}
    const registration = registrations[0]!;
    const recipe = await capturePackage({
      row: input.row,
      targetRoot: input.target,
      incomingRoot: input.incoming,
      targetOwner: targetObject,
      incomingOwner: incomingObject,
      registration,
      action: 'copy',
    });
    if ('diagnostic' in recipe) {diagnostics.push(recipe.diagnostic);}
    else {packages.push(recipe.package);}
  }
  for (const [key, registrations] of targetByKey) {
    if (incomingByKey.has(key)) {continue;}
    const registration = registrations[0]!;
    if (input.preserveTargetFormPackages && registration.kind === 'Form') {continue;}
    const recipe = await capturePackage({
      row: input.row,
      targetRoot: input.target,
      incomingRoot: input.incoming,
      targetOwner: targetObject,
      incomingOwner: incomingObject,
      registration,
      action: 'delete',
    });
    if ('diagnostic' in recipe) {diagnostics.push(recipe.diagnostic);}
    else {packages.push(recipe.package);}
  }
  const registrations = packages.map((item) => ({ kind: item.kind, name: item.name, packageId: item.packageId }));
  const defaultObjectForms: NonNullable<AdapterCompareInput['linkedDesignerContext']>['defaultObjectForms'] extends readonly (infer T)[] ? T[] : never = [];
  for (const propertyName of LINKED_FORM_REFERENCE_PROPERTIES) {
    for (const value of readMetadataValues(incomingObject.descriptorContent, incomingObject, propertyName)) {
      const target = await targetHasCompleteForm(input.target, targetObject, value);
      const selected = packages.find((candidate) => candidate.action === 'copy' && candidate.kind === 'Form'
        && sameName(candidate.qualifiedName, target.qualifiedName));
      defaultObjectForms.push({
        propertyName,
        value,
        targetFormComplete: target.targetFormComplete,
        ...(target.targetWitnesses.length ? { targetWitnesses: target.targetWitnesses } : {}),
        ...(selected ? { packageId: selected.packageId } : {}),
      });
    }
  }
  return {
    packages,
    capabilities: { registrations, defaultObjectForms, formEventHandlers: [] },
    diagnostics,
  };
}

export function linkedPackageForRegistrationNode(
  node: { readonly kind?: string; readonly status?: string; readonly label: string; readonly leftValue?: string; readonly rightValue?: string },
  packages: readonly ExtensionLinkedDesignerPackage[],
): ExtensionLinkedDesignerPackage | undefined {
  const action = node.status === 'leftOnly' ? 'delete' : node.status === 'rightOnly' ? 'copy' : undefined;
  if (!action) {return undefined;}
  let kind: ExtensionLinkedDesignerPackage['kind'];
  let name: string;
  if (node.kind === 'xmlElement') {
    const serialized = node.status === 'leftOnly' ? node.leftValue : node.rightValue;
    if (!serialized) {return undefined;}
    try {
      const registration = parseXmlDocument(serialized).root;
      if (registration.localName !== 'Form' && registration.localName !== 'Template' && registration.localName !== 'Command') {return undefined;}
      kind = registration.localName;
      name = textContent(registration).trim();
    } catch {
      return undefined;
    }
  } else {
    return undefined;
  }
  if (!name) {return undefined;}
  const matches = packages.filter((item) => item.action === action && item.kind === kind && sameName(item.name, name));
  return matches.length === 1 ? matches[0] : undefined;
}

export async function targetHasCompleteForm(root: ExtensionMetadataIndex, owner: ExtensionIndexedObject, value: string): Promise<{
  readonly targetFormComplete: boolean;
  readonly qualifiedName: string;
  readonly targetWitnesses: readonly MergeFileWitness[];
}> {
  const raw = value.trim().normalize('NFC');
  const localPrefix = `${owner.qualifiedName}.Form.`;
  const localName = !raw.includes('.') ? raw : raw.toLocaleLowerCase('en-US').startsWith(localPrefix.toLocaleLowerCase('en-US'))
    ? raw.slice(localPrefix.length) : undefined;
  if (localName !== undefined) {
    const qualifiedName = `${owner.qualifiedName}.Form.${localName}`;
    const complete = await completeNestedForm(root, owner, localName);
    return { qualifiedName, ...complete };
  }

  const commonForms = root.objects.filter((candidate) => candidate.metadataType === 'CommonForm'
    && sameName(candidate.qualifiedName, raw));
  if (commonForms.length === 1) {
    const candidate = commonForms[0]!;
    const complete = await completeRootForm(root, candidate);
    return { qualifiedName: candidate.qualifiedName, ...complete };
  }

  const nestedCandidates: Array<{ owner: ExtensionIndexedObject; name: string }> = [];
  for (const candidateOwner of root.objects) {
    const prefix = `${candidateOwner.qualifiedName}.Form.`;
    if (!raw.toLocaleLowerCase('en-US').startsWith(prefix.toLocaleLowerCase('en-US'))) {continue;}
    const name = raw.slice(prefix.length);
    if (name && !name.includes('.')) {nestedCandidates.push({ owner: candidateOwner, name });}
  }
  if (nestedCandidates.length !== 1) {
    return { qualifiedName: raw, targetFormComplete: false, targetWitnesses: [] };
  }
  const nested = nestedCandidates[0]!;
  const complete = await completeNestedForm(root, nested.owner, nested.name);
  return { qualifiedName: `${nested.owner.qualifiedName}.Form.${nested.name}`, ...complete };
}

async function completeNestedForm(root: ExtensionMetadataIndex, owner: ExtensionIndexedObject, name: string): Promise<{
  targetFormComplete: boolean;
  targetWitnesses: readonly MergeFileWitness[];
}> {
  if (!owner.descriptorContent || !owner.descriptorRelativePath || !owner.descriptorHash || !owner.sidecarRelativePath) {
    return { targetFormComplete: false, targetWitnesses: [] };
  }
  const registrations = readRegistrations(owner.descriptorContent.toString('utf8'), owner);
  if (!registrations.ok || registrations.values.filter((item) => item.kind === 'Form' && sameName(item.name, name)).length !== 1) {
    return { targetFormComplete: false, targetWitnesses: [] };
  }
  const descriptorPath = `${owner.sidecarRelativePath}/Forms/${name}.xml`;
  const descriptorFiles = owner.sidecarFiles.filter((file) => samePath(file.relativePath, descriptorPath));
  if (descriptorFiles.length !== 1) {return { targetFormComplete: false, targetWitnesses: [] };}
  const descriptorContent = await captureFile(root, descriptorFiles[0]!);
  if (parseNestedDescriptor(descriptorContent, 'Form', name) === undefined) {return { targetFormComplete: false, targetWitnesses: [] };}
  const requiredBody = requiredLinkedDesignerBodyPath('Form', descriptorPath, descriptorContent!);
  const bodyFiles = requiredBody ? owner.sidecarFiles.filter((file) => samePath(file.relativePath, requiredBody)) : [];
  if (bodyFiles.length !== 1) {return { targetFormComplete: false, targetWitnesses: [] };}
  return {
    targetFormComplete: true,
    targetWitnesses: [
      { sourceId: root.sourceId, relativePath: owner.descriptorRelativePath, expectedHash: owner.descriptorHash, kind: 'file' },
      { sourceId: root.sourceId, relativePath: descriptorFiles[0]!.relativePath, expectedHash: descriptorFiles[0]!.hash, kind: 'file' },
      { sourceId: root.sourceId, relativePath: bodyFiles[0]!.relativePath, expectedHash: bodyFiles[0]!.hash, kind: 'file' },
    ],
  };
}

async function completeRootForm(root: ExtensionMetadataIndex, form: ExtensionIndexedObject): Promise<{
  targetFormComplete: boolean;
  targetWitnesses: readonly MergeFileWitness[];
}> {
  if (!form.descriptorContent || !form.descriptorRelativePath || !form.descriptorHash || !form.sidecarRelativePath
      || parseNestedDescriptor(form.descriptorContent, 'CommonForm', form.name) === undefined) {
    return { targetFormComplete: false, targetWitnesses: [] };
  }
  const descriptorPath = form.descriptorRelativePath;
  const requiredBody = requiredLinkedDesignerBodyPath('Form', descriptorPath, form.descriptorContent);
  const bodyFiles = requiredBody ? form.sidecarFiles.filter((file) => samePath(file.relativePath, requiredBody)) : [];
  if (bodyFiles.length !== 1) {return { targetFormComplete: false, targetWitnesses: [] };}
  return {
    targetFormComplete: true,
    targetWitnesses: [
      { sourceId: root.sourceId, relativePath: descriptorPath, expectedHash: form.descriptorHash, kind: 'file' },
      { sourceId: root.sourceId, relativePath: bodyFiles[0]!.relativePath, expectedHash: bodyFiles[0]!.hash, kind: 'file' },
    ],
  };
}

async function capturePackage(input: {
  row: ExtensionTransferRow;
  targetRoot: ExtensionMetadataIndex;
  incomingRoot: ExtensionMetadataIndex;
  targetOwner: ExtensionIndexedObject;
  incomingOwner: ExtensionIndexedObject;
  registration: { kind: 'Form' | 'Template' | 'Command'; name: string };
  action: 'copy' | 'delete';
}): Promise<{ package: ExtensionLinkedDesignerPackage } | { diagnostic: CompareMessage }> {
  const folder = PACKAGE_FOLDERS[input.registration.kind];
  const targetPrefix = path.posix.join(input.targetOwner.sidecarRelativePath!, folder, input.registration.name);
  const sourcePrefix = path.posix.join(input.incomingOwner.sidecarRelativePath!, folder, input.registration.name);
  const targetDescriptor = `${targetPrefix}.xml`;
  const sourceDescriptor = `${sourcePrefix}.xml`;
  const owner = input.action === 'copy' ? input.incomingOwner : input.targetOwner;
  const root = input.action === 'copy' ? input.incomingRoot : input.targetRoot;
  const prefix = input.action === 'copy' ? sourcePrefix : targetPrefix;
  const descriptorPath = input.action === 'copy' ? sourceDescriptor : targetDescriptor;
  const descriptorFile = owner.sidecarFiles.filter((file) => samePath(file.relativePath, descriptorPath));
  const descriptorContent = descriptorFile.length === 1 ? await captureFile(root, descriptorFile[0]!) : undefined;
  if (!descriptorContent || parseNestedDescriptor(descriptorContent, input.registration.kind, input.registration.name) === undefined) {
    return { diagnostic: blocked(`Дескриптор ${input.registration.kind} ${input.registration.name} отсутствует или имеет неоднозначную identity.`, owner.sourceId, input.row.id) };
  }
  const packagePrefix = `${prefix}/`;
  const members = owner.sidecarFiles.filter((file) => normalizePath(file.relativePath).startsWith(normalizePath(packagePrefix)));
  const memberFiles = [{ ...descriptorFile[0]!, content: descriptorContent }, ...members];
  if (!requiredMembersPresent(input.registration.kind, memberFiles, prefix, descriptorContent)) {
    return { diagnostic: blocked(`Пакет ${input.registration.kind} ${input.registration.name} не содержит обязательный descriptor или sidecar.`, owner.sourceId, input.row.id) };
  }
  if (input.action === 'copy') {
    const targetPaths = new Set(input.targetOwner.sidecarFiles.map((file) => normalizePath(file.relativePath)));
    if (memberFiles.some((file) => targetPaths.has(normalizePath(rebaseMember(file.relativePath, input.incomingOwner.sidecarRelativePath!, input.targetOwner.sidecarRelativePath!))))) {
      return { diagnostic: blocked(`В target уже есть файлы незарегистрированного пакета ${input.registration.kind} ${input.registration.name}; перенос заблокирован.`, input.targetRoot.sourceId, input.row.id) };
    }
  }

  const captured: ExtensionLinkedDesignerPackageMember[] = [];
  for (const file of memberFiles) {
    const relative = input.action === 'copy'
      ? rebaseMember(file.relativePath, input.incomingOwner.sidecarRelativePath!, input.targetOwner.sidecarRelativePath!)
      : file.relativePath;
    const targetRelativePath = input.action === 'copy'
      ? relative
      : file.relativePath;
    if (input.action === 'delete') {
      captured.push({ targetRelativePath, expectedTargetHash: file.hash });
      continue;
    }
    const content = await captureFile(root, file);
    if (!content) {return { diagnostic: blocked(`Исходный Designer-файл изменился после сравнения: ${file.relativePath}`, owner.sourceId, input.row.id) };}
    captured.push({
      sourceRelativePath: file.relativePath,
      targetRelativePath,
      sourceHash: file.hash,
      expectedTargetHash: targetHashFor(input.targetOwner, targetRelativePath),
      content,
    });
  }
  const packageId = `extension-designer:${input.row.id}:${input.registration.kind}:${encodeURIComponent(input.registration.name.normalize('NFC'))}`;
  return {
    package: {
      packageId,
      rowId: input.row.id,
      action: input.action,
      kind: input.registration.kind,
      name: input.registration.name,
      qualifiedName: `${input.row.qualifiedName}.${input.registration.kind}.${input.registration.name}`,
      members: captured,
      incompatibleDeletePaths: [],
    },
  };
}

async function captureFile(root: ExtensionMetadataIndex, file: ExtensionCapturedFile): Promise<Buffer | undefined> {
  if (file.content) {return Buffer.from(file.content);}
  const snapshot = await captureMergePath(path.join(root.canonicalRootPath ?? root.rootPath, file.relativePath), { retainContent: true }).catch(() => undefined);
  if (snapshot?.state !== 'file' || snapshot.hash !== file.hash || snapshot.contentBase64 === undefined) {return undefined;}
  return Buffer.from(snapshot.contentBase64, 'base64');
}

function requiredMembersPresent(
  kind: 'Form' | 'Template' | 'Command',
  files: readonly ExtensionCapturedFile[],
  prefix: string,
  descriptorContent: Buffer | undefined,
): boolean {
  if (!files.some((file) => samePath(file.relativePath, `${prefix}.xml`)) || !descriptorContent) {return false;}
  const requiredBodyPath = requiredLinkedDesignerBodyPath(kind, `${prefix}.xml`, descriptorContent);
  return Boolean(requiredBodyPath && files.some((file) => samePath(file.relativePath, requiredBodyPath)));
}

function readRegistrations(xml: string, expectedOwner: ExtensionIndexedObject): { ok: true; values: { kind: 'Form' | 'Template' | 'Command'; name: string }[] } | { ok: false } {
  try {
    const root = parseXmlDocument(xml).root;
    const owner = expectedMetadataOwner(root, expectedOwner);
    if (!owner) {return { ok: false };}
    const childContainers = elementChildren(owner).filter((element) => element.localName === 'ChildObjects');
    if (childContainers.length > 1) {return { ok: false };}
    if (childContainers.length === 0) {return { ok: true, values: [] };}
    const childObjects = childContainers[0]!;
    if (namespaceUriForName(childObjects) !== MDCLASSES_NAMESPACE) {return { ok: false };}
    const values: { kind: 'Form' | 'Template' | 'Command'; name: string }[] = [];
    for (const child of elementChildren(childObjects)) {
      if (namespaceUriForName(child) !== MDCLASSES_NAMESPACE) {continue;}
      if (child.localName !== 'Form' && child.localName !== 'Template' && child.localName !== 'Command') {continue;}
      const name = textContent(child).trim();
      if (!name) {return { ok: false };}
      values.push({ kind: child.localName, name });
    }
    return { ok: true, values };
  } catch {
    return { ok: false };
  }
}

function parseNestedDescriptor(content: Buffer | undefined, kind: string, name: string): string | undefined {
  if (!content) {return undefined;}
  try {
    const metadata = parseXmlDocument(content.toString('utf8')).root;
    const descriptor = elementChildren(metadata);
    if (metadata.localName !== 'MetaDataObject' || namespaceUriForName(metadata) !== MDCLASSES_NAMESPACE
      || descriptor.length !== 1 || descriptor[0]!.localName !== kind
      || namespaceUriForName(descriptor[0]!) !== MDCLASSES_NAMESPACE) {return undefined;}
    const properties = elementChildren(descriptor[0]!).filter((element) => element.localName === 'Properties');
    if (properties.length !== 1 || namespaceUriForName(properties[0]!) !== MDCLASSES_NAMESPACE) {return undefined;}
    const names = elementChildren(properties[0]!).filter((element) => element.localName === 'Name');
    if (names.length !== 1 || textContent(names[0]!).trim() !== name || !descriptor[0]!.attributes.some((item) => item.localName === 'uuid' && item.value.trim())) {return undefined;}
    if (namespaceUriForName(names[0]!) !== MDCLASSES_NAMESPACE) {return undefined;}
    return name;
  } catch {
    return undefined;
  }
}

function readMetadataValues(content: Buffer, expectedOwner: ExtensionIndexedObject, name: string): string[] {
  try {
    const root = parseXmlDocument(content.toString('utf8')).root;
    const owner = expectedMetadataOwner(root, expectedOwner);
    const properties = owner ? elementChildren(owner).filter((item) => item.localName === 'Properties') : [];
    if (!owner || properties.length !== 1 || namespaceUriForName(properties[0]!) !== MDCLASSES_NAMESPACE) {return [];}
    return elementChildren(properties[0]!).filter((field) => field.localName === name && namespaceUriForName(field) === MDCLASSES_NAMESPACE)
      .map((field) => textContent(field).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function expectedMetadataOwner(root: XmlElement, expected: ExtensionIndexedObject): XmlElement | undefined {
  if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MDCLASSES_NAMESPACE) {return undefined;}
  const owners = elementChildren(root);
  const expectedType = expected.descriptorRootTag ?? expected.metadataType;
  if (owners.length !== 1 || owners[0]!.localName !== expectedType
    || namespaceUriForName(owners[0]!) !== MDCLASSES_NAMESPACE) {return undefined;}
  const owner = owners[0]!;
  const properties = elementChildren(owner).filter((item) => item.localName === 'Properties');
  if (properties.length !== 1 || namespaceUriForName(properties[0]!) !== MDCLASSES_NAMESPACE) {return undefined;}
  const names = elementChildren(properties[0]!).filter((item) => item.localName === 'Name');
  if (names.length !== 1 || namespaceUriForName(names[0]!) !== MDCLASSES_NAMESPACE
    || textContent(names[0]!).trim().normalize('NFC') !== expected.name.normalize('NFC')) {return undefined;}
  const uuid = owner.attributes.find((item) => item.name === 'uuid')?.value;
  if (!expected.identity?.uuid || uuid?.toLocaleLowerCase('en-US') !== expected.identity.uuid.toLocaleLowerCase('en-US')) {return undefined;}
  return owner;
}

function registrationsByKey(values: readonly { kind: 'Form' | 'Template' | 'Command'; name: string }[]): Map<string, { kind: 'Form' | 'Template' | 'Command'; name: string }[]> {
  const result = new Map<string, { kind: 'Form' | 'Template' | 'Command'; name: string }[]>();
  for (const value of values) {
    const key = `${value.kind}\0${normalizeName(value.name)}`;
    result.set(key, [...(result.get(key) ?? []), value]);
  }
  return result;
}

function targetHashFor(owner: ExtensionIndexedObject, targetPath: string): string {
  return owner.sidecarFiles.find((file) => samePath(file.relativePath, targetPath))?.hash ?? MISSING_TARGET_HASH;
}

function rebaseMember(value: string, sourcePrefix: string, targetPrefix: string): string {
  const normalized = value.replace(/\\/gu, '/');
  const prefix = sourcePrefix.replace(/\\/gu, '/').replace(/\/$/u, '');
  if (!samePath(normalized, prefix) && !normalizePath(normalized).startsWith(`${normalizePath(prefix)}/`)) {return normalized;}
  return `${targetPrefix.replace(/\\/gu, '/').replace(/\/$/u, '')}${normalized.slice(prefix.length)}`;
}

function samePath(left: string, right: string): boolean {return normalizePath(left) === normalizePath(right);}
function normalizePath(value: string): string {const result = value.replace(/\\/gu, '/').normalize('NFC'); return process.platform === 'win32' ? result.toLocaleLowerCase('en-US') : result;}
function sameName(left: string, right: string): boolean {return normalizeName(left) === normalizeName(right);}
function normalizeName(value: string): string {return value.normalize('NFC').toLocaleLowerCase('en-US');}
function blocked(message: string, sourceId: string, nodeId?: string): CompareMessage {return { severity: 'error', code: 'EXTENSION_TRANSFER_BLOCKED', phase: 'compare', sourceId, nodeId, blocking: true, suggestedAction: message };}
