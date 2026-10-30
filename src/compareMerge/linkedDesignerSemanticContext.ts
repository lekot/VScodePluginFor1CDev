import { createHash } from 'crypto';
import * as path from 'path';

import type { CompareMessage } from './domain/compareContracts';
import type { CompareSession } from './domain/compareSession';
import type { MergeFileWitness } from './merge/mergePreview';
import { elementChildren, parseXmlDocument, textContent } from './xml/xmlDom';
import { namespaceUriForName } from './adapters/semanticXml/semanticXmlIdentity';
import type { ConfigurationInventory, MetadataObjectUnit } from './adapters/mergeAdapter';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';

export type LinkedDesignerOwnerDescriptorContextResult =
  | {
    readonly ok: true;
    readonly versions: { readonly target: string; readonly incoming: string };
    readonly witnesses: readonly MergeFileWitness[];
  }
  | { readonly ok: false; readonly message: CompareMessage };

/** Reads each matched owner descriptor once and proves its version against the indexed raw hash. */
export async function captureLinkedDesignerOwnerDescriptorContext(input: {
  readonly leftInventory: ConfigurationInventory;
  readonly rightInventory: ConfigurationInventory;
  readonly leftOwner?: MetadataObjectUnit;
  readonly rightOwner?: MetadataObjectUnit;
  readonly session: CompareSession;
  readonly readTextFile: (filePath: string) => Promise<string>;
  readonly nodeId?: string;
}): Promise<LinkedDesignerOwnerDescriptorContextResult> {
  if (!input.leftOwner || !input.rightOwner) {
    return { ok: false, message: diagnostic('DCS требует сопоставленный дескриптор владельца с обеих сторон.', sourceId(input.session, 'right'), input.nodeId) };
  }
  const left = await captureOwnerDescriptor(input.leftInventory, input.leftOwner, input.session, 'left', input.readTextFile);
  const right = await captureOwnerDescriptor(input.rightInventory, input.rightOwner, input.session, 'right', input.readTextFile);
  if (!left || !right) {
    return { ok: false, message: diagnostic('Не удалось подтвердить версии дескрипторов владельца DCS по текущим индексированным снимкам.', sourceId(input.session, 'right'), input.nodeId) };
  }
  return { ok: true, versions: { target: left.version, incoming: right.version }, witnesses: [left.witness, right.witness] };
}

async function captureOwnerDescriptor(
  inventory: ConfigurationInventory,
  owner: MetadataObjectUnit,
  session: CompareSession,
  side: 'left' | 'right',
  readTextFile: (filePath: string) => Promise<string>,
): Promise<{ version: string; witness: MergeFileWitness } | undefined> {
  const artifact = (inventory.artifactsByObjectId.get(owner.objectId) ?? []).find((candidate) =>
    candidate.kind === 'metadataXml' && samePath(candidate.filePath, owner.descriptorPath));
  if (!artifact || !isSha256(artifact.contentHash)) {return undefined;}
  let text: string;
  try {
    text = await readTextFile(artifact.filePath);
  } catch {
    return undefined;
  }
  const expectedHash = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
  if (expectedHash !== normalizeSha256(artifact.contentHash)) {return undefined;}
  let root;
  try {
    root = parseXmlDocument(text).root;
  } catch {
    return undefined;
  }
  if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MDCLASSES_NAMESPACE) {return undefined;}
  const metadata = elementChildren(root);
  if (metadata.length !== 1 || metadata[0]!.localName !== owner.metadataType
    || namespaceUriForName(metadata[0]!) !== MDCLASSES_NAMESPACE) {return undefined;}
  const properties = elementChildren(metadata[0]!).filter((element) => element.localName === 'Properties' && namespaceUriForName(element) === MDCLASSES_NAMESPACE);
  if (properties.length !== 1) {return undefined;}
  const names = elementChildren(properties[0]!).filter((element) => element.localName === 'Name' && namespaceUriForName(element) === MDCLASSES_NAMESPACE);
  const expectedName = owner.qualifiedName.split('.').pop() ?? owner.qualifiedName;
  if (names.length !== 1 || textContent(names[0]!).trim().normalize('NFC') !== expectedName.normalize('NFC')) {return undefined;}
  const uuid = metadata[0]!.attributes.find((attribute) => attribute.name === 'uuid')?.value;
  if (!owner.uuid || uuid?.toLocaleLowerCase('en-US') !== owner.uuid.toLocaleLowerCase('en-US')) {return undefined;}
  const versionAttributes = root.attributes.filter((attribute) => attribute.localName === 'version');
  if (versionAttributes.length !== 1 || !versionAttributes[0]!.value.trim()) {return undefined;}
  const relativePath = path.relative(inventory.rootPath, artifact.filePath).replace(/\\/gu, '/');
  if (!isSafeRelativePath(relativePath)) {return undefined;}
  return {
    version: versionAttributes[0]!.value.trim(),
    witness: { sourceId: sourceId(session, side), relativePath, expectedHash, kind: 'file' },
  };
}

function sourceId(session: CompareSession, side: 'left' | 'right'): string {
  return session.state.sources.find((source) => source.side === side)?.sourceId ?? `${side}-source`;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left).replace(/\\/gu, '/');
  const normalizedRight = path.resolve(right).replace(/\\/gu, '/');
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !value.startsWith('../') && !path.isAbsolute(value);
}

function isSha256(value: string): boolean {
  return /^sha256:[\da-f]{64}$/iu.test(value) || /^[\da-f]{64}$/iu.test(value);
}

function normalizeSha256(value: string): string {
  return value.startsWith('sha256:') ? value.slice('sha256:'.length).toLowerCase() : value.toLowerCase();
}

function diagnostic(message: string, sourceIdValue: string, nodeId?: string): CompareMessage {
  return {
    severity: 'error', code: 'XML_DCS_OWNER_VERSION_CONTEXT_REQUIRED', phase: 'compare',
    sourceId: sourceIdValue, ...(nodeId ? { nodeId } : {}), blocking: true, suggestedAction: message,
  };
}
