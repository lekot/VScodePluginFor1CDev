import type { RootObjectConfigurationMutation } from '../services/configurationXmlUpdater';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { CompareMessage } from './domain/compareContracts';
import { MISSING_TARGET_HASH, type MergeCandidate, type MergeFileWitness } from './merge/mergePreview';
import { captureMergePath, mergeSnapshotHash } from './merge/mergeSnapshot';
import { assertNoSymlinkSegments, assertPathWithinRoot } from '../services/configurationSession/pathBoundary';
import { validateMergeFileWitnesses } from './merge/capturedFileWrite';
import { createCapturedWriteCandidate, materializePackageMembers, materializeRootConfigurationWrite } from './linkedDesignerPackageWrites';
import { composeBslCandidates } from './linkedDesignerBslMaterializer';
import { composeXmlCandidates } from './linkedDesignerXmlMaterializer';
import { validateFinalLinkedDesignerState } from './linkedDesignerValidation';
import { namespaceUriForName } from './adapters/semanticXml/semanticXmlIdentity';
import { blocked, LINKED_FORM_REFERENCE_PROPERTIES, normalizeAbsolutePath, normalizePath, stripHash, uniqueWitnesses } from './linkedDesignerUtils';
import { formXmlReferencesHandler } from './linkedDesignerContext';
import { materializeLinkedTemplateTypeTransition } from './linkedDesignerTemplateTransitions';
import { elementChildren, parseXmlDocument, textContent } from './xml/xmlDom';
import type { LinkedDesignerMaterializerContext, LinkedDesignerMaterializationResult, LinkedDesignerPackageRecipe } from './linkedDesignerTypes';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';

export { type LinkedDesignerKind, type LinkedDesignerPackageMember, type LinkedDesignerPackageRecipe, type LinkedDesignerFileWriteMember, type LinkedFormModuleSnapshot, type LinkedFormXmlSnapshot, type LinkedDefaultFormDependency, type LinkedDesignerRootConfigurationSnapshot, type LinkedDesignerCompareIndex, type LinkedDesignerMaterializerContext, type LinkedDesignerMaterializationResult } from './linkedDesignerTypes';
export { buildLinkedDesignerCompareIndex, bindLinkedDesignerPackageNodes } from './linkedDesignerPackageIndex';

/** Materializes linked packages and selected XML/BSL changes as captured writes per target file. */
export async function materializeLinkedDesignerSelection(
  input: LinkedDesignerMaterializerContext,
  nodeIds: readonly string[],
): Promise<LinkedDesignerMaterializationResult> {
  const diagnostics: CompareMessage[] = [];
  const selectedPackages = new Map<string, LinkedDesignerPackageRecipe>();
  const selectedCandidates: MergeCandidate[] = [];
  const rootMutations: RootObjectConfigurationMutation[] = [];
  const sourceRoots = new Set(input.session.state.sources.map((source) => source.sourceId));

  if (nodeIds.length === 0) {return { ok: false, diagnostics: [blocked('Выберите хотя бы одно поддерживаемое изменение.', input.sourceId)] };}
  for (const nodeId of nodeIds) {
    const templateTransition = input.templateTypeTransitionsByNodeId?.get(nodeId);
    if (templateTransition) {
      const factory = input.candidateFactories.get(nodeId);
      if (!factory) {
        diagnostics.push(blocked('TemplateType bundle не содержит captured XML candidate.', input.sourceId, nodeId));
        continue;
      }
      const scalar = await factory();
      if (!scalar.ok) {diagnostics.push(...scalar.diagnostics); continue;}
      const materialized = await materializeLinkedTemplateTypeTransition({
        context: input,
        binding: templateTransition,
        scalarCandidate: scalar.candidate,
      });
      if ('diagnostic' in materialized) {diagnostics.push(materialized.diagnostic);}
      else {selectedCandidates.push(...materialized.candidates);}
      continue;
    }
    const recipe = input.packagesByNodeId.get(nodeId);
    if (recipe) {
      if (recipe.action === 'delete' && !recipe.targetDirectoryWitness) {
        diagnostics.push(blocked('Удаляемый Designer-пакет не содержит witness каталога sidecar.', input.targetSourceId, nodeId));
        continue;
      }
      const existing = selectedPackages.get(recipe.packageId);
      if (existing && existing.action !== recipe.action) {
        diagnostics.push(blocked('Один Designer-пакет одновременно выбран для добавления и удаления.', input.sourceId, nodeId));
      }
      selectedPackages.set(recipe.packageId, recipe);
      if (recipe.rootRegistration) {
        rootMutations.push({ type: recipe.action === 'copy' ? 'add' : 'remove', ...recipe.rootRegistration });
        continue;
      }
      if (recipe.registrationNodeId && recipe.registrationNodeId !== nodeId) {
        const factory = input.candidateFactories.get(recipe.registrationNodeId);
        if (!factory) {
          diagnostics.push(blocked('Связанная регистрация недоступна в текущем compare snapshot.', input.sourceId, nodeId));
        } else {
          const registration = await factory();
          if (!registration.ok) {diagnostics.push(...registration.diagnostics);}
          else {selectedCandidates.push(registration.candidate);}
        }
      } else if (recipe.registrationNodeId) {
        const factory = input.candidateFactories.get(nodeId);
        if (!factory) {diagnostics.push(blocked('Узел регистрации не имеет host-side candidate.', input.sourceId, nodeId));}
        else {
          const registration = await factory();
          if (!registration.ok) {diagnostics.push(...registration.diagnostics);}
          else {selectedCandidates.push(registration.candidate);}
        }
      }
      continue;
    }

    const capturedFile = input.fileWritesByNodeId?.get(nodeId);
    if (capturedFile) {
      const candidate = await createCapturedWriteCandidate(input, {
        nodeId,
        targetRelativePath: capturedFile.targetRelativePath,
        expectedTargetHash: capturedFile.expectedTargetHash,
        sourceRelativePath: capturedFile.sourceRelativePath,
        sourceHash: capturedFile.sourceHash,
        content: capturedFile.content,
      });
      if ('diagnostic' in candidate) {diagnostics.push(candidate.diagnostic);}
      else {selectedCandidates.push(candidate);}
      continue;
    }

    const factory = input.candidateFactories.get(nodeId);
    if (!factory) {
      diagnostics.push(blocked('Выбранный узел отсутствует в текущем host-side сравнении.', input.sourceId, nodeId));
      continue;
    }
    const result = await factory();
    if (!result.ok) {diagnostics.push(...result.diagnostics);}
    else {selectedCandidates.push(result.candidate);}
  }
  if (diagnostics.length > 0) {return { ok: false, diagnostics };}

  for (let index = 0; index < selectedCandidates.length; index += 1) {
    const candidate = selectedCandidates[index]!;
    const witnesses: MergeFileWitness[] = [
      ...(input.defaultFormDependencies?.get(candidate.nodeId)?.targetWitnesses ?? []),
      ...(input.eventRoutineDependencies?.get(candidate.nodeId)?.targetWitnesses ?? []),
    ];
    const deletedRoutine = candidate.bslRoutine?.kind === 'deleteRoutine' ? candidate.bslRoutine.routine.normalizedName : undefined;
    if (deletedRoutine) {
      for (const form of input.formXmlSnapshots ?? []) {
        if (formXmlReferencesHandler(form.targetContent, deletedRoutine)) {
          witnesses.push({
            sourceId: input.targetSourceId,
            relativePath: form.targetRelativePath,
            expectedHash: form.targetHash,
            kind: 'file',
          });
        }
      }
    }
    if (witnesses.length > 0) {
      selectedCandidates[index] = {
        ...candidate,
        sourceWitnesses: uniqueWitnesses([...(candidate.sourceWitnesses ?? []), ...witnesses]),
      };
    }
  }

  const packageWrites: MergeCandidate[] = [];
  for (const recipe of selectedPackages.values()) {
    const memberResults = await materializePackageMembers(input, recipe);
    if ('diagnostic' in memberResults) {diagnostics.push(memberResults.diagnostic);continue;}
    packageWrites.push(...memberResults.candidates);
  }
  if (diagnostics.length > 0) {return { ok: false, diagnostics };}

  const deletedFormReferenceWitnesses = [...selectedPackages.values()]
    .filter((recipe) => recipe.action === 'delete' && recipe.kind === 'Form')
    .flatMap((recipe) => (input.formReferenceOwnerSnapshots ?? [])
      .filter((snapshot) => descriptorReferencesForm(snapshot.targetContent, snapshot.qualifiedName, recipe.qualifiedName))
      .map((snapshot) => ({
        sourceId: input.targetSourceId,
        relativePath: snapshot.targetRelativePath,
        expectedHash: snapshot.targetHash,
        kind: 'file' as const,
      })));

  if (rootMutations.length > 0) {
    const rootWrite = await materializeRootConfigurationWrite(input, rootMutations, [...selectedPackages.values()]);
    if ('diagnostic' in rootWrite) {return { ok: false, diagnostics: [rootWrite.diagnostic] };}
    packageWrites.push({
      ...rootWrite.candidate,
      fileWrite: rootWrite.candidate.fileWrite ? {
        ...rootWrite.candidate.fileWrite,
        witnesses: uniqueWitnesses([...rootWrite.candidate.fileWrite.witnesses, ...deletedFormReferenceWitnesses]),
      } : undefined,
    });
  }

  const deletionWitnessesByOwner = new Map<string, MergeFileWitness[]>();
  for (const recipe of selectedPackages.values()) {
    if (recipe.action !== 'delete' || recipe.rootRegistration || !recipe.ownerTargetRelativePath || !recipe.targetDirectoryWitness) {continue;}
    deletionWitnessesByOwner.set(recipe.ownerTargetRelativePath, [
      ...(deletionWitnessesByOwner.get(recipe.ownerTargetRelativePath) ?? []),
      recipe.targetDirectoryWitness,
      ...deletedFormReferenceWitnesses,
    ]);
  }
  const xmlResult = await composeXmlCandidates(input, selectedCandidates, deletionWitnessesByOwner);
  if ('diagnostics' in xmlResult) {return { ok: false, diagnostics: xmlResult.diagnostics};}
  const bslResult = await composeBslCandidates(input, selectedCandidates);
  if ('diagnostics' in bslResult) {return { ok: false, diagnostics: bslResult.diagnostics};}
  const deletionOwnerPaths = new Set([...deletionWitnessesByOwner.keys()].map((relativePath) =>
    normalizeAbsolutePath(path.join(input.targetRootPath, ...relativePath.replace(/\\/gu, '/').split('/')))
  ));
  const xmlCandidates = [
    ...selectedCandidates.filter((candidate) => candidate.xmlPatch && !deletionOwnerPaths.has(targetPathForXmlCandidate(candidate))),
    ...xmlResult.candidates.filter((candidate) => candidate.targetUri && deletionOwnerPaths.has(targetPathForCandidate(candidate))),
  ];
  const candidates = [
    ...packageWrites,
    ...xmlCandidates,
    ...bslResult.candidates,
    ...selectedCandidates.filter((candidate) => !candidate.xmlPatch && !candidate.bslRoutine && candidate.kind !== 'bslLogicalRoutineMerge'),
  ];

  const linkedStateDiagnostics = await validateFinalLinkedDesignerState(input, selectedPackages, selectedCandidates, bslResult.outputs, xmlResult.outputs);
  if (linkedStateDiagnostics.length > 0) {return { ok: false, diagnostics: linkedStateDiagnostics};}

  for (const candidate of candidates) {
    for (const witness of candidate.sourceWitnesses ?? []) {
      if (!sourceRoots.has(witness.sourceId)) {
        return { ok: false, diagnostics: [blocked('Linked Designer candidate содержит witness вне текущей compare session.', witness.sourceId, candidate.nodeId)] };
      }
    }
    if (candidate.fileWrite) {
      for (const witness of candidate.fileWrite.witnesses) {
        if (!sourceRoots.has(witness.sourceId)) {
          return { ok: false, diagnostics: [blocked('Captured Designer write содержит witness вне текущей compare session.', witness.sourceId, candidate.nodeId)] };
        }
      }
    }
  }
  const witnessDiagnostics = await verifyLinkedCandidateWitnesses(input, candidates);
  if (witnessDiagnostics.length > 0) {return { ok: false, diagnostics: witnessDiagnostics};}
  return { ok: true, candidates };
}

async function verifyLinkedCandidateWitnesses(
  input: LinkedDesignerMaterializerContext,
  candidates: readonly MergeCandidate[],
): Promise<CompareMessage[]> {
  const roots = new Map([
    [input.targetSourceId, input.targetRootPath],
    [input.sourceId, input.sourceRootPath],
  ]);
  const sourceIds = new Set(input.session.state.sources.map((source) => source.sourceId));
  for (const candidate of candidates) {
    const witnesses = [
      ...(candidate.sourceWitnesses ?? []),
      ...(candidate.xmlPatch?.sourceWitnesses ?? []),
      ...(candidate.fileWrite?.witnesses ?? []),
    ];
    if (witnesses.length === 0) {continue;}
    const validation = validateMergeFileWitnesses(witnesses, sourceIds);
    if (validation.length > 0) {
      return [blocked(`Невозможно проверить связанные файлы перед preview: ${validation[0]}`, input.sourceId, candidate.nodeId)];
    }
    const unique = new Map<string, MergeFileWitness>();
    for (const witness of witnesses) {
      unique.set(`${witness.sourceId}\0${normalizePath(witness.relativePath)}`, witness);
    }
    for (const witness of unique.values()) {
      const root = roots.get(witness.sourceId);
      if (!root) {
        return [blocked('Связанный файл относится к источнику вне текущего Designer compare.', witness.sourceId, candidate.nodeId)];
      }
      try {
        const absolute = path.resolve(root, ...witness.relativePath.split(/[\\/]/u));
        const bounded = await assertPathWithinRoot(root, absolute);
        await assertNoSymlinkSegments(bounded.canonicalRoot, bounded.canonicalTarget);
        const snapshot = await captureMergePath(bounded.canonicalTarget, { retainContent: false });
        const actualHash = snapshot.state === 'missing' ? MISSING_TARGET_HASH : mergeSnapshotHash(snapshot);
        if (actualHash !== stripHash(witness.expectedHash)
          || (snapshot.state !== 'missing' && (witness.kind ?? 'file') !== snapshot.type)) {
          return [blocked(`Связанный файл ${witness.relativePath} изменился после сравнения. Повторите сравнение.`, witness.sourceId, candidate.nodeId)];
        }
      } catch {
        return [blocked(`Связанный файл ${witness.relativePath} нельзя безопасно проверить перед preview.`, witness.sourceId, candidate.nodeId)];
      }
    }
  }
  return [];
}

function targetPathForXmlCandidate(candidate: MergeCandidate): string {
  const value = candidate.xmlPatch?.target.filePath ?? '';
  try {return normalizeAbsolutePath(fileURLToPath(value));}
  catch {return normalizeAbsolutePath(value);}
}

function targetPathForCandidate(candidate: MergeCandidate): string {
  const value = candidate.targetUri ?? '';
  try {return normalizeAbsolutePath(fileURLToPath(value));}
  catch {return normalizeAbsolutePath(value);}
}

function descriptorReferencesForm(xml: string, ownerName: string, formName: string): boolean {
  try {
    const root = parseXmlDocument(xml).root;
    if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MDCLASSES_NAMESPACE) {return false;}
    const owners = elementChildren(root);
    if (owners.length !== 1 || namespaceUriForName(owners[0]!) !== MDCLASSES_NAMESPACE) {return false;}
    const owner = owners[0]!;
    const ownerNamespace = namespaceUriForName(owner);
    const properties = elementChildren(owner).filter((element) =>
      element.localName === 'Properties' && namespaceUriForName(element) === ownerNamespace
    );
    if (properties.length !== 1) {return false;}
    return elementChildren(properties[0]!).some((element) =>
      LINKED_FORM_REFERENCE_PROPERTIES.includes(element.localName as typeof LINKED_FORM_REFERENCE_PROPERTIES[number])
      && namespaceUriForName(element) === ownerNamespace
      && resolveFormReference(textContent(element).trim(), ownerName) === canonicalName(formName)
    );
  } catch {
    return false;
  }
}

function resolveFormReference(value: string, ownerName: string): string {
  return canonicalName(value.includes('.') ? value : `${ownerName}.Form.${value}`);
}

function canonicalName(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}
