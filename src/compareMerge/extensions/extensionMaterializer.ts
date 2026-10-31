import * as path from 'path';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
import { throwIfCompareCancelled } from '../compareCancellation';
import { buildBorrowedObjectShellFromSource } from '../../extensionSupport/cfeProject/borrowObjectBuilder';
import { buildRootObjectConfigurationContent, type RootObjectConfigurationMutation } from '../../services/configurationXmlUpdater';
import { CONFIGURATION_XML } from '../../constants/fileNames';
import type { CompareMessage } from '../domain/compareContracts';
import type { ExtensionCapturedFile, ExtensionIndexedObject, ExtensionMetadataIndex } from './extensionMetadataIndex';
import type { ExtensionMaterializerInput, ExtensionMaterializerResult, ExtensionSemanticSelection, ExtensionTransferRow } from './extensionTransfer';
import { captureMergePath, mergeSnapshotHash, type MergePathSnapshot } from '../merge/mergeSnapshot';
import { MISSING_TARGET_HASH, type FileOperationPayload, type MergeCandidate, type MergeFileWitness } from '../merge/mergePreview';
import { overlaySimpleProperties, replaceRootUuid } from './extensionXmlOverlay';
import { buildSemanticObjectOutput } from './extensionSemanticMaterializer';
import { buildRootPurposeConfigurationOutput } from './extensionRootPurposeMaterializer';
import { createCapturedExtensionWriteCandidate } from './extensionCapturedWriteBuilder';
import { hydrateSelectedObjectSidecars, outputPathCollision } from './extensionMaterializerSupport';
import { scanExtensionXmlDependencies, type ExtensionMetadataReference } from './extensionDependencyScanner';
import { unsupportedExtensionInterceptReason } from './extensionInterceptScanner';
import { materializeExtensionLinkedDesignerPackages } from './extensionLinkedDesignerPackageWrites';
import { materializeExtensionLinkedTemplateTransition } from './extensionLinkedTemplateTransitions';
import { composeBslCandidates } from '../linkedDesignerBslMaterializer';
import { makeExtensionLinkedBslContext } from './extensionLinkedDesignerBsl';
import { validateDeletedExtensionFormReferences } from './extensionLinkedDesignerValidation';
import { addRecorderWitnesses, buildRecorderPreflight } from './extensionRecorderPreflight';
import { adoptedRoleRightsWholeTransferBlocker, sameExtensionRelativePath } from './extensionRoleRightsWholeTransferPolicy';
import { matchesCapturedAdoptedOwnFormSelection } from './extensionAdoptedOwnFormHost';
import { selectedAdoptedRightsReference, selectedOutputDeclaresCfeObject } from './extensionSelectedOutputDependencies';
import type { ExtensionObjectOutput, ExtensionOutputWrite } from './extensionMaterializerTypes';

const LEFT_SOURCE_ID = 'left-source';
const RIGHT_SOURCE_ID = 'right-source';
export async function materializeExtensionSelection(
  input: ExtensionMaterializerInput,
  nodeIds: readonly string[],
): Promise<ExtensionMaterializerResult> {
  const diagnostics: CompareMessage[] = [];
  if (nodeIds.length === 0) {
    return { ok: false, diagnostics: [compareDiagnostic('Выберите хотя бы один поддерживаемый объект.', RIGHT_SOURCE_ID)] };
  }
  const rowById = new Map(input.rows.map((row) => [row.id, row]));
  const selectedRowIds = new Set<string>();
  const wholeTransferRowIds = new Set<string>();
  const selectedSemantic = new Map<string, ExtensionSemanticSelection[]>();
  const selectedRoutineIds = new Set<string>();
  const selectedRoutineSelections: import('./extensionLinkedDesignerBsl').ExtensionLinkedRoutineSelection[] = [];
  const rootPurposeSelected = input.rootPurposeSelection !== undefined && nodeIds.includes(input.rootPurposeSelection.nodeId);
  for (const nodeId of nodeIds) {
    if (rootPurposeSelected && nodeId === input.rootPurposeSelection!.nodeId) {continue;}
    const row = rowById.get(nodeId);
    if (row) {
      wholeTransferRowIds.add(row.id);
      selectedRowIds.add(row.id);
      continue;
    }
    const routineSelection = input.linkedRoutineSelections?.get(nodeId);
    if (routineSelection) {
      const parent = rowById.get(routineSelection.rowId);
      if (!parent || routineSelection.nodeId !== nodeId) {
        diagnostics.push(compareDiagnostic('Выбранная процедура формы отсутствует в текущем linked compare snapshot.', RIGHT_SOURCE_ID, nodeId));
        continue;
      }
      selectedRoutineIds.add(nodeId);
      selectedRoutineSelections.push(routineSelection);
      selectedRowIds.add(parent.id);
      continue;
    }
    const selection = input.semanticSelections?.get(nodeId);
    const parent = selection ? rowById.get(selection.rowId) : undefined;
    if (!selection || !parent || selection.nodeId !== nodeId) {
      diagnostics.push(compareDiagnostic('Выбранный узел отсутствует в текущем семантическом сравнении.', RIGHT_SOURCE_ID, nodeId));
      continue;
    }
    const parentSelections = selectedSemantic.get(parent.id) ?? [];
    parentSelections.push(selection);
    selectedSemantic.set(parent.id, parentSelections);
    selectedRowIds.add(parent.id);
  }
  for (const rowId of wholeTransferRowIds) {
    const row = rowById.get(rowId);
    const blockedRights = row ? adoptedRoleRightsWholeTransferBlocker(row) : undefined;
    if (blockedRights) {
      const structureReason = blockedRights.rootConfirmed
        ? `Файл Rights.xml (${blockedRights.relativePath}) нельзя переносить без преобразования прав относительно базовой роли.`
        : `Структура файла Rights.xml (${blockedRights.relativePath}) не подтверждена; полный перенос запрещён, чтобы не скопировать права без преобразования относительно базовой роли.`;
      diagnostics.push(compareDiagnostic(
        `Полный перенос заимствованной роли «${blockedRights.qualifiedName}» заблокирован: ${structureReason} Выберите отдельные поддерживаемые изменения роли.`,
        blockedRights.sourceId,
        rowId,
      ));
    }
  }
  for (const selection of selectedRoutineSelections) {
    if (wholeTransferRowIds.has(selection.rowId)) {
      diagnostics.push(compareDiagnostic('Нельзя одновременно выбрать полный перенос объекта и отдельный обработчик формы.', RIGHT_SOURCE_ID, selection.nodeId));
    }
  }
  const selectedLinkedPackageIds = new Set([...selectedSemantic.values()].flat().map((selection) => selection.linkedPackageId).filter((value): value is string => Boolean(value)));
  for (const selection of [...selectedSemantic.values()].flat()) {
    if (selection.requiredPackageId && !selectedLinkedPackageIds.has(selection.requiredPackageId)) {
      diagnostics.push(compareDiagnostic('Изменение ссылки на форму требует выбрать linked Form-пакет регистрации.', RIGHT_SOURCE_ID, selection.nodeId));
    }
    const eventDependency = input.linkedEventDependencies?.get(selection.nodeId);
    if (eventDependency && !eventDependency.targetHasHandler
        && (!eventDependency.incomingRoutineNodeId || !selectedRoutineIds.has(eventDependency.incomingRoutineNodeId))) {
      diagnostics.push(compareDiagnostic(`Событие ссылается на ${eventDependency.handlerName}; выберите связанный BSL-обработчик.`, RIGHT_SOURCE_ID, selection.nodeId));
    }
  }
  for (const [rowId] of selectedSemantic) {
    const row = rowById.get(rowId);
    const rowSelections = selectedSemantic.get(rowId) ?? [];
    const adoptedOverlayAction = row?.action === 'overlay-adopted' || row?.action === 'adopted-to-cf-overlay';
    const adoptedSemanticAction = row?.semanticAction === 'overlay-adopted' || row?.semanticAction === 'adopted-to-cf-overlay';
    const adoptedArtifactsMatch = rowSelections.length > 0 && rowSelections.every((selection) => {
      const artifact = selection.adoptedArtifact;
      if (selection.kind !== 'metadataXml' && selection.kind !== 'formXml') {
        return artifact === undefined
          && (selection.kind === 'predefinedXml' || selection.kind === 'roleRightsXml' || selection.kind === 'dcsXml');
      }
      if (selection.kind === 'formXml' && matchesCapturedAdoptedOwnFormSelection(row!, selection)) {
        return artifact === undefined;
      }
      return artifact !== undefined
        && artifact.kind === selection.kind
        && sameExtensionRelativePath(artifact.targetRelativePath, selection.targetRelativePath)
        && sameExtensionRelativePath(artifact.sourceRelativePath, selection.sourceRelativePath)
        && artifact.targetHash === selection.targetHash
        && artifact.sourceHash === selection.sourceHash;
    });
    if (wholeTransferRowIds.has(rowId)) {
      diagnostics.push(compareDiagnostic('Нельзя одновременно выбрать полный перенос объекта и отдельные XML-изменения. Снимите один из вариантов.', RIGHT_SOURCE_ID, rowId));
    }
    const ordinarySemanticAction = Boolean(row?.mergeable && row.action
      && (row.action === 'full-copy' || row.action === 'adopted-cfe-copy'));
    const adoptedSemanticAllowed = Boolean(adoptedOverlayAction || adoptedSemanticAction) && adoptedArtifactsMatch;
    if (!row?.incoming || !row.target || !(ordinarySemanticAction || adoptedSemanticAllowed)) {
      diagnostics.push(compareDiagnostic('Семантическое XML-слияние доступно только для сопоставленных собственных объектов и adopted объектов CFE с подтверждённой базой.', RIGHT_SOURCE_ID, rowId));
    }
  }
  const requestedRows = [...selectedRowIds].map((rowId) => rowById.get(rowId));
  for (const row of requestedRows) {
    if (row && selectedSemantic.has(row.id)) {
      if (!row.incoming || !row.target) {
        diagnostics.push(compareDiagnostic(row.reason ?? 'Сопоставленный объект отсутствует в semantic compare snapshot.', RIGHT_SOURCE_ID, row.id));
      }
      continue;
    }
    if (!row?.mergeable || !row.action || !row.incoming) {
      diagnostics.push(compareDiagnostic(row?.reason ?? 'Объект нельзя безопасно перенести.', RIGHT_SOURCE_ID, row?.id));
    }
  }
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const selected: ExtensionTransferRow[] = [];
  for (const row of requestedRows as ExtensionTransferRow[]) {
    throwIfCompareCancelled(input.cancellation);
    const hydrated = await hydrateSelectedObjectSidecars(input.incoming, row, input.cancellation);
    if ('diagnostic' in hydrated) {diagnostics.push(hydrated.diagnostic);}
    else {selected.push(hydrated);}
  }
  if (diagnostics.length > 0) {return { ok: false, diagnostics };}

  const addedMetadataReferences = selected
    .filter((row) => !row.target && row.action === 'full-copy' && row.incoming)
    .map((row) => row.incoming!.qualifiedName);

  for (const row of selected) {
    if (row.action !== 'adopted-cfe-copy') {continue;}
    for (const file of row.incoming!.sidecarFiles) {
      if (path.extname(file.relativePath).toLowerCase() !== '.bsl') {continue;}
      if (!file.content) {
        diagnostics.push(compareDiagnostic(`Не удалось захватить BSL sidecar для проверки перехватов: ${file.relativePath}`, row.incoming!.sourceId, row.id));
        continue;
      }
      const reason = unsupportedExtensionInterceptReason(file.content);
      if (reason) {
        diagnostics.push(compareDiagnostic(`${reason} Файл: ${file.relativePath}`, row.incoming!.sourceId, row.id));
      }
    }
  }
  if (diagnostics.length > 0) {return { ok: false, diagnostics };}

  const outputs: ExtensionObjectOutput[] = [];
  for (const row of selected) {
    if (!wholeTransferRowIds.has(row.id) && !selectedSemantic.has(row.id)) {continue;}
    const output = await buildObjectOutput(input, row, selectedSemantic.get(row.id), addedMetadataReferences);
    if ('diagnostic' in output) {
      diagnostics.push(output.diagnostic);
      continue;
    }
    outputs.push(output);
  }
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const recorderPreflight = buildRecorderPreflight(outputs, input, compareDiagnostic);
  diagnostics.push(...recorderPreflight.diagnostics);
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  for (const blocker of recorderPreflight.result.blockers) {
    const output = outputs.find((candidate) => candidate.row.incoming?.qualifiedName === blocker.registerQualifiedName);
    diagnostics.push(compareDiagnostic(
      blocker.message,
      output?.row.incoming?.sourceId ?? RIGHT_SOURCE_ID,
      output?.row.id,
    ));
  }
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  const outputsWithRecorderWitnesses = addRecorderWitnesses(outputs, recorderPreflight.result.witnessesByRegister);

  const collision = outputPathCollision(outputsWithRecorderWitnesses);
  if (collision) {
    return { ok: false, diagnostics: [compareDiagnostic(collision, RIGHT_SOURCE_ID)] };
  }

  const dependencyResult = validateSelectedOutputDependencies(outputsWithRecorderWitnesses, input, selectedSemantic);
  if (dependencyResult.diagnostics.length > 0) {
    return { ok: false, diagnostics: [...dependencyResult.diagnostics] };
  }
  const outputsWithDependencyWitnesses = dependencyResult.outputs;

  const linkedReferenceDiagnostics = validateDeletedExtensionFormReferences({
    target: input.target,
    rows: input.rows,
    packages: input.linkedDesignerPackages ?? new Map(),
    outputs: outputsWithDependencyWitnesses,
    selectedSemantic,
  });
  if (linkedReferenceDiagnostics.length > 0) {
    return { ok: false, diagnostics: linkedReferenceDiagnostics };
  }

  const registrationMutations = outputsWithDependencyWitnesses.flatMap((output) => output.addRegistration ? [output.addRegistration] : []);
  const candidates: MergeCandidate[] = [];
  const sourceRootById = new Map<string, ExtensionMetadataIndex>([
    [input.target.sourceId, input.target],
    [input.incoming.sourceId, input.incoming],
  ]);
  for (const row of selected) {
    if (row.targetBase) {
      sourceRootById.set(row.targetBase.sourceId, row.targetBase);
    }
    if (row.incomingBase) {
      sourceRootById.set(row.incomingBase.sourceId, row.incomingBase);
    }
  }

  for (const output of outputsWithDependencyWitnesses) {
    for (const write of output.writes) {
      const candidate = await createCapturedExtensionWriteCandidate(input, output.row, write, sourceRootById);
      if ('diagnostic' in candidate) {
        diagnostics.push(candidate.diagnostic);
      } else {
        candidates.push(candidate);
      }
    }
    for (const deletePath of output.deletePaths) {
      const candidate = await createFileDeleteCandidate(input, output, deletePath, sourceRootById);
      if ('diagnostic' in candidate) {
        diagnostics.push(candidate.diagnostic);
      } else {
        candidates.push(candidate);
      }
    }
  }
  if (selectedRoutineSelections.length > 0) {
    const linkedContext = makeExtensionLinkedBslContext({
      targetRootPath: input.target.canonicalRootPath ?? input.target.rootPath,
      sourceRootPath: input.incoming.canonicalRootPath ?? input.incoming.rootPath,
      targetSourceId: input.target.sourceId,
      sourceId: input.incoming.sourceId,
      rightSnapshotId: input.rightSnapshotId,
      session: input.session,
    }, input.linkedFormModules ?? []);
    const routineCandidates: MergeCandidate[] = [];
    for (const selection of selectedRoutineSelections) {
      const result = await selection.candidateFactory();
      if (!result.ok) {diagnostics.push(...result.diagnostics);}
      else {routineCandidates.push(result.candidate);}
    }
    if (diagnostics.length === 0) {
      const composed = await composeBslCandidates(linkedContext, routineCandidates);
      if ('diagnostics' in composed) {diagnostics.push(...composed.diagnostics);}
      else {candidates.push(...composed.candidates);}
    }
  }
  if (registrationMutations.length > 0 || rootPurposeSelected) {
    const built = registrationMutations.length > 0
      ? buildRegistrationOutput(input.target, registrationMutations)
      : input.target.configurationContent ? { content: input.target.configurationContent } : { diagnostic: compareDiagnostic('Целевой Configuration.xml отсутствует.', input.target.sourceId) };
    if ('diagnostic' in built) {
      diagnostics.push(built.diagnostic);
    } else {
      let content = built.content;
      let sourceWitnesses = selected.flatMap((row) => objectWitnesses(row));
      if (rootPurposeSelected && input.rootPurposeSelection) {
        const rootPurpose = await buildRootPurposeConfigurationOutput({
          target: input.target,
          incoming: input.incoming,
          targetContent: content,
          selectedAdditions: addedMetadataReferences,
          selection: input.rootPurposeSelection,
        });
        if ('diagnostic' in rootPurpose) {
          diagnostics.push(rootPurpose.diagnostic);
        } else {
          content = rootPurpose.content;
          sourceWitnesses = [...sourceWitnesses, ...rootPurpose.sourceWitnesses];
        }
      }
      if (diagnostics.length === 0) {
  const output: ExtensionObjectOutput = {
          row: selected[0] ?? rootPurposeRow(input),
          outputRelativePaths: [CONFIGURATION_XML],
          writes: [{ relativePath: CONFIGURATION_XML, content, sourceWitnesses: dedupeWitnesses(sourceWitnesses) }],
          deletePaths: [],
          addRegistration: undefined,
        };
        const candidate = await createCapturedExtensionWriteCandidate(input, output.row, output.writes[0]!, sourceRootById, true);
        if ('diagnostic' in candidate) {
          diagnostics.push(candidate.diagnostic);
        } else {
          candidates.push(candidate);
        }
      }
    }
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  const witnessResult = await verifyCandidateWitnesses(candidates, sourceRootById);
  if (witnessResult.length > 0) {
    return { ok: false, diagnostics: witnessResult };
  }
  return { ok: true, candidates };
}

function validateSelectedOutputDependencies(
  outputs: readonly ExtensionObjectOutput[],
  input: ExtensionMaterializerInput,
  selectedSemantic: ReadonlyMap<string, readonly ExtensionSemanticSelection[]>,
): { readonly outputs: readonly ExtensionObjectOutput[]; readonly diagnostics: readonly CompareMessage[] } {
  const artifacts = outputs.flatMap((output) => output.writes
    .filter((write) => path.extname(write.relativePath).toLowerCase() === '.xml')
    .map((write) => ({ relativePath: write.relativePath, content: write.content })));
  const scanned = scanExtensionXmlDependencies(artifacts);
  const diagnostics: CompareMessage[] = [];
  const artifactOwners = new Map(outputs.flatMap((output) => output.writes
    .filter((write) => path.extname(write.relativePath).toLowerCase() === '.xml')
    .map((write) => [write.relativePath, output] as const)));
  const witnessesByWrite = new Map<string, MergeFileWitness[]>();

  for (const error of scanned.errors) {
    const owner = artifactOwners.get(error.artifactPath);
    diagnostics.push(compareDiagnostic(
      `Не удалось безопасно проверить metadata dependencies в ${error.artifactPath}: ${error.message}`,
      owner?.row.incoming?.sourceId ?? RIGHT_SOURCE_ID,
      owner?.row.id,
    ));
  }
  if (diagnostics.length > 0) {
    return { outputs, diagnostics };
  }

  const selectedOutputsByName = new Map<string, ExtensionObjectOutput[]>();
  for (const output of outputs) {
    const qualifiedName = output.row.incoming?.qualifiedName;
    if (!qualifiedName) {continue;}
    const key = dependencyKey(qualifiedName);
    const matches = selectedOutputsByName.get(key) ?? [];
    matches.push(output);
    selectedOutputsByName.set(key, matches);
  }
  const provenTargetBases = new Map<string, ExtensionMetadataIndex>();
  for (const output of outputs) {
    const base = output.row.targetBase;
    if (base) {provenTargetBases.set(base.sourceId, base);}
  }

  for (const reference of scanned.references) {
    const owner = artifactOwners.get(reference.artifactPath);
    if (!owner) {
      diagnostics.push(compareDiagnostic(`Metadata dependency artifact отсутствует в выбранном output: ${reference.artifactPath}`, RIGHT_SOURCE_ID));
      continue;
    }
    if (reference.metadataType === 'Configuration') {
      const targetResolution = resolveConfigurationDependencyInIndex(input.target, reference);
      if (targetResolution.kind === 'found') {
        addConfigurationDependencyWitness(witnessesByWrite, owner, reference, targetResolution.root, diagnostics);
        continue;
      }
      if (targetResolution.kind === 'invalid') {
        diagnostics.push(compareDiagnostic(targetResolution.reason, owner.row.incoming?.sourceId ?? RIGHT_SOURCE_ID, owner.row.id));
        continue;
      }

      const matchingBases: ExtensionMetadataIndex[] = [];
      let invalidBaseReason: string | undefined;
      for (const base of provenTargetBases.values()) {
        const baseResolution = resolveConfigurationDependencyInIndex(base, reference);
        if (baseResolution.kind === 'invalid') {
          invalidBaseReason = baseResolution.reason;
          break;
        }
        if (baseResolution.kind === 'found') {matchingBases.push(baseResolution.root);}
      }
      if (invalidBaseReason) {
        diagnostics.push(compareDiagnostic(invalidBaseReason, owner.row.incoming?.sourceId ?? RIGHT_SOURCE_ID, owner.row.id));
        continue;
      }
      if (matchingBases.length === 1) {
        addConfigurationDependencyWitness(witnessesByWrite, owner, reference, matchingBases[0]!, diagnostics);
        continue;
      }
      if (matchingBases.length > 1) {
        diagnostics.push(compareDiagnostic(
          `Ссылка ${reference.qualifiedName} неоднозначна: имя Configuration.Properties.Name совпадает в нескольких доказанных base.`,
          owner.row.incoming?.sourceId ?? RIGHT_SOURCE_ID,
          owner.row.id,
        ));
        continue;
      }
      diagnostics.push(compareDiagnostic(
        `Ссылка ${reference.qualifiedName} из ${reference.artifactPath} отсутствует в target, доказанной base и выбранном пакете. Зависимости автоматически не копируются.`,
        owner.row.incoming?.sourceId ?? RIGHT_SOURCE_ID,
        owner.row.id,
      ));
      continue;
    }

    const selectedMatches = selectedOutputsByName.get(dependencyKey(reference.qualifiedName)) ?? [];
    if (input.target.rootKind === 'cfe'
        && reference.metadataType !== 'Configuration'
        && selectedAdoptedRightsReference(owner, reference, selectedSemantic, dependencyKey)) {
      const targetResolution = resolveDependencyInIndex(input.target, reference);
      if (targetResolution.kind === 'ambiguous' || targetResolution.kind === 'invalid') {
        diagnostics.push(compareDiagnostic(targetResolution.reason, owner.row.incoming?.sourceId ?? RIGHT_SOURCE_ID, owner.row.id));
        continue;
      }
      if (targetResolution.kind === 'found') {
        addDependencyDescriptorWitness(witnessesByWrite, owner, reference, targetResolution.object, diagnostics);
        continue;
      }
      const declaringOutputs = selectedMatches.filter((output) => selectedOutputDeclaresCfeObject(output, reference, dependencyKey));
      if (declaringOutputs.length === 1) {continue;}
      diagnostics.push(compareDiagnostic(
        declaringOutputs.length > 1
          ? `Выбранные outputs неоднозначно объявляют физический CFE object ${reference.qualifiedName}.`
          : `Выбранное изменение Rights ссылается на ${reference.qualifiedName}, но этот object не объявлен физически в target CFE и не добавляется выбранным проверенным output. Запись только в base недостаточна.`,
        owner.row.incoming?.sourceId ?? RIGHT_SOURCE_ID,
        owner.row.id,
      ));
      continue;
    }
    if (selectedMatches.length === 1) {continue;}
    if (selectedMatches.length > 1) {
      diagnostics.push(compareDiagnostic(`Выбранный пакет содержит несколько outputs для ${reference.qualifiedName}.`, owner.row.incoming?.sourceId ?? RIGHT_SOURCE_ID, owner.row.id));
      continue;
    }

    const targetResolution = resolveDependencyInIndex(input.target, reference);
    if (targetResolution.kind === 'ambiguous' || targetResolution.kind === 'invalid') {
      diagnostics.push(compareDiagnostic(targetResolution.reason, owner.row.incoming?.sourceId ?? RIGHT_SOURCE_ID, owner.row.id));
      continue;
    }
    if (targetResolution.kind === 'found') {
      addDependencyDescriptorWitness(witnessesByWrite, owner, reference, targetResolution.object, diagnostics);
      continue;
    }

    if (reference.requiresCfeDeclaration
      && input.target.rootKind === 'cfe'
      && owner.row.action === 'full-copy'
      && owner.row.incoming?.identity?.ownership === 'own') {
      diagnostics.push(compareDiagnostic(
        `Ссылка ${reference.qualifiedName} из ${reference.artifactPath} у собственного объекта CFE должна быть объявлена в целевом расширении или выбранном пакете. Выберите или заимствуйте зависимый объект; одной записи в base недостаточно.`,
        owner.row.incoming.sourceId,
        owner.row.id,
      ));
      continue;
    }

    let resolvedInBase = false;
    for (const base of provenTargetBases.values()) {
      const baseResolution = resolveDependencyInIndex(base, reference);
      if (baseResolution.kind === 'missing') {continue;}
      if (baseResolution.kind === 'ambiguous' || baseResolution.kind === 'invalid') {
        diagnostics.push(compareDiagnostic(baseResolution.reason, owner.row.incoming?.sourceId ?? RIGHT_SOURCE_ID, owner.row.id));
        resolvedInBase = true;
        break;
      }
      addDependencyDescriptorWitness(witnessesByWrite, owner, reference, baseResolution.object, diagnostics);
      resolvedInBase = true;
      break;
    }
    if (!resolvedInBase) {
      diagnostics.push(compareDiagnostic(
        `Ссылка ${reference.qualifiedName} из ${reference.artifactPath} отсутствует в target, доказанной base и выбранном пакете. Зависимости автоматически не копируются.`,
        owner.row.incoming?.sourceId ?? RIGHT_SOURCE_ID,
        owner.row.id,
      ));
    }
  }

  if (diagnostics.length > 0) {
    return { outputs, diagnostics };
  }
  return {
    outputs: outputs.map((output) => ({
      ...output,
      writes: output.writes.map((write) => ({
        ...write,
        sourceWitnesses: dedupeWitnesses([
          ...write.sourceWitnesses,
          ...(witnessesByWrite.get(dependencyWriteKey(output, write.relativePath)) ?? []),
        ]),
      })),
    })),
    diagnostics,
  };
}

type DependencyResolution =
  | { readonly kind: 'missing' }
  | { readonly kind: 'found'; readonly object: ExtensionIndexedObject }
  | { readonly kind: 'ambiguous'; readonly reason: string }
  | { readonly kind: 'invalid'; readonly reason: string };

type ConfigurationDependencyResolution =
  | { readonly kind: 'missing' }
  | { readonly kind: 'found'; readonly root: ExtensionMetadataIndex }
  | { readonly kind: 'invalid'; readonly reason: string };

function resolveConfigurationDependencyInIndex(
  index: ExtensionMetadataIndex,
  reference: ExtensionMetadataReference,
): ConfigurationDependencyResolution {
  if (!index.hasConfigurationXml || !index.configurationName
    || dependencyKey(index.configurationName) !== dependencyKey(reference.objectName)) {
    return { kind: 'missing' };
  }
  if (!index.configurationHash) {
    return { kind: 'invalid', reason: `Невозможно проверить Configuration.xml для ссылки ${reference.qualifiedName} в ${index.sourceId}.` };
  }
  return { kind: 'found', root: index };
}

function addConfigurationDependencyWitness(
  witnessesByWrite: Map<string, MergeFileWitness[]>,
  output: ExtensionObjectOutput,
  reference: ExtensionMetadataReference,
  root: ExtensionMetadataIndex,
  diagnostics: CompareMessage[],
): void {
  if (!root.configurationHash) {
    diagnostics.push(compareDiagnostic(`Невозможно установить Configuration.xml witness для зависимости ${reference.qualifiedName}.`, root.sourceId, output.row.id));
    return;
  }
  const key = dependencyWriteKey(output, reference.artifactPath);
  const witnesses = witnessesByWrite.get(key) ?? [];
  witnesses.push({
    sourceId: root.sourceId,
    relativePath: CONFIGURATION_XML,
    expectedHash: root.configurationHash,
    kind: 'file',
  });
  witnessesByWrite.set(key, witnesses);
}

function resolveDependencyInIndex(index: ExtensionMetadataIndex, reference: ExtensionMetadataReference): DependencyResolution {
  const matches = index.objects.filter((object) => dependencyKey(object.qualifiedName) === dependencyKey(reference.qualifiedName));
  if (matches.length === 0) {return { kind: 'missing' };}
  if (matches.length > 1) {
    return { kind: 'ambiguous', reason: `Ссылка ${reference.qualifiedName} неоднозначна: в ${index.sourceId} найдено несколько объектов.` };
  }
  const object = matches[0]!;
  if (!object.valid) {
    return { kind: 'invalid', reason: `Ссылка ${reference.qualifiedName} ведёт на объект с некорректным descriptor в ${index.sourceId}.` };
  }
  return { kind: 'found', object };
}

function addDependencyDescriptorWitness(
  witnessesByWrite: Map<string, MergeFileWitness[]>,
  output: ExtensionObjectOutput,
  reference: ExtensionMetadataReference,
  dependency: ExtensionIndexedObject,
  diagnostics: CompareMessage[],
): void {
  if (!dependency.descriptorRelativePath || !dependency.descriptorHash) {
    diagnostics.push(compareDiagnostic(`Невозможно установить witness descriptor для зависимости ${reference.qualifiedName}.`, dependency.sourceId, output.row.id));
    return;
  }
  const key = dependencyWriteKey(output, reference.artifactPath);
  const witnesses = witnessesByWrite.get(key) ?? [];
  witnesses.push({
    sourceId: dependency.sourceId,
    relativePath: dependency.descriptorRelativePath,
    expectedHash: dependency.descriptorHash,
    kind: 'file',
  });
  witnessesByWrite.set(key, witnesses);
}

function dependencyWriteKey(output: ExtensionObjectOutput, relativePath: string): string {
  return `${output.row.id}\0${relativePath}`;
}

function dependencyKey(qualifiedName: string): string {
  return qualifiedName.toLocaleLowerCase();
}

async function buildObjectOutput(
  input: ExtensionMaterializerInput,
  row: ExtensionTransferRow,
  semanticSelections: readonly ExtensionSemanticSelection[] = [],
  addedMetadataReferences: readonly string[] = [],
): Promise<ExtensionObjectOutput | { diagnostic: CompareMessage }> {
  const incoming = row.incoming!;
  const action = row.action!;
  const identity = incoming.identity!;
  if (!incoming.descriptorRelativePath || !incoming.descriptorContent) {
    return { diagnostic: compareDiagnostic('Исходный дескриптор недоступен для captured write.', incoming.sourceId, row.id) };
  }
  const targetRecord = row.target;
  const targetDescriptorRel = targetRecord?.descriptorRelativePath ?? incoming.descriptorRelativePath;
  if (!targetDescriptorRel) {
    return { diagnostic: compareDiagnostic('Не удалось вычислить target descriptor path.', incoming.sourceId, row.id) };
  }
  const witnesses = objectWitnesses(row);
  if (semanticSelections.length > 0) {
    const result = await buildSemanticObjectOutput({
      targetRootPath: input.target.canonicalRootPath ?? input.target.rootPath,
      sourceRootPath: input.incoming.canonicalRootPath ?? input.incoming.rootPath,
      targetDescriptorRelativePath: targetDescriptorRel,
      row,
      witnesses,
      selections: semanticSelections,
      addedMetadataReferences,
    });
    if ('diagnostic' in result) {return result;}
    const linkedPackages = materializeExtensionLinkedDesignerPackages(input, row, semanticSelections, witnesses);
    if ('diagnostic' in linkedPackages) {return linkedPackages;}
    const templateWrites: ExtensionOutputWrite[] = [];
    const templateDeletePaths: string[] = [];
    for (const selection of semanticSelections) {
      if (!selection.linkedTemplateTypeTransition) {continue;}
      const transition = materializeExtensionLinkedTemplateTransition(selection.linkedTemplateTypeTransition);
      if ('reason' in transition) {
        return { diagnostic: compareDiagnostic(transition.reason, incoming.sourceId, row.id) };
      }
      templateWrites.push(transition.write);
      if (transition.deletePath) {templateDeletePaths.push(transition.deletePath);}
    }
    return {
      row,
      ...result,
      outputRelativePaths: [...result.outputRelativePaths, ...linkedPackages.writes.map((write) => write.relativePath), ...linkedPackages.deletePaths, ...templateWrites.map((write) => write.relativePath), ...templateDeletePaths],
      writes: [...result.writes, ...linkedPackages.writes, ...templateWrites],
      deletePaths: [...(result.deletePaths ?? []), ...linkedPackages.deletePaths, ...templateDeletePaths],
      addRegistration: undefined,
    };
  }
  let descriptorContent: Buffer;
  let sidecarFiles: readonly ExtensionCapturedFile[];
  if (action === 'borrow-shell') {
    const base = row.targetBase ?? input.incoming;
    const baseObject = findOwnBaseObject(base, identity.type, identity.uuid);
    if (!baseObject?.identity) {
      return { diagnostic: compareDiagnostic('В base отсутствует UUID объекта для shell.', incoming.sourceId, row.id) };
    }
    const localUuid = randomUUID();
    if (input.target.objects.some((object) => object.identity?.uuid.toLowerCase() === localUuid.toLowerCase())) {
      return { diagnostic: compareDiagnostic(`Сгенерированный локальный UUID borrowed shell уже занят в target: ${localUuid}`, input.target.sourceId, row.id) };
    }
    if (!baseObject.descriptorContent || !input.target.formatVersion) {
      return { diagnostic: compareDiagnostic('Base descriptor или версия target XML отсутствует для borrowed shell.', base.sourceId, row.id) };
    }
    const projection = buildBorrowedObjectShellFromSource({
      sourceXml: baseObject.descriptorContent,
      identity: baseObject.identity,
      formatVersion: input.target.formatVersion,
      localUuid,
    });
    if (!projection.ok) {
      return { diagnostic: compareDiagnostic(`Не удалось построить borrowed shell: ${projection.reason}`, base.sourceId, row.id) };
    }
    descriptorContent = Buffer.from(projection.xml, 'utf8');
    sidecarFiles = [];
    witnesses.push(...objectWitnessesFor(baseObject));
  } else if (action === 'overlay-adopted') {
    if (!targetRecord?.descriptorContent) {
      return { diagnostic: compareDiagnostic('Target adopted descriptor отсутствует для overlay.', incoming.sourceId, row.id) };
    }
    const overlay = overlaySimpleProperties(targetRecord.descriptorContent, incoming.descriptorContent, identity.type);
    if ('error' in overlay) {
      return { diagnostic: compareDiagnostic(overlay.error, incoming.sourceId, row.id) };
    }
    descriptorContent = overlay.content;
    sidecarFiles = [];
  } else if (action === 'adopted-to-cf-overlay') {
    if (!targetRecord?.descriptorContent) {
      return { diagnostic: compareDiagnostic('Базовый CF descriptor отсутствует для adopted overlay.', incoming.sourceId, row.id) };
    }
    const overlay = overlaySimpleProperties(targetRecord.descriptorContent, incoming.descriptorContent, identity.type);
    if ('error' in overlay) {
      return { diagnostic: compareDiagnostic(overlay.error, incoming.sourceId, row.id) };
    }
    descriptorContent = overlay.content;
    sidecarFiles = [];
  } else {
    descriptorContent = incoming.descriptorContent;
    sidecarFiles = incoming.sidecarFiles;
    if (action === 'adopted-cfe-copy' && targetRecord?.identity?.ownership === 'adopted') {
      const rebound = replaceRootUuid(descriptorContent, identity.type, targetRecord.identity.uuid);
      if (!rebound) {
        return { diagnostic: compareDiagnostic('Не удалось безопасно перепривязать локальный UUID adopted descriptor.', incoming.sourceId, row.id) };
      }
      descriptorContent = rebound;
    }
  }

  const writes: ExtensionOutputWrite[] = [{
    relativePath: targetDescriptorRel,
    content: descriptorContent,
    sourceWitnesses: dedupeWitnesses(witnesses),
  }];
  const outputRelativePaths = [targetDescriptorRel];
  const sourceSidecarByPath = new Map(sidecarFiles.map((file) => [file.relativePath, file]));
  const deletePaths: string[] = [];
  if (action === 'full-copy' || action === 'adopted-cfe-copy') {
    for (const file of sidecarFiles) {
      if (!file.content) {
        return { diagnostic: compareDiagnostic(`Captured sidecar bytes отсутствуют: ${file.relativePath}`, incoming.sourceId, row.id) };
      }
      const fileWitnesses = [...witnesses,
        { sourceId: incoming.sourceId, relativePath: file.relativePath, expectedHash: file.hash, kind: 'file' as const },
      ];
      writes.push({ relativePath: file.relativePath, content: Buffer.from(file.content), sourceWitnesses: dedupeWitnesses(fileWitnesses) });
      outputRelativePaths.push(file.relativePath);
      // The write builder below verifies the captured missing/hash target expectation.
    }
    if (targetRecord) {
      for (const file of targetRecord.sidecarFiles) {
        if (!sourceSidecarByPath.has(file.relativePath)) {
          deletePaths.push(file.relativePath);
        }
      }
    }
  }
  const addRegistration = targetRecord
    ? undefined
    : { type: 'add', rootTag: identity.type, objectName: identity.name } as const;
  return {
    row,
    outputRelativePaths,
    writes,
    deletePaths,
    addRegistration,
    effectiveDescriptorRelativePath: targetDescriptorRel,
    effectiveDescriptorContent: descriptorContent,
    effectiveDescriptorWitnesses: writes[0]?.sourceWitnesses ?? witnesses,
  };
}

function objectWitnesses(row: ExtensionTransferRow): MergeFileWitness[] {
  const witnesses: MergeFileWitness[] = [];
  const roots = [row.incomingRoot, row.targetRoot, row.targetBase, row.incomingBase].filter(isDefined);
  for (const root of roots) {
    if (root.configurationHash) {
      witnesses.push({ sourceId: root.sourceId, relativePath: CONFIGURATION_XML, expectedHash: root.configurationHash, kind: 'file' });
    }
  }
  if (row.incoming) {witnesses.push(...objectWitnessesFor(row.incoming));}
  if (row.target) {witnesses.push(...objectWitnessesFor(row.target));}
  const identity = row.incoming?.identity;
  if (identity) {
    const anchorUuid = identity.ownership === 'adopted' ? identity.sourceUuid : identity.uuid;
    if (anchorUuid) {
      if (row.targetBase) {witnesses.push(...objectWitnessesFor(findOwnBaseObject(row.targetBase, identity.type, anchorUuid)));}
      if (row.incomingBase) {witnesses.push(...objectWitnessesFor(findOwnBaseObject(row.incomingBase, identity.type, anchorUuid)));}
    }
  }
  return dedupeWitnesses(witnesses);
}

function objectWitnessesFor(object: ExtensionIndexedObject | undefined): MergeFileWitness[] {
  if (!object) {return [];}
  const witnesses: MergeFileWitness[] = [];
  if (object.descriptorRelativePath && object.descriptorHash) {
    witnesses.push({ sourceId: object.sourceId, relativePath: object.descriptorRelativePath, expectedHash: object.descriptorHash, kind: 'file' });
  }
  if (object.sidecarRelativePath && object.sidecarSnapshot) {
    const expectedHash = object.sidecarSnapshot.state === 'missing'
      ? MISSING_TARGET_HASH
      : mergeSnapshotHash(object.sidecarSnapshot);
    witnesses.push({ sourceId: object.sourceId, relativePath: object.sidecarRelativePath, expectedHash, kind: 'directory' });
  }
  return witnesses;
}

function buildRegistrationOutput(
  target: ExtensionMetadataIndex,
  mutations: readonly RootObjectConfigurationMutation[],
): { content: Buffer } | { diagnostic: CompareMessage } {
  if (!target.configurationContent) {
    return { diagnostic: compareDiagnostic('Целевой Configuration.xml отсутствует; регистрацию обновить нельзя.', LEFT_SOURCE_ID) };
  }
  let content = decodeXml(target.configurationContent);
  try {
    for (const mutation of mutations) {
      content = buildRootObjectConfigurationContent(content, mutation);
    }
  } catch (error) {
    return { diagnostic: compareDiagnostic(`Не удалось собрать пакетную регистрацию объектов: ${errorMessage(error)}`, LEFT_SOURCE_ID) };
  }
  if (target.configurationContent.toString('utf8').startsWith('\uFEFF') && !content.startsWith('\uFEFF')) {
    content = `\uFEFF${content}`;
  }
  return { content: Buffer.from(content, 'utf8') };
}

async function createFileDeleteCandidate(
  input: ExtensionMaterializerInput,
  output: ExtensionObjectOutput,
  relativePath: string,
  roots: ReadonlyMap<string, ExtensionMetadataIndex>,
): Promise<MergeCandidate | { diagnostic: CompareMessage }> {
  const targetRoot = input.target.canonicalRootPath ?? input.target.rootPath;
  const targetPath = path.join(targetRoot, relativePath);
  const snapshot = await captureMergePath(targetPath, { retainContent: false });
  if (snapshot.state !== 'file') {
    return { diagnostic: compareDiagnostic(`Destructive sidecar path отсутствует или больше не является файлом: ${relativePath}`, LEFT_SOURCE_ID, output.row.id) };
  }
  const originalExpected = expectedTargetHashAtCompare(output.row, relativePath, input.target);
  if (originalExpected !== undefined && originalExpected !== snapshot.hash) {
    return { diagnostic: compareDiagnostic(`Target sidecar изменился после сравнения: ${relativePath}`, LEFT_SOURCE_ID, output.row.id) };
  }
  const witnesses = dedupeWitnesses([
    ...objectWitnesses(output.row),
    { sourceId: input.target.sourceId, relativePath, expectedHash: snapshot.hash, kind: 'file' },
  ]);
  for (const witness of witnesses) {
    if (!roots.has(witness.sourceId)) {
      return { diagnostic: compareDiagnostic(`Source witness отсутствует в compare session: ${witness.sourceId}`, witness.sourceId, output.row.id) };
    }
  }
  const targetUri = pathToFileURL(targetPath).toString();
  const fileOperation: FileOperationPayload = {
    kind: 'fileDelete',
    targetPath: targetUri,
    expectedOldHash: snapshot.hash,
    destructive: true,
  };
  return {
    kind: 'fileDelete',
    sourceId: RIGHT_SOURCE_ID,
    snapshotId: input.rightSnapshotId,
    nodeId: output.row.id,
    targetUri,
    expectedOldHash: snapshot.hash,
    fileOperation,
    previewPath: relativePath,
    previewEffect: 'delete',
  };
}

async function verifyCandidateWitnesses(
  candidates: readonly MergeCandidate[],
  roots: ReadonlyMap<string, ExtensionMetadataIndex>,
): Promise<CompareMessage[]> {
  const diagnostics: CompareMessage[] = [];
  const unique = new Map<string, MergeFileWitness>();
  for (const candidate of candidates) {
    for (const witness of candidate.fileWrite?.witnesses ?? []) {
      unique.set(`${witness.sourceId}\0${witness.relativePath}\0${witness.kind ?? 'file'}`, witness);
    }
    // Delete operations retain their file hash in fileOperation and target guard. Their
    // source/base witnesses are separately attached to sibling captured writes when present.
  }
  for (const witness of unique.values()) {
    const root = roots.get(witness.sourceId);
    if (!root) {
      diagnostics.push(compareDiagnostic('Witness source отсутствует в текущей сессии.', witness.sourceId));
      continue;
    }
    const snapshot = await captureMergePath(path.join(root.canonicalRootPath ?? root.rootPath, witness.relativePath), { retainContent: false });
    const actualHash = witness.kind === 'directory'
      ? snapshot.state === 'directory' ? mergeSnapshotHash(snapshot) : snapshot.state === 'missing' ? MISSING_TARGET_HASH : undefined
      : snapshotHashOrMissing(snapshot);
    if (actualHash !== witness.expectedHash) {
      diagnostics.push(compareDiagnostic(`Source/base/target изменился после сравнения: ${witness.relativePath}`, witness.sourceId));
    }
  }
  return diagnostics;
}

function expectedTargetHashAtCompare(
  row: ExtensionTransferRow,
  relativePath: string,
  targetRoot: ExtensionMetadataIndex,
): string | undefined {
  if (relativePath === CONFIGURATION_XML) {
    return targetRoot.configurationHash;
  }
  if (!row.target) {
    return MISSING_TARGET_HASH;
  }
  if (relativePath === row.target.descriptorRelativePath) {
    return row.target.descriptorHash;
  }
  const existingSidecar = row.target.sidecarFiles.find((file) => file.relativePath === relativePath);
  if (existingSidecar) {
    return existingSidecar.hash;
  }
  return MISSING_TARGET_HASH;
}

function findOwnBaseObject(base: ExtensionMetadataIndex, type: string, uuid: string): ExtensionIndexedObject | undefined {
  return base.objects.find((object) => object.valid && object.identity?.ownership === 'own'
    && object.metadataType === type && object.identity.uuid.toLowerCase() === uuid.toLowerCase());
}

function dedupeWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] {
  const byKey = new Map<string, MergeFileWitness>();
  for (const witness of witnesses) {
    byKey.set(`${witness.sourceId}\\0${witness.relativePath}\\0${witness.kind ?? 'file'}`, { ...witness });
  }
  return [...byKey.values()];
}

function snapshotHashOrMissing(snapshot: MergePathSnapshot): string | undefined {
  if (snapshot.state === 'missing') {return MISSING_TARGET_HASH;}
  return snapshot.type === 'file' ? snapshot.hash : undefined;
}

function compareDiagnostic(message: string, sourceId: string, nodeId?: string): CompareMessage {
  return {
    severity: 'error',
    code: 'EXTENSION_TRANSFER_BLOCKED',
    phase: 'compare',
    sourceId,
    nodeId,
    blocking: true,
    suggestedAction: message,
  };
}

function rootPurposeRow(input: ExtensionMaterializerInput): ExtensionTransferRow {
  return {
    id: input.rootPurposeSelection?.nodeId ?? 'extension:root-purpose',
    qualifiedName: 'ConfigurationExtensionPurpose',
    status: 'changed',
    targetRoot: input.target,
    incomingRoot: input.incoming,
    mergeable: true,
  };
}

function decodeXml(content: Buffer): string {
  return content.toString('utf8').replace(/^\\uFEFF/u, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
