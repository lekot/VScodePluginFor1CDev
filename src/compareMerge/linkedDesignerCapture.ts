import * as path from 'path';

import { captureMergePath } from './merge/mergeSnapshot';
import type { ConfigurationInventory } from './inventory/configurationInventory';
import { canonicalRelativePath, LINKED_FORM_REFERENCE_PROPERTIES, stripHash } from './linkedDesignerUtils';
import type { LinkedFormReferenceOwnerSnapshot, LinkedFormXmlSnapshot } from './linkedDesignerTypes';
import { rulesRegistry } from '../rules';

export interface LinkedFormXmlCaptureResult {
  readonly snapshots: readonly LinkedFormXmlSnapshot[];
  readonly issues: readonly string[];
  readonly referenceOwners: readonly LinkedFormReferenceOwnerSnapshot[];
  readonly referenceOwnerIssues: readonly string[];
}

/** Captures target Form.xml bytes once so final linked BSL validation uses the compare snapshot. */
export async function captureLinkedFormXmlSnapshots(
  inventory: ConfigurationInventory,
): Promise<LinkedFormXmlCaptureResult> {
  const snapshots: LinkedFormXmlSnapshot[] = [];
  const issues: string[] = [];
  const referenceOwners: LinkedFormReferenceOwnerSnapshot[] = [];
  const referenceOwnerIssues: string[] = [];
  const forms = inventory.objects.filter((object) => object.metadataType === 'Form' || object.metadataType === 'CommonForm');
  for (const object of forms) {
    const artifacts = inventory.artifactsByObjectId.get(object.objectId) ?? [];
    const descriptor = artifacts.find((artifact) => artifact.kind === 'metadataXml' && samePath(artifact.filePath, object.descriptorPath));
    if (!descriptor) {continue;}
    const descriptorRelative = canonicalRelativePath(inventory.rootPath, descriptor.filePath);
    if (!descriptorRelative) {continue;}
    const requiredFormXml = `${descriptorRelative.replace(/\.xml$/iu, '')}/Ext/Form.xml`;
    const formArtifacts = artifacts.filter((artifact) => artifact.kind === 'formXml' && normalizeRelativePath(artifact.relativePath) === normalizeRelativePath(requiredFormXml));
    if (formArtifacts.length === 0) {continue;}
    if (formArtifacts.length !== 1) {issues.push(requiredFormXml); continue;}
    const artifact = formArtifacts[0]!;
    const relativePath = canonicalRelativePath(inventory.rootPath, artifact.filePath);
    const captured = relativePath
      ? await captureMergePath(path.join(inventory.rootPath, ...relativePath.split('/')), { retainContent: true }).catch(() => undefined)
      : undefined;
    if (captured?.state !== 'file' || !captured.contentBase64 || captured.hash !== stripHash(artifact.contentHash)) {
      issues.push(artifact.relativePath.replace(/\\/gu, '/'));
      continue;
    }
    const moduleId = `${object.qualifiedName}.FormModule`;
    snapshots.push({
      targetRelativePath: relativePath!,
      targetHash: captured.hash,
      targetContent: Buffer.from(captured.contentBase64, 'base64').toString('utf8'),
      moduleId,
      qualifiedName: object.qualifiedName,
    });
  }
  for (const object of inventory.objects) {
    const rules = rulesRegistry.get(object.metadataType);
    const hasFormReference = rules && Object.values(rules.properties).some((property) =>
      property.xml && LINKED_FORM_REFERENCE_PROPERTIES.includes(property.xml as typeof LINKED_FORM_REFERENCE_PROPERTIES[number])
    );
    if (!hasFormReference) {continue;}
    const artifacts = inventory.artifactsByObjectId.get(object.objectId) ?? [];
    const descriptor = artifacts.find((artifact) => artifact.kind === 'metadataXml' && samePath(artifact.filePath, object.descriptorPath));
    const relativePath = descriptor && canonicalRelativePath(inventory.rootPath, descriptor.filePath);
    const captured = descriptor && relativePath
      ? await captureMergePath(descriptor.filePath, { retainContent: true }).catch(() => undefined)
      : undefined;
    if (!descriptor || !relativePath || captured?.state !== 'file' || !captured.contentBase64
      || captured.hash !== stripHash(descriptor.contentHash)) {
      referenceOwnerIssues.push(relativePath ?? path.relative(inventory.rootPath, object.descriptorPath).replace(/\\/gu, '/'));
      continue;
    }
    referenceOwners.push({
      metadataType: object.metadataType,
      qualifiedName: object.qualifiedName,
      targetRelativePath: relativePath,
      targetHash: captured.hash,
      targetContent: Buffer.from(captured.contentBase64, 'base64').toString('utf8'),
    });
  }
  return { snapshots, issues, referenceOwners, referenceOwnerIssues };
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
