import * as path from 'path';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';

import type { ExtensionMetadataIndex } from './extensionMetadataIndex';
import type { ExtensionMaterializerInput, ExtensionTransferRow } from './extensionTransfer';
import { MISSING_TARGET_HASH, type CapturedFileWritePayload, type MergeCandidate, type MergeFileWitness } from '../merge/mergePreview';
import { captureMergePath, type MergePathSnapshot } from '../merge/mergeSnapshot';
import type { CompareMessage } from '../domain/compareContracts';

export interface CapturedExtensionWrite {
  readonly relativePath: string;
  readonly content: Buffer;
  readonly sourceWitnesses: readonly MergeFileWitness[];
}

export async function createCapturedExtensionWriteCandidate(
  input: ExtensionMaterializerInput,
  row: ExtensionTransferRow,
  write: CapturedExtensionWrite,
  roots: ReadonlyMap<string, ExtensionMetadataIndex>,
  isConfigurationWrite = false,
): Promise<MergeCandidate | { diagnostic: CompareMessage }> {
  const targetRoot = input.target.canonicalRootPath ?? input.target.rootPath;
  const targetPath = path.join(targetRoot, write.relativePath);
  let targetSnapshot: MergePathSnapshot;
  try {
    targetSnapshot = await captureMergePath(targetPath, { retainContent: false });
  } catch (error) {
    return { diagnostic: diagnostic(`Не удалось проверить target path ${write.relativePath}: ${errorMessage(error)}`, input.target.sourceId, row.id) };
  }
  const expectedOldHash = snapshotHashOrMissing(targetSnapshot);
  if (targetSnapshot.state !== 'missing' && targetSnapshot.type !== 'file') {
    return { diagnostic: diagnostic(`Target path ${write.relativePath} уже является каталогом или special file.`, input.target.sourceId, row.id) };
  }
  if (expectedOldHash === undefined) {
    return { diagnostic: diagnostic(`Не удалось вычислить hash текущего target path ${write.relativePath}.`, input.target.sourceId, row.id) };
  }
  const originalExpected = expectedTargetHashAtCompare(row, write.relativePath, input.target);
  if (originalExpected !== undefined && originalExpected !== expectedOldHash) {
    return { diagnostic: diagnostic(`Target path изменился после сравнения: ${write.relativePath}`, input.target.sourceId, row.id) };
  }
  const targetWitness: MergeFileWitness = {
    sourceId: input.target.sourceId,
    relativePath: write.relativePath,
    expectedHash: expectedOldHash,
    kind: 'file',
  };
  const witnesses = dedupeWitnesses([...write.sourceWitnesses, targetWitness]);
  const payload: CapturedFileWritePayload = { contentBase64: write.content.toString('base64'), witnesses };
  const targetUri = pathToFileURL(targetPath).toString();
  const candidate: MergeCandidate = {
    kind: 'fileWrite',
    sourceId: 'right-source',
    snapshotId: input.rightSnapshotId,
    nodeId: isConfigurationWrite ? 'extension:configuration-registration' : row.id,
    targetUri,
    expectedOldHash,
    newHash: hashContent(write.content),
    fileWrite: payload,
    previewPath: write.relativePath,
    previewEffect: expectedOldHash === MISSING_TARGET_HASH ? 'create' : 'replace',
  };
  for (const witness of witnesses) {
    if (!roots.has(witness.sourceId)) {
      return { diagnostic: diagnostic(`Source witness отсутствует в compare session: ${witness.sourceId}`, witness.sourceId, row.id) };
    }
  }
  return candidate;
}

function expectedTargetHashAtCompare(
  row: ExtensionTransferRow,
  relativePath: string,
  targetRoot: ExtensionMetadataIndex,
): string | undefined {
  if (relativePath === 'Configuration.xml') {return targetRoot.configurationHash;}
  if (!row.target) {return MISSING_TARGET_HASH;}
  if (relativePath === row.target.descriptorRelativePath) {return row.target.descriptorHash;}
  return row.target.sidecarFiles.find((file) => file.relativePath === relativePath)?.hash ?? MISSING_TARGET_HASH;
}

function snapshotHashOrMissing(snapshot: MergePathSnapshot): string | undefined {
  if (snapshot.state === 'missing') {return MISSING_TARGET_HASH;}
  return snapshot.type === 'file' ? snapshot.hash : undefined;
}

function dedupeWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] {
  const byKey = new Map<string, MergeFileWitness>();
  for (const witness of witnesses) {
    byKey.set(`${witness.sourceId}\0${witness.relativePath}\0${witness.kind ?? 'file'}`, { ...witness });
  }
  return [...byKey.values()];
}

function hashContent(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function diagnostic(message: string, sourceId: string, nodeId?: string): CompareMessage {
  return { severity: 'error', code: 'EXTENSION_TRANSFER_BLOCKED', phase: 'compare', sourceId, nodeId, blocking: true, suggestedAction: message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
