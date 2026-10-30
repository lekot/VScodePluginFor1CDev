import * as path from 'path';
import { pathToFileURL } from 'url';

import type { CompareMessage } from '../domain/compareContracts';
import { MISSING_TARGET_HASH, type MergeFileWitness, type XmlPatchPayload } from '../merge/mergePreview';
import { applySelectedXmlPatches } from '../merge/semanticXmlMerge';
import { captureMergePath } from '../merge/mergeSnapshot';
import type { ExtensionSemanticSelection, ExtensionTransferRow } from './extensionTransfer';
import { materializeExtensionAdoptedPatchBatch } from './extensionAdoptedSemanticHost';

export interface ExtensionSemanticWrite {
  readonly relativePath: string;
  readonly content: Buffer;
  readonly sourceWitnesses: readonly MergeFileWitness[];
}

export interface ExtensionSemanticObjectOutput {
  readonly outputRelativePaths: readonly string[];
  readonly writes: readonly ExtensionSemanticWrite[];
  readonly deletePaths: readonly string[];
  readonly effectiveDescriptorRelativePath: string;
  readonly effectiveDescriptorContent: Buffer;
  readonly effectiveDescriptorWitnesses: readonly MergeFileWitness[];
}

export async function buildSemanticObjectOutput(input: {
  targetRootPath: string;
  sourceRootPath: string;
  targetDescriptorRelativePath: string;
  row: ExtensionTransferRow;
  witnesses: readonly MergeFileWitness[];
  selections: readonly ExtensionSemanticSelection[];
  addedMetadataReferences?: readonly string[];
}): Promise<ExtensionSemanticObjectOutput | { diagnostic: CompareMessage }> {
  const target = input.row.target;
  const incoming = input.row.incoming;
  if (!target?.descriptorContent || !target.descriptorRelativePath || !incoming) {
    return { diagnostic: diagnostic('Целевой descriptor отсутствует для семантического XML-слияния.', input.row.targetRoot.sourceId, input.row.id) };
  }

  const byPath = new Map<string, ExtensionSemanticSelection[]>();
  for (const selection of input.selections) {
    const group = byPath.get(selection.targetRelativePath) ?? [];
    group.push(selection);
    byPath.set(selection.targetRelativePath, group);
  }

  const writes: ExtensionSemanticWrite[] = [];
  let effectiveDescriptorContent = target.descriptorContent;
  let effectiveDescriptorWitnesses: readonly MergeFileWitness[] = input.witnesses;
  for (const [relativePath, pathSelections] of byPath) {
    if (pathSelections.some((selection) => selection.adoptedArtifact !== undefined)) {
      const adopted = await buildAdoptedPathWrite(input, relativePath, pathSelections);
      if ('diagnostic' in adopted) {return adopted;}
      if (adopted.write) {
        writes.push(adopted.write);
        if (relativePath === input.targetDescriptorRelativePath) {
          effectiveDescriptorContent = adopted.write.content;
          effectiveDescriptorWitnesses = adopted.write.sourceWitnesses;
        }
      }
      continue;
    }
    const first = pathSelections[0]!;
    const isDescriptor = relativePath === input.targetDescriptorRelativePath;
    let targetPath = path.join(input.targetRootPath, relativePath);
    let expectedTargetHash = first.targetHash;
    if (isDescriptor) {
      targetPath = path.join(input.targetRootPath, target.descriptorRelativePath);
      expectedTargetHash = target.descriptorHash ?? first.targetHash;
    } else {
      const targetFile = target.sidecarFiles.find((file) => file.relativePath === relativePath);
      if (!targetFile) {
        return { diagnostic: diagnostic(`Целевой XML sidecar для семантического изменения отсутствует: ${relativePath}`, input.row.targetRoot.sourceId, input.row.id) };
      }
      expectedTargetHash = targetFile.hash;
    }

    let snapshot;
    try {
      snapshot = await captureMergePath(targetPath, { retainContent: true });
    } catch (error) {
      return { diagnostic: diagnostic(`Не удалось прочитать target XML ${relativePath}: ${errorMessage(error)}`, input.row.targetRoot.sourceId, input.row.id) };
    }
    if (snapshot.state !== 'file' || snapshot.contentBase64 === undefined || snapshot.hash !== expectedTargetHash) {
      return { diagnostic: diagnostic(`Target XML изменился после сравнения: ${relativePath}`, input.row.targetRoot.sourceId, input.row.id) };
    }

    const patches: XmlPatchPayload[] = [];
    const sourceWitnesses: MergeFileWitness[] = [...input.witnesses];
    for (const selection of pathSelections) {
      if (selection.targetRelativePath !== relativePath) {
        return { diagnostic: diagnostic('Семантический XML candidate привязан к другому target path.', input.row.targetRoot.sourceId, input.row.id) };
      }
      const sourceSnapshot = await captureMergePath(
        path.join(input.sourceRootPath, selection.sourceRelativePath),
        { retainContent: false },
      ).catch(() => undefined);
      if (sourceSnapshot?.state !== 'file' || sourceSnapshot.hash !== selection.sourceHash) {
        return { diagnostic: diagnostic(`Исходный XML изменился после сравнения: ${selection.sourceRelativePath}`, incoming.sourceId, input.row.id) };
      }
      const factoryResult = await selection.candidateFactory();
      if (!factoryResult.ok) {
        return { diagnostic: diagnostic(factoryResult.diagnostics[0]?.suggestedAction ?? 'Выбранное XML-изменение больше недоступно.', incoming.sourceId, selection.nodeId) };
      }
      const candidate = factoryResult.candidate;
      const patch = candidate.xmlPatch;
      const targetUri = pathToFileURL(targetPath).toString();
      if (!patch || patch.semanticKind !== selection.kind || candidate.targetUri !== targetUri) {
        return { diagnostic: diagnostic('Семантический XML candidate не совпадает с выбранным target-файлом.', incoming.sourceId, selection.nodeId) };
      }
      const context = patch.semanticContext;
      const availableMetadataReferences = input.addedMetadataReferences?.length
        ? [...new Set([...(context?.availableMetadataReferences ?? []), ...input.addedMetadataReferences])]
        : context?.availableMetadataReferences;
      patches.push({
        ...patch,
        ...(availableMetadataReferences ? { semanticContext: { ...context, availableMetadataReferences } } : {}),
      });
      sourceWitnesses.push(...(selection.dependencyWitnesses ?? []));
      sourceWitnesses.push(...(patch.sourceWitnesses ?? []));
      sourceWitnesses.push({
        sourceId: incoming.sourceId,
        relativePath: selection.sourceRelativePath,
        expectedHash: selection.sourceHash,
        kind: 'file',
      });
    }

    const previousBytes = Buffer.from(snapshot.contentBase64, 'base64');
    const applied = applySelectedXmlPatches(previousBytes.toString('utf8'), patches);
    if (!applied.ok) {
      return { diagnostic: diagnostic(applied.message, input.row.targetRoot.sourceId, input.row.id) };
    }
    const content = Buffer.from(applied.source, 'utf8');
    if (content.equals(previousBytes)) {continue;}
    const write: ExtensionSemanticWrite = {
      relativePath,
      content,
      sourceWitnesses: dedupeWitnesses(sourceWitnesses),
    };
    writes.push(write);
    if (isDescriptor) {
      effectiveDescriptorContent = content;
      effectiveDescriptorWitnesses = write.sourceWitnesses;
    }
  }

  if (writes.length === 0) {
    return { diagnostic: diagnostic('Выбранные XML-изменения не меняют target-файлы.', incoming.sourceId, input.row.id) };
  }
  return {
    outputRelativePaths: writes.map((write) => write.relativePath),
    writes,
    deletePaths: [],
    effectiveDescriptorRelativePath: input.targetDescriptorRelativePath,
    effectiveDescriptorContent,
    effectiveDescriptorWitnesses,
  };
}

async function buildAdoptedPathWrite(
  input: Parameters<typeof buildSemanticObjectOutput>[0],
  relativePath: string,
  selections: readonly ExtensionSemanticSelection[],
): Promise<{ readonly write?: ExtensionSemanticWrite } | { readonly diagnostic: CompareMessage }> {
  const first = selections[0]!;
  const artifact = first.adoptedArtifact;
  const incoming = input.row.incoming;
  if (!artifact || !incoming) {
    return { diagnostic: diagnostic('Для adopted XML-слияния отсутствуют captured artifact или incoming object.', input.row.targetRoot.sourceId, input.row.id) };
  }
  if (selections.some((selection) => selection.adoptedArtifact !== artifact
      || selection.targetRelativePath !== relativePath
      || selection.kind !== artifact.kind
      || selection.targetHash !== artifact.targetHash
      || selection.sourceHash !== artifact.sourceHash)) {
    return { diagnostic: diagnostic('Выбранная группа adopted XML содержит разные capture recipes или физические identities.', incoming.sourceId, input.row.id) };
  }
  const targetPath = path.resolve(input.targetRootPath, relativePath);
  const sourcePath = path.resolve(input.sourceRootPath, artifact.sourceRelativePath);
  if (path.resolve(artifact.targetFilePath) !== targetPath || path.resolve(artifact.sourceFilePath) !== sourcePath) {
    return { diagnostic: diagnostic('Adopted artifact paths не совпадают с target/source roots выбранного transfer row.', incoming.sourceId, input.row.id) };
  }
  let targetSnapshot;
  try {
    targetSnapshot = await captureMergePath(targetPath, { retainContent: false });
  } catch (error) {
    return { diagnostic: diagnostic(`Не удалось проверить target XML ${relativePath}: ${errorMessage(error)}`, input.row.targetRoot.sourceId, input.row.id) };
  }
  if (artifact.targetHash === MISSING_TARGET_HASH) {
    if (targetSnapshot.state !== 'missing') {
      return { diagnostic: diagnostic(`Ожидаемый отсутствующий target XML появился или изменил состояние: ${relativePath}`, input.row.targetRoot.sourceId, input.row.id) };
    }
  } else if (targetSnapshot.state !== 'file' || targetSnapshot.hash !== artifact.targetHash) {
    return { diagnostic: diagnostic(`Target XML изменился после сравнения: ${relativePath}`, input.row.targetRoot.sourceId, input.row.id) };
  }

  const patches: XmlPatchPayload[] = [];
  const supplementalWitnesses: MergeFileWitness[] = [...input.witnesses];
  for (const selection of selections) {
    const sourceSnapshot = await captureMergePath(
      path.resolve(input.sourceRootPath, selection.sourceRelativePath),
      { retainContent: false },
    ).catch(() => undefined);
    if (sourceSnapshot?.state !== 'file' || sourceSnapshot.hash !== selection.sourceHash) {
      return { diagnostic: diagnostic(`Исходный XML изменился после сравнения: ${selection.sourceRelativePath}`, incoming.sourceId, selection.nodeId) };
    }
    const factoryResult = await selection.candidateFactory();
    if (!factoryResult.ok) {
      return { diagnostic: diagnostic(factoryResult.diagnostics[0]?.suggestedAction ?? 'Выбранное adopted XML-изменение больше недоступно.', incoming.sourceId, selection.nodeId) };
    }
    const candidate = factoryResult.candidate;
    const patch = candidate.xmlPatch;
    if (!patch || patch.semanticKind !== artifact.kind || candidate.targetUri !== pathToFileURL(targetPath).toString()) {
      return { diagnostic: diagnostic('Adopted XML candidate не совпадает с выбранным target-файлом.', incoming.sourceId, selection.nodeId) };
    }
    const context = patch.semanticContext;
    const availableMetadataReferences = input.addedMetadataReferences?.length
      ? [...new Set([...(context?.availableMetadataReferences ?? []), ...input.addedMetadataReferences])]
      : context?.availableMetadataReferences;
    patches.push({
      ...patch,
      ...(availableMetadataReferences ? { semanticContext: { ...context, availableMetadataReferences } } : {}),
    });
    supplementalWitnesses.push(...(selection.dependencyWitnesses ?? []));
  }
  const result = materializeExtensionAdoptedPatchBatch({
    artifact,
    targetRelativePath: relativePath,
    patches,
    supplementalWitnesses,
  });
  if (!result.ok) {
    return { diagnostic: diagnostic(result.reason, incoming.sourceId, input.row.id) };
  }
  return result.changed ? { write: result.write } : {};
}

function dedupeWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] {
  const byKey = new Map<string, MergeFileWitness>();
  for (const witness of witnesses) {
    byKey.set(`${witness.sourceId}\0${witness.relativePath}\0${witness.kind ?? 'file'}`, { ...witness });
  }
  return [...byKey.values()];
}

function diagnostic(message: string, sourceId: string, nodeId?: string): CompareMessage {
  return {
    severity: 'error', code: 'EXTENSION_TRANSFER_BLOCKED', phase: 'compare',
    sourceId, nodeId, blocking: true, suggestedAction: message,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
