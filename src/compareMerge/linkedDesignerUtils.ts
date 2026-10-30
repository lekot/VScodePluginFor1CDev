import * as path from 'path';
import { createHash } from 'crypto';

import type { CompareMessage } from './domain/compareContracts';
import type { MergeFileWitness } from './merge/mergePreview';

export const LINKED_FORM_REFERENCE_PROPERTIES = [
  'DefaultForm',
  'DefaultObjectForm',
  'DefaultFolderForm',
  'DefaultListForm',
  'DefaultChoiceForm',
  'DefaultFolderChoiceForm',
  'DefaultRecordForm',
  'DefaultSettingsForm',
  'DefaultVariantForm',
  'DefaultLoadForm',
  'DefaultSaveForm',
] as const;

export function blocked(message: string, sourceId: string, nodeId?: string): CompareMessage {
  return {
    severity: 'error',
    code: 'LINKED_DESIGNER_PACKAGE_BLOCKED',
    phase: 'compare',
    sourceId,
    ...(nodeId ? { nodeId } : {}),
    blocking: true,
    suggestedAction: message,
  };
}

export function finalName(qualifiedName: string): string {
  return qualifiedName.split('.').pop() ?? qualifiedName;
}

export function normalizePath(value: string): string {
  const normalized = value.replace(/\\/gu, '/').replace(/\/+$/u, '');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export function normalizeAbsolutePath(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

export function canonicalRelativePath(rootPath: string, filePath: string): string | undefined {
  if (!path.isAbsolute(filePath)) {return undefined;}
  const relative = path.relative(rootPath, filePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {return undefined;}
  return relative.split(path.sep).join('/');
}

export function stripHash(value: string): string {
  return value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
}

export function hashBuffer(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function uniqueWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] {
  const seen = new Set<string>();
  return witnesses.filter((witness) => {
    const key = `${witness.sourceId}\0${witness.relativePath}\0${witness.kind ?? 'file'}\0${witness.expectedHash}`;
    if (seen.has(key)) {return false;}
    seen.add(key);
    return true;
  });
}
