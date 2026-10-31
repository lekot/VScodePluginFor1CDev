import * as path from 'path';
import { pathToFileURL } from 'url';

import type { CompareMessage } from '../domain/compareContracts';
import { MISSING_TARGET_HASH, type MergeFileWitness, type XmlPatchPayload } from '../merge/mergePreview';
import { applySelectedXmlPatches } from '../merge/semanticXmlMerge';
import { captureMergePath } from '../merge/mergeSnapshot';
import type { ExtensionSemanticSelection, ExtensionTransferRow } from './extensionTransfer';
import type { ExtensionIndexedObject, ExtensionMetadataIndex } from './extensionMetadataIndex';
import { materializeExtensionAdoptedPatchBatch } from './extensionAdoptedSemanticHost';
import {
  materializeCapturedAdoptedRightsTarget,
  normalizeCapturedAdoptedRightsWitnesses,
  type CapturedAdoptedRightsRecipe,
} from './extensionAdoptedRightsBridge';
import {
  materializeCapturedAdoptedTemplateBundle,
  type CapturedAdoptedTemplateBundle,
} from './extensionAdoptedTemplateBridge';
import type { CapturedAdoptedTemplatePhysicalSide } from './extensionAdoptedTemplateCapture';
import type { AdoptedSemanticArtifactCapture } from './extensionAdoptedSemanticBridge';
import { elementChildren, parseXmlDocument, serializeXmlDocument, textContent, type XmlElement } from '../xml/xmlDom';
import { namespaceUriForName } from '../adapters/semanticXml/semanticXmlIdentity';
import { prefixForNamespace } from './adoptedDesignerXml';
import { localFilePath } from '../adapters/semanticXml/semanticXmlAdapterUtils';

const MD_CLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const RIGHTS_STATE_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/readable';

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
  const deletePaths: string[] = [];
  let effectiveDescriptorContent = target.descriptorContent;
  let effectiveDescriptorWitnesses: readonly MergeFileWitness[] = input.witnesses;
  let rightsDescriptorState: { readonly recipe: CapturedAdoptedRightsRecipe; readonly witnesses: readonly MergeFileWitness[] } | undefined;
  for (const [relativePath, pathSelections] of byPath) {
    if (pathSelections.some(hasAdoptedTemplateBundle)) {
      const adopted = await buildAdoptedTemplatePathWrites(input, relativePath, pathSelections, byPath);
      if ('diagnostic' in adopted) {return adopted;}
      writes.push(...adopted.writes);
      deletePaths.push(...adopted.deletePaths);
      if (adopted.descriptorContent) {
        effectiveDescriptorContent = adopted.descriptorContent;
        effectiveDescriptorWitnesses = adopted.descriptorWitnesses;
      }
      continue;
    }
    if (pathSelections.some(hasAdoptedRightsRecipe)) {
      const adopted = await buildAdoptedRightsPathWrite(input, relativePath, pathSelections);
      if ('diagnostic' in adopted) {return adopted;}
      if (adopted.write) {writes.push(adopted.write);}
      if (adopted.requiresRightsPropertyState && adopted.recipe) {
        if (rightsDescriptorState && rightsDescriptorState.recipe !== adopted.recipe) {
          return { diagnostic: diagnostic('Несколько adopted Rights recipes требуют разных target descriptor mutations.', incoming.sourceId, input.row.id) };
        }
        rightsDescriptorState = { recipe: adopted.recipe, witnesses: adopted.requiredWitnesses };
      }
      continue;
    }
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

  if (rightsDescriptorState) {
    const descriptorPath = input.targetDescriptorRelativePath;
    if (!samePath(rightsDescriptorState.recipe.targetDescriptorRelativePath, descriptorPath)) {
      return { diagnostic: diagnostic('Adopted Rights descriptor capture path не совпадает с transfer row target descriptor.', incoming.sourceId, input.row.id) };
    }
    const augmented = addRightsExtendedState(effectiveDescriptorContent, rightsDescriptorState.recipe.formatVersion);
    if ('reason' in augmented) {return { diagnostic: diagnostic(augmented.reason, input.row.targetRoot.sourceId, input.row.id) };}
    if (augmented.changed) {
      const existingIndex = writes.findIndex((write) => samePath(write.relativePath, descriptorPath));
      const previousWitnesses = existingIndex >= 0 ? writes[existingIndex]!.sourceWitnesses : effectiveDescriptorWitnesses;
      const combined = combineWitnesses([...input.witnesses, ...previousWitnesses, ...rightsDescriptorState.witnesses]);
      if ('reason' in combined) {return { diagnostic: diagnostic(combined.reason, incoming.sourceId, input.row.id) };}
      const write: ExtensionSemanticWrite = {
        relativePath: descriptorPath,
        content: augmented.content,
        sourceWitnesses: combined.witnesses,
      };
      if (existingIndex >= 0) {writes[existingIndex] = write;}
      else {writes.push(write);}
      effectiveDescriptorContent = augmented.content;
      effectiveDescriptorWitnesses = combined.witnesses;
    }
  }

  if (writes.length === 0 && deletePaths.length === 0) {
    return { diagnostic: diagnostic('Выбранные XML-изменения не меняют target-файлы.', incoming.sourceId, input.row.id) };
  }
  return {
    outputRelativePaths: [...new Set([...writes.map((write) => write.relativePath), ...deletePaths])],
    writes,
    deletePaths,
    effectiveDescriptorRelativePath: input.targetDescriptorRelativePath,
    effectiveDescriptorContent,
    effectiveDescriptorWitnesses,
  };
}

type AdoptedRightsSelection = ExtensionSemanticSelection & { readonly adoptedRights?: CapturedAdoptedRightsRecipe };
type AdoptedTemplateSelection = ExtensionSemanticSelection & { readonly adoptedTemplateBundle?: CapturedAdoptedTemplateBundle };

function hasAdoptedRightsRecipe(selection: ExtensionSemanticSelection): boolean {
  return (selection as AdoptedRightsSelection).adoptedRights !== undefined;
}

function hasAdoptedTemplateBundle(selection: ExtensionSemanticSelection): boolean {
  return (selection as AdoptedTemplateSelection).adoptedTemplateBundle !== undefined;
}

async function buildAdoptedTemplatePathWrites(
  input: Parameters<typeof buildSemanticObjectOutput>[0],
  relativePath: string,
  selections: readonly ExtensionSemanticSelection[],
  byPath: ReadonlyMap<string, readonly ExtensionSemanticSelection[]>,
): Promise<{
  readonly writes: readonly ExtensionSemanticWrite[];
  readonly deletePaths: readonly string[];
  readonly descriptorContent?: Buffer;
  readonly descriptorWitnesses: readonly MergeFileWitness[];
} | { readonly diagnostic: CompareMessage }> {
  const incoming = input.row.incoming;
  const target = input.row.target;
  const bundles = selections.filter(hasAdoptedTemplateBundle) as AdoptedTemplateSelection[];
  const recipe = bundles[0]?.adoptedTemplateBundle;
  if (!recipe || bundles.length !== 1 || !target || !incoming || !target.descriptorRelativePath || !incoming.descriptorRelativePath
      || !target.descriptorContent || !incoming.descriptorContent) {
    return { diagnostic: diagnostic('Для набора Template отсутствуют дескрипторы transfer row или единственный захваченный рецепт.', input.row.targetRoot.sourceId, input.row.id) };
  }
  const targetDescriptorPath = target.descriptorRelativePath;
  const selectedSourceDescriptorPath = recipe.sourceDescriptor.witness.relativePath;
  const bindingReason = validateTemplateRowBinding(input.row, recipe);
  if (bindingReason) {
    return { diagnostic: diagnostic(bindingReason, incoming.sourceId, input.row.id) };
  }
  if (!samePath(relativePath, recipe.targetDescriptor.witness.relativePath)
      || recipe.sourceDescriptor.witness.sourceId !== incoming.sourceId) {
    return { diagnostic: diagnostic('Захваченный adopted Template не совпадает с путями выбранных дескрипторов цели и источника.', incoming.sourceId, input.row.id) };
  }
  if (selections.some((selection) => {
    const bundle = (selection as AdoptedTemplateSelection).adoptedTemplateBundle;
    return selection.kind !== 'metadataXml' || (bundle !== undefined && bundle !== recipe)
      || !samePath(selection.targetRelativePath, relativePath)
      || !samePath(selection.sourceRelativePath, selectedSourceDescriptorPath)
      || !sameHash(selection.targetHash, recipe.targetDescriptor.witness.expectedHash)
      || !sameHash(selection.sourceHash, recipe.sourceDescriptor.witness.expectedHash)
      || selection.adoptedRights !== undefined
      || (selection !== bundles[0] && selection.adoptedArtifact === undefined)
      || (selection.adoptedArtifact !== undefined && !sameAdoptedTemplateDescriptorArtifact(selection.adoptedArtifact, recipe));
  })) {
    return { diagnostic: diagnostic('Выбранная группа adopted Template содержит другие области артефактов, физические хэши или пути дескрипторов.', incoming.sourceId, input.row.id) };
  }

  const targetPath = path.resolve(input.targetRootPath, relativePath);
  const targetUri = pathToFileURL(targetPath).toString();
  const patches: XmlPatchPayload[] = [];
  const candidateWitnesses: MergeFileWitness[] = [];
  for (const selection of selections) {
    const factoryResult = await selection.candidateFactory();
    if (!factoryResult.ok) {
      return { diagnostic: diagnostic(factoryResult.diagnostics[0]?.suggestedAction ?? 'Выбранный набор Template больше недоступен.', incoming.sourceId, selection.nodeId) };
    }
    const candidate = factoryResult.candidate;
    const patch = candidate.xmlPatch;
    if (candidate.targetUri !== targetUri) {
      return { diagnostic: diagnostic('Кандидат набора Template не совпадает с захваченным путём целевого дескриптора.', incoming.sourceId, selection.nodeId) };
    }
    if (patch) {
      if (patch.semanticKind !== 'metadataXml'
          || [patch.target, patch.destinationParent, patch.insertBefore].some((address) => address !== undefined
            && path.resolve(localFilePath(address.filePath)) !== targetPath)) {
        return { diagnostic: diagnostic('Группа набора Template содержит XML-изменение вне захваченного дескриптора метаданных.', incoming.sourceId, selection.nodeId) };
      }
      const context = patch.semanticContext;
      const availableMetadataReferences = input.addedMetadataReferences?.length
        ? [...new Set([...(context?.availableMetadataReferences ?? []), ...input.addedMetadataReferences])]
        : context?.availableMetadataReferences;
      patches.push({
        ...patch,
        ...(availableMetadataReferences ? { semanticContext: { ...context, availableMetadataReferences } } : {}),
      });
    } else if (!hasAdoptedTemplateBundle(selection)) {
      return { diagnostic: diagnostic('Без XML-изменения можно выполнить только захваченный набор Template.', incoming.sourceId, selection.nodeId) };
    }
    candidateWitnesses.push(...(selection.dependencyWitnesses ?? []), ...(candidate.sourceWitnesses ?? []), ...(patch?.sourceWitnesses ?? []));
  }

  const previousDescriptor = recipe.descriptorRecipe.initialLogicalTarget;
  const applied = patches.length === 0
    ? { ok: true as const, source: previousDescriptor.toString('utf8') }
    : applySelectedXmlPatches(previousDescriptor.toString('utf8'), patches);
  if (!applied.ok) { return { diagnostic: diagnostic(applied.message, input.row.targetRoot.sourceId, input.row.id) }; }
  const materialized = materializeCapturedAdoptedTemplateBundle({
    recipe,
    mergedLogicalTarget: Buffer.from(applied.source, 'utf8'),
    candidateWitnesses,
  });
  if (!materialized.ok) { return { diagnostic: diagnostic(materialized.reason, incoming.sourceId, input.row.id) }; }

  if (materialized.bodyEffect) {
    const replacedBodyPaths = [
      ...(materialized.bodyWrite ? [materialized.bodyWrite.relativePath] : []),
      ...(materialized.deletePath ? [materialized.deletePath] : []),
    ];
    const selectedDcsBody = [...byPath].some(([candidatePath, candidateSelections]) =>
      replacedBodyPaths.some((bodyPath) => samePath(candidatePath, bodyPath))
        && candidateSelections.some((selection) => selection.kind === 'dcsXml'));
    if (selectedDcsBody) {
      return { diagnostic: diagnostic('Полную замену Template body нельзя объединить с точечными изменениями DCS в том же Template.xml.', incoming.sourceId, input.row.id) };
    }
  }

  const combined = combineWitnesses([...input.witnesses, ...materialized.requiredWitnesses]);
  if ('reason' in combined) { return { diagnostic: diagnostic(combined.reason, incoming.sourceId, input.row.id) }; }
  const revalidationReason = await revalidateCapturedWitnesses(input.row, combined.witnesses);
  if (revalidationReason) { return { diagnostic: diagnostic(revalidationReason, incoming.sourceId, input.row.id) }; }
  const writes: ExtensionSemanticWrite[] = [];
  if (materialized.descriptorContent) {
    writes.push({ relativePath, content: Buffer.from(materialized.descriptorContent), sourceWitnesses: combined.witnesses });
  }
  if (materialized.bodyWrite) {
    const indexedTargetHash = target.sidecarFiles.find((file) => samePath(file.relativePath, materialized.bodyWrite!.relativePath))?.hash
      ?? MISSING_TARGET_HASH;
    if (!sameHash(indexedTargetHash, materialized.bodyWrite.expectedTargetHash)) {
      return { diagnostic: diagnostic(`Индекс Template body цели расходится с захваченным состоянием назначения: ${materialized.bodyWrite.relativePath}.`, input.row.targetRoot.sourceId, input.row.id) };
    }
    writes.push({
      relativePath: materialized.bodyWrite.relativePath,
      content: Buffer.from(materialized.bodyWrite.content),
      sourceWitnesses: combined.witnesses,
    });
  }
  for (const [sideName, root, side] of [
    ['target body', input.row.targetRoot, recipe.targetBody],
    ['source body', input.row.incomingRoot, recipe.sourceBody],
    ['target destination body', input.row.targetRoot, recipe.targetDestinationBody],
  ] as const) {
    const indexedReason = validateIndexedPhysicalSide(root, sideName === 'source body' ? recipe.sourceDescriptor.witness.sourceId : recipe.targetDescriptor.witness.sourceId,
      sideName, side);
    if (indexedReason) { return { diagnostic: diagnostic(indexedReason, root.sourceId, input.row.id) }; }
  }
  for (const side of [recipe.targetBaseBody, recipe.sourceBaseBody]) {
    const indexedRoot = findRowRootBySource(input.row, side.witness.sourceId);
    if (!indexedRoot) {
      return { diagnostic: diagnostic(`Не найден захваченный base root для Template body ${side.witness.relativePath}.`, input.row.targetRoot.sourceId, input.row.id) };
    }
    const indexedReason = validateIndexedFile(indexedRoot, side.witness, side.content);
    if (indexedReason) { return { diagnostic: diagnostic(indexedReason, indexedRoot.sourceId, input.row.id) }; }
  }
  for (const [capture, sideRoot] of [
    [recipe.targetDescriptor, input.row.targetRoot],
    [recipe.sourceDescriptor, input.row.incomingRoot],
    [recipe.targetBaseDescriptor, findRowRootBySource(input.row, recipe.targetBaseDescriptor.witness.sourceId)],
    [recipe.sourceBaseDescriptor, findRowRootBySource(input.row, recipe.sourceBaseDescriptor.witness.sourceId)],
  ] as const) {
    if (!sideRoot) {
      return { diagnostic: diagnostic(`Не найден захваченный root для Template descriptor ${capture.witness.relativePath}.`, input.row.targetRoot.sourceId, input.row.id) };
    }
    const indexedReason = validateIndexedFile(sideRoot, capture.witness, capture.content);
    if (indexedReason) { return { diagnostic: diagnostic(indexedReason, sideRoot.sourceId, input.row.id) }; }
  }
  if (!materialized.changed) { return { writes: [], deletePaths: [], descriptorWitnesses: input.witnesses }; }
  for (const deletePath of materialized.deletePath ? [materialized.deletePath] : []) {
    const oldBody = recipe.targetBody;
    if (oldBody.kind !== 'file' || !samePath(oldBody.capture.witness.relativePath, deletePath)) {
      return { diagnostic: diagnostic(`Удаление старого Template body не подтверждено точным физическим захватом цели: ${deletePath}.`, input.row.targetRoot.sourceId, input.row.id) };
    }
    const indexedOldHash = target.sidecarFiles.find((file) => samePath(file.relativePath, deletePath))?.hash;
    if (!indexedOldHash || !sameHash(indexedOldHash, oldBody.capture.witness.expectedHash)) {
      return { diagnostic: diagnostic(`Хэш старого Template body расходится с захваченным индексом цели: ${deletePath}.`, input.row.targetRoot.sourceId, input.row.id) };
    }
  }
  const descriptorWrite = writes.find((write) => samePath(write.relativePath, targetDescriptorPath));
  return {
    writes,
    deletePaths: materialized.deletePath ? [materialized.deletePath] : [],
    ...(descriptorWrite && samePath(descriptorWrite.relativePath, input.targetDescriptorRelativePath)
      ? { descriptorContent: descriptorWrite.content } : {}),
    descriptorWitnesses: descriptorWrite?.sourceWitnesses ?? input.witnesses,
  };
}

async function buildAdoptedRightsPathWrite(
  input: Parameters<typeof buildSemanticObjectOutput>[0],
  relativePath: string,
  selections: readonly ExtensionSemanticSelection[],
): Promise<{
  readonly write?: ExtensionSemanticWrite;
  readonly recipe?: CapturedAdoptedRightsRecipe;
  readonly requiresRightsPropertyState: boolean;
  readonly requiredWitnesses: readonly MergeFileWitness[];
} | { readonly diagnostic: CompareMessage }> {
  const first = selections[0]! as AdoptedRightsSelection;
  const recipe = first.adoptedRights;
  const target = input.row.target;
  const incoming = input.row.incoming;
  if (!recipe || !target || !incoming || !target.descriptorRelativePath || !incoming.descriptorRelativePath
      || !target.descriptorContent || !incoming.descriptorContent) {
    return { diagnostic: diagnostic('Для adopted Rights merge отсутствуют role descriptors или captured recipe.', input.row.targetRoot.sourceId, input.row.id) };
  }
  if (selections.some((selection) => {
    const rights = (selection as AdoptedRightsSelection).adoptedRights;
    return !rights || rights !== recipe || selection.kind !== 'roleRightsXml'
      || selection.adoptedArtifact !== undefined
      || !samePath(selection.targetRelativePath, relativePath)
      || !samePath(selection.targetRelativePath, recipe.targetRightsRelativePath)
      || !samePath(selection.sourceRelativePath, recipe.sourceRightsRelativePath);
  })) {
    return { diagnostic: diagnostic('Выбранная adopted Rights группа содержит разные captures, identities или физические пути.', incoming.sourceId, input.row.id) };
  }
  if (!samePath(recipe.targetDescriptorRelativePath, target.descriptorRelativePath)
      || !samePath(recipe.sourceDescriptor.witness.relativePath, incoming.descriptorRelativePath)
      || !target.descriptorContent.equals(recipe.targetDescriptor.content)
      || !incoming.descriptorContent.equals(recipe.sourceDescriptor.content)) {
    return { diagnostic: diagnostic('Captured adopted Rights descriptors не совпадают с физическими target/source row captures.', incoming.sourceId, input.row.id) };
  }
  if (!sameHash(target.descriptorHash, recipe.targetDescriptor.witness.expectedHash)
      || !sameHash(incoming.descriptorHash, recipe.sourceDescriptor.witness.expectedHash)) {
    return { diagnostic: diagnostic('Captured adopted Rights descriptor hashes не совпадают с transfer row.', incoming.sourceId, input.row.id) };
  }

  const targetFilePath = path.resolve(input.targetRootPath, relativePath);
  const candidatePatches: XmlPatchPayload[] = [];
  const candidateWitnesses: MergeFileWitness[] = [];
  for (const selection of selections) {
    const factoryResult = await selection.candidateFactory();
    if (!factoryResult.ok) {
      return { diagnostic: diagnostic(factoryResult.diagnostics[0]?.suggestedAction ?? 'Выбранное Rights изменение больше недоступно.', incoming.sourceId, selection.nodeId) };
    }
    const candidate = factoryResult.candidate;
    const patch = candidate.xmlPatch;
    if (!patch || patch.semanticKind !== 'roleRightsXml' || candidate.targetUri !== pathToFileURL(targetFilePath).toString()) {
      return { diagnostic: diagnostic('Adopted Rights candidate не совпадает с выбранным target Rights.xml.', incoming.sourceId, selection.nodeId) };
    }
    const context = patch.semanticContext;
    const availableMetadataReferences = input.addedMetadataReferences?.length
      ? [...new Set([...(context?.availableMetadataReferences ?? []), ...input.addedMetadataReferences])]
      : context?.availableMetadataReferences;
    candidatePatches.push({
      ...patch,
      ...(availableMetadataReferences ? { semanticContext: { ...context, availableMetadataReferences } } : {}),
    });
    candidateWitnesses.push(...(selection.dependencyWitnesses ?? []), ...(patch.sourceWitnesses ?? []), ...(candidate.sourceWitnesses ?? []));
  }

  const normalizedCandidateWitnesses = normalizeCapturedAdoptedRightsWitnesses(recipe, candidateWitnesses);
  if (!normalizedCandidateWitnesses.ok) {
    return { diagnostic: diagnostic(normalizedCandidateWitnesses.reason, incoming.sourceId, input.row.id) };
  }
  const allWitnesses = combineWitnesses([...input.witnesses, ...recipe.requiredWitnesses, ...normalizedCandidateWitnesses.witnesses]);
  if ('reason' in allWitnesses) {return { diagnostic: diagnostic(allWitnesses.reason, incoming.sourceId, input.row.id) };}
  const requiredForPreview = combineWitnesses([...recipe.requiredWitnesses, ...normalizedCandidateWitnesses.witnesses]);
  if ('reason' in requiredForPreview) {return { diagnostic: diagnostic(requiredForPreview.reason, incoming.sourceId, input.row.id) };}
  const revalidationReason = await revalidateCapturedWitnesses(input.row, [...recipe.requiredWitnesses, ...normalizedCandidateWitnesses.witnesses]);
  if (revalidationReason) {return { diagnostic: diagnostic(revalidationReason, incoming.sourceId, input.row.id) };}

  const applied = applySelectedXmlPatches(recipe.initialLogicalTarget.toString('utf8'), candidatePatches);
  if (!applied.ok) {return { diagnostic: diagnostic(applied.message, input.row.targetRoot.sourceId, input.row.id) };}
  const materialized = materializeCapturedAdoptedRightsTarget({
    recipe,
    mergedLogicalTarget: Buffer.from(applied.source, 'utf8'),
    candidateWitnesses: normalizedCandidateWitnesses.witnesses,
  });
  if (!materialized.ok) {return { diagnostic: diagnostic(materialized.reason, incoming.sourceId, input.row.id) };}
  if (!materialized.changed) {
    return {
      recipe,
      requiresRightsPropertyState: false,
      requiredWitnesses: requiredForPreview.witnesses,
    };
  }
  if (!materialized.content) {return { diagnostic: diagnostic('Изменённый adopted Rights output не содержит физических bytes.', incoming.sourceId, input.row.id) };}
  return {
    write: {
      relativePath: recipe.targetRightsRelativePath,
      content: materialized.content,
      sourceWitnesses: allWitnesses.witnesses,
    },
    recipe,
    requiresRightsPropertyState: materialized.requiresRightsPropertyState,
    requiredWitnesses: requiredForPreview.witnesses,
  };
}

async function revalidateCapturedWitnesses(row: ExtensionTransferRow, witnesses: readonly MergeFileWitness[]): Promise<string | undefined> {
  const roots = [row.targetRoot, row.incomingRoot, row.targetBase, row.incomingBase].filter((root): root is NonNullable<typeof root> => Boolean(root));
  const rootBySource = new Map<string, string>();
  for (const root of roots) {
    const rootPath = root.canonicalRootPath ?? root.rootPath;
    const existing = rootBySource.get(root.sourceId);
    if (existing && path.resolve(existing) !== path.resolve(rootPath)) {
      return `Captured adopted Rights sourceId ${root.sourceId} names more than one filesystem root.`;
    }
    rootBySource.set(root.sourceId, rootPath);
  }
  for (const witness of witnesses) {
    if (witness.kind === 'directory') {continue;}
    const rootPath = rootBySource.get(witness.sourceId);
    if (!rootPath) {return `Не найден captured root для Rights dependency ${witness.sourceId}:${witness.relativePath}.`;}
    let snapshot;
    try {
      snapshot = await captureMergePath(path.resolve(rootPath, witness.relativePath), { retainContent: false });
    } catch (error) {
      return `Не удалось проверить captured Rights dependency ${witness.relativePath}: ${errorMessage(error)}`;
    }
    if (witness.expectedHash === MISSING_TARGET_HASH) {
      if (snapshot.state !== 'missing') {return `Ожидаемый отсутствующий Rights dependency появился или изменил состояние: ${witness.relativePath}`;}
    } else if (snapshot.state !== 'file' || !sameHash(snapshot.hash, witness.expectedHash)) {
      return `Captured Rights dependency изменился после compare: ${witness.relativePath}`;
    }
  }
  return undefined;
}

function addRightsExtendedState(xml: Buffer, formatVersion: string): { readonly changed: boolean; readonly content: Buffer } | { readonly reason: string } {
  try {
    const document = parseXmlDocument(xml.toString('utf8'));
    const versions = document.root.attributes.filter((attribute) => attribute.name === 'version');
    if (document.root.localName !== 'MetaDataObject' || namespaceUriForName(document.root) !== MD_CLASSES_NAMESPACE
        || versions.length !== 1 || versions[0]!.value !== formatVersion) {
      return { reason: 'Нельзя добавить Rights=Extended: descriptor root namespace или version не совпадает с captured Role.' };
    }
    const roleObjects = elementChildren(document.root).filter((element) => element.localName === 'Role');
    if (roleObjects.length !== 1 || namespaceUriForName(roleObjects[0]!) !== MD_CLASSES_NAMESPACE) {
      return { reason: 'Нельзя однозначно добавить Rights=Extended: Role descriptor malformed.' };
    }
    const role = roleObjects[0]!;
    const internalInfoNames = elementChildren(role).filter((element) => element.localName === 'InternalInfo');
    const internalInfos = internalInfoNames.filter((element) => namespaceUriForName(element) === MD_CLASSES_NAMESPACE);
    const properties = elementChildren(role).filter((element) => element.localName === 'Properties');
    if (internalInfos.length > 1 || properties.length !== 1 || namespaceUriForName(properties[0]!) !== MD_CLASSES_NAMESPACE) {
      return { reason: 'Нельзя однозначно добавить Rights=Extended: InternalInfo или Properties повторяется.' };
    }
    const internalInfo = internalInfos[0];
    if (internalInfo) {
      const state = findRightsState(internalInfo);
      if ('reason' in state) {return state;}
      if (state.value === 'Extended') {return { changed: false, content: Buffer.from(xml) };}
      if (state.value !== undefined) {return { reason: `Неизвестный Rights PropertyState=${state.value}; descriptor не изменён.` };}
    }
    const state = makeRightsPropertyState(role);
    let finalInternal: XmlElement;
    if (internalInfo) {
      internalInfo.children.push(state);
      state.parent = internalInfo;
      finalInternal = internalInfo;
    } else {
      const created = makeMetadataElement('InternalInfo', role);
      created.children.push(state);
      state.parent = created;
      const propertyIndex = role.children.indexOf(properties[0]!);
      role.children.splice(propertyIndex, 0, created);
      finalInternal = created;
    }
    const propertyIndex = role.children.indexOf(properties[0]!);
    const internalIndex = role.children.indexOf(finalInternal);
    if (internalIndex > propertyIndex) {
      role.children.splice(internalIndex, 1);
      role.children.splice(propertyIndex, 0, finalInternal);
    }
    return { changed: true, content: Buffer.from(serializeXmlDocument(document), 'utf8') };
  } catch (error) {
    return { reason: `Не удалось безопасно обновить Rights PropertyState: ${errorMessage(error)}` };
  }
}

function findRightsState(internalInfo: XmlElement): { readonly value?: string } | { readonly reason: string } {
  const states = elementChildren(internalInfo).filter((element) => element.localName === 'PropertyState');
  const rights: string[] = [];
  for (const state of states) {
    if (namespaceUriForName(state) !== 'http://v8.1c.ru/8.3/xcf/readable') {
      return { reason: 'PropertyState в Role descriptor находится в unsupported namespace.' };
    }
    const propertyNodes = elementChildren(state).filter((element) => element.localName === 'Property');
    const stateNodes = elementChildren(state).filter((element) => element.localName === 'State');
    if (propertyNodes.length !== 1 || stateNodes.length !== 1
        || namespaceUriForName(propertyNodes[0]!) !== 'http://v8.1c.ru/8.3/xcf/readable'
        || namespaceUriForName(stateNodes[0]!) !== 'http://v8.1c.ru/8.3/xcf/readable') {
      return { reason: 'PropertyState в Role descriptor malformed; Rights state неоднозначен.' };
    }
    if (textContent(propertyNodes[0]!).trim() === 'Rights') {rights.push(textContent(stateNodes[0]!).trim());}
  }
  if (rights.length > 1) {return { reason: 'Rights PropertyState повторяется в Role descriptor.' };}
  return { ...(rights.length ? { value: rights[0] } : {}) };
}

function makeRightsPropertyState(context: XmlElement): XmlElement {
  const prefix = 'xr';
  const namespaceAttribute = `xmlns:${prefix}`;
  const state = makeElement(`${prefix}:PropertyState`, context);
  if (namespaceUriForName(context, state.name) !== RIGHTS_STATE_NAMESPACE) {
    state.attributes.push({ name: namespaceAttribute, localName: prefix, value: RIGHTS_STATE_NAMESPACE, quote: '"' });
  }
  const property = makeElement(`${prefix}:Property`, state);
  const value = makeElement(`${prefix}:State`, state);
  property.children.push({ kind: 'text', text: 'Rights' });
  value.children.push({ kind: 'text', text: 'Extended' });
  property.parent = state;
  value.parent = state;
  state.children.push(property, value);
  return state;
}

function makeElement(name: string, context: XmlElement): XmlElement {
  return { kind: 'element', name, localName: name.slice(name.lastIndexOf(':') + 1), attributes: [], children: [], parent: context };
}

function makeMetadataElement(localName: string, context: XmlElement): XmlElement {
  if (namespaceUriForName(context, localName) === MD_CLASSES_NAMESPACE) { return makeElement(localName, context); }
  const prefix = prefixForNamespace(context, MD_CLASSES_NAMESPACE, 'md');
  return makeElement(`${prefix}:${localName}`, context);
}

function combineWitnesses(witnesses: readonly MergeFileWitness[]): { readonly witnesses: MergeFileWitness[] } | { readonly reason: string } {
  const byKey = new Map<string, MergeFileWitness>();
  for (const witness of witnesses) {
    if (!witness.sourceId.trim() || !witness.relativePath.trim() || !/^(?:sha256:)?(?:[\da-f]{64}|__missing__)$/iu.test(witness.expectedHash)) {
      return { reason: 'В selected adopted Rights candidate есть malformed raw witness.' };
    }
    const kind = witness.kind ?? 'file';
    if (kind !== 'file' && kind !== 'directory') {return { reason: 'В selected adopted Rights candidate указан unsupported witness kind.' };}
    const key = `${witness.sourceId}\0${normalizeWitnessPath(witness.relativePath)}\0${kind}`;
    const existing = byKey.get(key);
    if (existing && !sameHash(existing.expectedHash, witness.expectedHash)) {
      return { reason: `Conflicting raw witnesses for ${witness.sourceId}:${witness.relativePath}; conflicting hashes are rejected.` };
    }
    if (!existing) {byKey.set(key, { ...witness, kind });}
  }
  return { witnesses: [...byKey.values()] };
}

function samePath(left: string, right: string): boolean { return normalizeWitnessPath(left) === normalizeWitnessPath(right); }
function normalizeWitnessPath(value: string): string {
  const normalized = value.replace(/\\/gu, '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}
function validateTemplateRowBinding(row: ExtensionTransferRow, recipe: CapturedAdoptedTemplateBundle): string | undefined {
  if (!row.target || !row.incoming) { return 'Для adopted Template отсутствуют обе стороны выбранной transfer row.'; }
  if (recipe.metadataType === 'CommonTemplate') {
    if (row.target.metadataType !== 'CommonTemplate' || row.incoming.metadataType !== 'CommonTemplate'
        || !indexedObjectMatchesCapture(row.target, recipe.targetDescriptor)
        || !indexedObjectMatchesCapture(row.incoming, recipe.sourceDescriptor)) {
      return 'Root CommonTemplate captures не совпадают с точными target/source объектами transfer row.';
    }
    for (const baseDescriptor of [recipe.targetBaseDescriptor, recipe.sourceBaseDescriptor]) {
      const baseRoot = findRowRootBySource(row, baseDescriptor.witness.sourceId);
      if (!baseRoot || !baseRoot.objects.some((object) => indexedObjectMatchesCapture(object, baseDescriptor))) {
        return `Базовый CommonTemplate не совпадает с точным объектом захваченного root: ${baseDescriptor.witness.relativePath}.`;
      }
    }
    return undefined;
  }

  const owner = recipe.ownerProof;
  if (!owner || !indexedObjectMatchesCapture(row.target, owner.target)
      || !indexedObjectMatchesCapture(row.incoming, owner.source)) {
    return 'Nested Template owner captures не совпадают с точными target/source объектами transfer row.';
  }
  for (const baseOwner of [owner.targetBase, owner.sourceBase]) {
    const root = findRowRootBySource(row, baseOwner.witness.sourceId);
    if (!root || !root.objects.some((object) => indexedObjectMatchesCapture(object, baseOwner))) {
      return `Nested Template base owner не совпадает с captured root/index: ${baseOwner.witness.relativePath}.`;
    }
  }
  return undefined;
}

function indexedObjectMatchesCapture(object: ExtensionIndexedObject, capture: AdoptedSemanticArtifactCapture): boolean {
  const identity = object.identity;
  return object.sourceId === capture.witness.sourceId && object.metadataType === capture.identity.type
    && object.name === capture.identity.name && samePath(object.descriptorRelativePath ?? '', capture.witness.relativePath)
    && Boolean(object.descriptorContent?.equals(capture.content))
    && sameHash(object.descriptorHash, capture.witness.expectedHash)
    && identity?.ownership === capture.identity.ownership && identity.type === capture.identity.type
    && identity.name === capture.identity.name && identity.uuid.toLowerCase() === capture.identity.uuid.toLowerCase()
    && (identity.sourceUuid?.toLowerCase() ?? '') === (capture.identity.sourceUuid?.toLowerCase() ?? '')
    && samePath(identity.path, capture.witness.relativePath);
}

function findRowRootBySource(row: ExtensionTransferRow, sourceId: string): ExtensionMetadataIndex | undefined {
  const matches = [row.targetRoot, row.incomingRoot, row.targetBase, row.incomingBase]
    .filter((root): root is ExtensionMetadataIndex => root !== undefined && root.sourceId === sourceId);
  if (matches.length === 0) { return undefined; }
  const canonical = path.resolve(matches[0]!.canonicalRootPath ?? matches[0]!.rootPath);
  if (matches.some((root) => path.resolve(root.canonicalRootPath ?? root.rootPath) !== canonical)) { return undefined; }
  return matches[0];
}

function validateIndexedPhysicalSide(
  root: ExtensionMetadataIndex,
  expectedSourceId: string,
  label: string,
  side: CapturedAdoptedTemplatePhysicalSide,
): string | undefined {
  if (side.kind === 'file' && side.capture.witness.sourceId !== expectedSourceId) {
    return `Captured ${label} принадлежит другому sourceId.`;
  }
  const witness = side.kind === 'file' ? side.capture.witness : side.witness;
  if (witness.sourceId !== expectedSourceId) { return `Захваченный файл «${label}» относится к другому sourceId.`; }
  return validateIndexedFile(root, witness, side.kind === 'file' ? side.capture.content : undefined);
}

function validateIndexedFile(
  root: ExtensionMetadataIndex,
  witness: MergeFileWitness,
  content?: Buffer,
): string | undefined {
  if (root.sourceId !== witness.sourceId) { return `Захваченный файл ${witness.relativePath} привязан к другому корню метаданных.`; }
  const matches: Array<{ readonly hash: string; readonly content?: Buffer }> = [];
  for (const object of root.objects) {
    if (object.descriptorRelativePath && samePath(object.descriptorRelativePath, witness.relativePath)
        && object.descriptorHash) {
      matches.push({ hash: object.descriptorHash, ...(object.descriptorContent ? { content: object.descriptorContent } : {}) });
    }
    for (const file of object.sidecarFiles) {
      if (samePath(file.relativePath, witness.relativePath)) { matches.push(file); }
    }
  }
  const indexed = matches.length === 1 ? matches[0] : undefined;
  if (matches.length > 1) { return `Путь файла Template неоднозначен в выбранном индексе метаданных: ${witness.relativePath}.`; }
  const indexedHash = indexed?.hash ?? MISSING_TARGET_HASH;
  if (!sameHash(indexedHash, witness.expectedHash)) {
    return `Физическое состояние файла Template расходится с выбранным индексом метаданных: ${witness.relativePath}.`;
  }
  if (content && indexed?.content && !indexed.content.equals(content)) {
    return `Байты Template расходятся с выбранным индексом метаданных: ${witness.relativePath}.`;
  }
  if (content && !indexed?.content && witness.expectedHash === MISSING_TARGET_HASH) {
    return `Файл Template отсутствует в выбранном индексе метаданных: ${witness.relativePath}.`;
  }
  return undefined;
}

function sameAdoptedTemplateDescriptorArtifact(
  artifact: NonNullable<ExtensionSemanticSelection['adoptedArtifact']>,
  recipe: CapturedAdoptedTemplateBundle,
): boolean {
  const adopted = artifact.recipe;
  return artifact.kind === 'metadataXml' && adopted.kind === 'adopted-descriptor'
    && samePath(artifact.targetRelativePath, recipe.targetDescriptor.witness.relativePath)
    && samePath(artifact.sourceRelativePath, recipe.sourceDescriptor.witness.relativePath)
    && sameHash(artifact.targetHash, recipe.targetDescriptor.witness.expectedHash)
    && sameHash(artifact.sourceHash, recipe.sourceDescriptor.witness.expectedHash)
    && adopted.initialLogicalTarget.equals(recipe.descriptorRecipe.initialLogicalTarget)
    && adopted.initialLogicalSource.equals(recipe.descriptorRecipe.initialLogicalSource)
    && sameAdoptedCapture(adopted.target, recipe.targetDescriptor)
    && sameAdoptedCapture(adopted.source, recipe.sourceDescriptor)
    && sameAdoptedCapture(adopted.base, recipe.targetBaseDescriptor);
}
function sameAdoptedCapture(left: AdoptedSemanticArtifactCapture, right: AdoptedSemanticArtifactCapture): boolean {
  return left.content.equals(right.content) && left.witness.sourceId === right.witness.sourceId
    && samePath(left.witness.relativePath, right.witness.relativePath)
    && sameHash(left.witness.expectedHash, right.witness.expectedHash)
    && left.identity.ownership === right.identity.ownership && left.identity.type === right.identity.type
    && left.identity.name === right.identity.name && left.identity.uuid.toLowerCase() === right.identity.uuid.toLowerCase()
    && (left.identity.sourceUuid?.toLowerCase() ?? '') === (right.identity.sourceUuid?.toLowerCase() ?? '');
}
function sameHash(left: string | undefined, right: string): boolean {
  return Boolean(left && left.replace(/^sha256:/iu, '').toLowerCase() === right.replace(/^sha256:/iu, '').toLowerCase());
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
