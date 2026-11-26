import * as path from 'path';

import { captureMergePath } from './merge/mergeSnapshot';
import type { ConfigurationInventory } from './inventory/configurationInventory';
import { canonicalRelativePath, LINKED_FORM_REFERENCE_PROPERTIES, stripHash } from './linkedDesignerUtils';
import type { LinkedFormReferenceOwnerReference, LinkedFormReferenceOwnerSnapshot, LinkedFormXmlSnapshot } from './linkedDesignerTypes';
import { rulesRegistry } from '../rules';

export interface LinkedFormXmlCaptureResult {
  readonly snapshots: readonly LinkedFormXmlSnapshot[];
  readonly issues: readonly string[];
  readonly referenceOwners: readonly LinkedFormReferenceOwnerSnapshot[];
  readonly referenceOwnerReferences: readonly LinkedFormReferenceOwnerReference[];
  readonly referenceOwnerIssues: readonly string[];
}

/** Captures target Form.xml bytes once so final linked BSL validation uses the compare snapshot. */
export async function captureLinkedFormXmlSnapshots(
  inventory: ConfigurationInventory,
  options: { readonly includeReferenceOwnerSnapshots?: boolean } = {},
): Promise<LinkedFormXmlCaptureResult> {
  const formCapture = await captureTargetFormXmlSnapshots(inventory);
  const ownerCapture = await captureFormReferenceOwners(inventory, options.includeReferenceOwnerSnapshots !== false);
  return {
    snapshots: formCapture.snapshots,
    issues: formCapture.issues,
    referenceOwners: ownerCapture.snapshots,
    referenceOwnerReferences: ownerCapture.references,
    referenceOwnerIssues: ownerCapture.issues,
  };
}

async function captureTargetFormXmlSnapshots(
  inventory: ConfigurationInventory,
): Promise<{ readonly snapshots: LinkedFormXmlSnapshot[]; readonly issues: string[] }> {
  const snapshots: LinkedFormXmlSnapshot[] = [];
  const issues: string[] = [];
  const forms = inventory.objects.filter((object) => object.metadataType === 'Form' || object.metadataType === 'CommonForm');
  for (const object of forms) {
    const captured = await captureTargetFormXmlSnapshot(inventory, object);
    if (captured.snapshot) {snapshots.push(captured.snapshot);}
    if (captured.issue) {issues.push(captured.issue);}
  }
  return { snapshots, issues };
}

async function captureTargetFormXmlSnapshot(
  inventory: ConfigurationInventory,
  object: ConfigurationInventory['objects'][number],
): Promise<{ readonly snapshot?: LinkedFormXmlSnapshot; readonly issue?: string }> {
  const artifacts = inventory.artifactsByObjectId.get(object.objectId) ?? [];
  const descriptor = artifacts.find((artifact) => artifact.kind === 'metadataXml' && samePath(artifact.filePath, object.descriptorPath));
  if (!descriptor) {return {};}
  const descriptorRelative = canonicalRelativePath(inventory.rootPath, descriptor.filePath);
  if (!descriptorRelative) {return {};}
  const requiredFormXml = `${descriptorRelative.replace(/\.xml$/iu, '')}/Ext/Form.xml`;
  const formArtifacts = artifacts.filter((artifact) => artifact.kind === 'formXml' && normalizeRelativePath(artifact.relativePath) === normalizeRelativePath(requiredFormXml));
  if (formArtifacts.length === 0) {return {};}
  if (formArtifacts.length !== 1) {return { issue: requiredFormXml };}
  const artifact = formArtifacts[0]!;
  const relativePath = canonicalRelativePath(inventory.rootPath, artifact.filePath);
  const captured = relativePath
    ? await captureMergePath(path.join(inventory.rootPath, ...relativePath.split('/')), { retainContent: true }).catch(() => undefined)
    : undefined;
  if (captured?.state !== 'file' || !captured.contentBase64 || captured.hash !== stripHash(artifact.contentHash)) {
    return { issue: artifact.relativePath.replace(/\\/gu, '/') };
  }
  return {
    snapshot: {
      targetRelativePath: relativePath!,
      targetHash: captured.hash,
      targetContent: Buffer.from(captured.contentBase64, 'base64').toString('utf8'),
      moduleId: `${object.qualifiedName}.FormModule`,
      qualifiedName: object.qualifiedName,
    },
  };
}

async function captureFormReferenceOwners(
  inventory: ConfigurationInventory,
  includeSnapshots: boolean,
): Promise<{ readonly snapshots: LinkedFormReferenceOwnerSnapshot[]; readonly references: LinkedFormReferenceOwnerReference[]; readonly issues: string[] }> {
  const snapshots: LinkedFormReferenceOwnerSnapshot[] = [];
  const references: LinkedFormReferenceOwnerReference[] = [];
  const issues: string[] = [];
  for (const object of inventory.objects) {
    if (!hasLinkedFormReferenceProperties(object.metadataType)) {continue;}
    const capture = await captureFormReferenceOwner(inventory, object, includeSnapshots);
    if (capture.reference) {references.push(capture.reference);}
    if (capture.snapshot) {snapshots.push(capture.snapshot);}
    if (capture.issue) {issues.push(capture.issue);}
  }
  return { snapshots, references, issues };
}

function hasLinkedFormReferenceProperties(metadataType: string): boolean {
  const rules = rulesRegistry.get(metadataType);
  return Boolean(rules && Object.values(rules.properties).some((property) =>
    property.xml && LINKED_FORM_REFERENCE_PROPERTIES.includes(property.xml as typeof LINKED_FORM_REFERENCE_PROPERTIES[number])
  ));
}

async function captureFormReferenceOwner(
  inventory: ConfigurationInventory,
  object: ConfigurationInventory['objects'][number],
  includeSnapshot: boolean,
): Promise<{ readonly reference?: LinkedFormReferenceOwnerReference; readonly snapshot?: LinkedFormReferenceOwnerSnapshot; readonly issue?: string }> {
  const artifact = inventory.artifactsByObjectId.get(object.objectId)?.find((candidate) =>
    candidate.kind === 'metadataXml' && samePath(candidate.filePath, object.descriptorPath)
  );
  const relativePath = artifact && canonicalRelativePath(inventory.rootPath, artifact.filePath);
  if (!artifact || !relativePath) {return { issue: path.relative(inventory.rootPath, object.descriptorPath).replace(/\\/gu, '/') };}
  const targetHash = stripHash(artifact.contentHash);
  if (!/^[a-f0-9]{64}$/iu.test(targetHash)) {return { issue: relativePath };}
  const reference: LinkedFormReferenceOwnerReference = {
    metadataType: object.metadataType,
    qualifiedName: object.qualifiedName,
    targetRelativePath: relativePath,
    targetHash,
  };
  if (!includeSnapshot) {return { reference };}
  const captured = await captureMergePath(artifact.filePath, { retainContent: true }).catch(() => undefined);
  if (captured?.state !== 'file' || !captured.contentBase64 || captured.hash !== targetHash) {return { reference, issue: relativePath };}
  return {
    reference,
    snapshot: {
      ...reference,
      targetHash: captured.hash,
      targetContent: Buffer.from(captured.contentBase64, 'base64').toString('utf8'),
    },
  };
}

function samePath(left: string, right: string): boolean {
  const a = path.normalize(left);
  const b = path.normalize(right);
  return process.platform === 'win32'
    ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
    : a === b;
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/gu, '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}
