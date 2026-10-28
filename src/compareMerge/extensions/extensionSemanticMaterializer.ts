import * as path from 'path';
import { pathToFileURL } from 'url';

import type { CompareMessage } from '../domain/compareContracts';
import type { MergeFileWitness, XmlPatchPayload } from '../merge/mergePreview';
import { applySelectedXmlPatches } from '../merge/semanticXmlMerge';
import { captureMergePath } from '../merge/mergeSnapshot';
import type { ExtensionSemanticSelection, ExtensionTransferRow } from './extensionTransfer';

export interface ExtensionSemanticWrite {
  readonly relativePath: string;
  readonly content: Buffer;
  readonly sourceWitnesses: readonly MergeFileWitness[];
}

export interface ExtensionSemanticObjectOutput {
  readonly outputRelativePaths: readonly string[];
  readonly writes: readonly ExtensionSemanticWrite[];
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
    effectiveDescriptorRelativePath: input.targetDescriptorRelativePath,
    effectiveDescriptorContent,
    effectiveDescriptorWitnesses,
  };
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
