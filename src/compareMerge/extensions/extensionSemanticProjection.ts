import * as path from 'path';

import type { CompareMessage } from '../domain/compareContracts';
import type { CompareSession } from '../domain/compareSession';
import type { CompareTreeNode, CompareTreeStatus } from '../compareTreeTypes';
import { throwIfCompareCancelled, type CompareCancellationToken } from '../compareCancellation';
import type { AdapterCompareInput, ConfigurationInventory, ExecutableCandidateFactory, MergeAdapter, MetadataObjectUnit } from '../adapters/mergeAdapter';
import { metadataXmlAdapter } from '../adapters/xmlMetadataAdapter';
import { formXmlAdapter } from '../adapters/formXmlAdapter';
import { predefinedXmlAdapter } from '../adapters/predefinedXmlAdapter';
import { roleRightsXmlAdapter } from '../adapters/roleRightsXmlAdapter';
import { applyRoleRightsProjectionIssues } from '../adapters/roleRightsXmlAdapter';
import { dcsXmlAdapter } from '../adapters/dcsXmlAdapter';
import { captureMergePath } from '../merge/mergeSnapshot';
import { replaceRootUuid } from './extensionXmlOverlay';
import type { ExtensionIndexedObject, ExtensionMetadataIndex } from './extensionMetadataIndex';
import type { ExtensionSemanticSelection, ExtensionTransferRow } from './extensionTransfer';
import { projectExtensionRootPurpose } from './extensionRootPurpose';
import { indexExtensionLinkedDesignerPackages, linkedPackageForRegistrationNode, type ExtensionLinkedDesignerPackage } from './extensionLinkedDesignerPackages';
import { collectExtensionEventDependencies, projectExtensionFormEventHandlers, type ExtensionLinkedRoutineSelection } from './extensionLinkedDesignerBsl';
import { appendExtensionFormProjectionNodes } from './extensionAdoptedFormProjection';
import { bindExtensionLinkedTemplateTransition, captureExtensionLinkedTemplateTransitions } from './extensionLinkedTemplateTransitions';
import {
  createExtensionAdoptedUuidSnapshot,
  prepareExtensionAdoptedSemanticRow,
  type ExtensionAdoptedPreparedArtifact,
} from './extensionAdoptedSemanticHost';
import { directionForExtensionAdoptedRow } from './extensionAdoptedSemanticContext';
import { adoptedTemplateTypeGuardReason, createAdoptedTemplateTypeGuard, type AdoptedTemplateTypeGuard } from './extensionAdoptedTemplateTypeGuard';
import type { LinkedEventDependency, LinkedFormModuleSnapshot } from '../linkedDesignerTypes';
import { buildExtensionSemanticReferenceContext } from './extensionSemanticContext';
import {
  adoptedCandidateUuid,
  mapAdoptedIssuesToNodes,
  withRegistryCandidateWitnesses,
  type AdoptedIssueNodeMap,
} from './adoptedDesignerCandidatePolicy';
import {
  adoptedRoleRightsBlockers,
  adoptedRoleRightsNode,
  hasAdoptedRoleIdentity,
  normalizeArtifactPath,
  pairedXmlSidecars,
} from './extensionSemanticSidecars';
import { appendAdoptedRightsProjectionNodes, adoptedRightsDeclarationScope } from './extensionAdoptedRightsSelection';
import { dedupeSemanticWitnesses, selectionDependency, withRootConfigurationWitnesses } from './extensionSemanticSelectionSupport';
import {
  appendExtensionAdoptedTemplateNodes,
  createAdoptedTemplateBodyOnlyResultNode,
  createAdoptedTemplateDescriptorArtifact,
  projectAdoptedTemplateCompareResult,
} from './extensionAdoptedTemplateProjectionBinder';
import { toExtensionSemanticInventory } from './extensionSemanticInventory';

export { pairedXmlSidecars };

export interface ExtensionSemanticProjectionInput {
  readonly target: ExtensionMetadataIndex;
  readonly incoming: ExtensionMetadataIndex;
  readonly rows: readonly ExtensionTransferRow[];
  readonly session: CompareSession;
  readonly leftSnapshotId: string;
  readonly rightSnapshotId: string;
  readonly globalBlockReason?: string;
  readonly cancellation?: CompareCancellationToken;
}

export interface ExtensionSemanticProjection {
  readonly nodes: readonly CompareTreeNode[];
  readonly rootPurposeNode?: CompareTreeNode;
  readonly mergeableNodeIds: readonly string[];
  readonly selections: ReadonlyMap<string, ExtensionSemanticSelection>;
  readonly rootPurposeSelection?: import('./extensionTransfer').ExtensionRootPurposeSelection;
  readonly diagnostics: readonly CompareMessage[];
  readonly linkedDesignerPackages: ReadonlyMap<string, ExtensionLinkedDesignerPackage>;
  readonly linkedRoutineSelections: ReadonlyMap<string, ExtensionLinkedRoutineSelection>;
  readonly linkedFormModules: readonly LinkedFormModuleSnapshot[];
  readonly linkedEventDependencies: ReadonlyMap<string, LinkedEventDependency>;
}

const XML_FILES = [
  { kind: 'formXml' as const, fileName: 'form.xml', adapter: formXmlAdapter, label: 'Форма' },
  { kind: 'predefinedXml' as const, fileName: 'predefined.xml', adapter: predefinedXmlAdapter, label: 'Предопределённые данные' },
  { kind: 'roleRightsXml' as const, fileName: 'rights.xml', adapter: roleRightsXmlAdapter, label: 'Права роли' },
  { kind: 'dcsXml' as const, fileName: 'template.xml', adapter: dcsXmlAdapter, label: 'Схема компоновки данных' },
];

export async function projectExtensionSemanticNodes(
  input: ExtensionSemanticProjectionInput,
): Promise<ExtensionSemanticProjection> {
  const targetInventory = toExtensionSemanticInventory(input.target);
  const incomingInventory = toExtensionSemanticInventory(input.incoming);
  const selections = new Map<string, ExtensionSemanticSelection>();
  const diagnostics: CompareMessage[] = [];
  const nodes: CompareTreeNode[] = [];
  const mergeableNodeIds: string[] = [];
  const linkedDesignerPackages = new Map<string, ExtensionLinkedDesignerPackage>();
  const linkedRoutineSelections = new Map<string, ExtensionLinkedRoutineSelection>();
  const linkedFormModules: LinkedFormModuleSnapshot[] = [];
  const linkedEventDependencies = new Map<string, LinkedEventDependency>();
  const adoptedUuidSnapshot = await createExtensionAdoptedUuidSnapshot({ targetRoot: input.target, incomingRoot: input.incoming });

  for (const row of input.rows) {
    throwIfCompareCancelled(input.cancellation);
    if (!row.target || !row.incoming || !row.target.descriptorRelativePath || !row.incoming.descriptorRelativePath) {
      nodes.push(rowNode(row, []));
      continue;
    }
    const linkedIndex = await indexExtensionLinkedDesignerPackages({
      row,
      target: input.target,
      incoming: input.incoming,
      preserveTargetFormPackages: directionForExtensionAdoptedRow(row) !== undefined,
    });
    const adoptedPreparation = await prepareExtensionAdoptedSemanticRow({
      row,
      targetRoot: input.target,
      incomingRoot: input.incoming,
      uuidSnapshot: adoptedUuidSnapshot,
      linkedPackages: linkedIndex.packages,
    });
    const hasAdoptedProjection = adoptedPreparation.applicable;
    const ownFormPackageProofs = new Map(adoptedPreparation.applicable
      ? adoptedPreparation.ownForms?.packageProofs.map((proof) => [proof.packageId, proof]) ?? []
      : []);
    const linkedPackagesForRow = linkedIndex.packages
      .filter((recipe) => !hasAdoptedProjection
        || ((recipe.kind === 'Form' && (recipe.action !== 'copy' || ownFormPackageProofs.has(recipe.packageId)))))
      .map((recipe) => {
        const proof = ownFormPackageProofs.get(recipe.packageId);
        if (!proof) { return recipe; }
        return {
          ...recipe,
          dependencyWitnesses: proof.dependencyWitnesses,
          members: recipe.members.map((member) => member.sourceRelativePath
            && normalizeArtifactPath(member.sourceRelativePath) === normalizeArtifactPath(proof.descriptorSourceRelativePath)
            ? { ...member, descriptorUuidWitnesses: proof.descriptorUuidWitnesses }
            : member),
        };
      });
    const linkedPackageIds = new Set(linkedPackagesForRow.map((recipe) => recipe.packageId));
    const linkedCapabilities = {
      ...linkedIndex.capabilities,
      registrations: linkedIndex.capabilities.registrations.filter((registration) => linkedPackageIds.has(registration.packageId)),
      defaultObjectForms: linkedIndex.capabilities.defaultObjectForms.map((item) => {
        if (!item.packageId || linkedPackageIds.has(item.packageId)) { return item; }
        return { ...item, packageId: undefined };
      }),
    };
    const linkedTemplateTransitions = hasAdoptedProjection
      ? []
      : await captureExtensionLinkedTemplateTransitions({ row, targetRoot: input.target, incomingRoot: input.incoming });
    const ordinaryReadonlyReason = hasAdoptedProjection ? undefined : semanticSelectionReason(row);
    const adoptedMetadataProofBlocker = hasAdoptedProjection
      ? adoptedPreparation.blockers.find((blocker) => blocker.kind === 'metadataXml')
      : undefined;
    const adoptedReadonlyReason = hasAdoptedProjection
      ? adoptedMetadataProofBlocker?.reason
        ?? (!row.semanticAction && (!row.mergeable || row.reason)
          ? row.reason ?? 'Объект недоступен для семантического переноса.'
          : undefined)
      : undefined;
    const allowed = hasAdoptedProjection
      ? adoptedReadonlyReason === undefined
      : ordinaryReadonlyReason === undefined;
    const readonlyReason = hasAdoptedProjection ? adoptedReadonlyReason : ordinaryReadonlyReason;
    const childNodes: CompareTreeNode[] = [];
    diagnostics.push(...linkedIndex.diagnostics.filter((diagnostic) =>
      !hasAdoptedProjection || !isUnscopedAdoptedTemplatePackageDiagnostic(diagnostic, row.id),
    ));
    for (const recipe of linkedPackagesForRow) {linkedDesignerPackages.set(recipe.packageId, recipe);}
    const adoptedDescriptor = hasAdoptedProjection
      ? adoptedPreparation.artifacts.find((artifact) => artifact.kind === 'metadataXml')
      : undefined;
    const adoptedTemplateDescriptor = hasAdoptedProjection
      ? adoptedPreparation.templates?.artifacts.find((artifact) => artifact.metadataType === 'CommonTemplate')
      : undefined;
    let descriptors = await compareArtifact({
      input,
      targetInventory,
      incomingInventory,
      targetObject: row.target,
      incomingObject: row.incoming,
      kind: 'metadataXml',
      targetRelativePath: adoptedDescriptor?.targetRelativePath ?? row.target.descriptorRelativePath,
      sourceRelativePath: adoptedDescriptor?.sourceRelativePath ?? row.incoming.descriptorRelativePath,
      targetHash: adoptedDescriptor?.targetHash ?? row.target.descriptorHash,
      sourceHash: adoptedDescriptor?.sourceHash ?? row.incoming.descriptorHash,
      adapter: metadataXmlAdapter,
      label: 'Дескриптор',
      row,
      allowed,
      readonlyReason,
      linkedDesignerContext: linkedCapabilities,
      linkedPackages: linkedPackagesForRow,
      preserveAdoptedFormDeletes: hasAdoptedProjection,
      ...(adoptedDescriptor ? { adoptedArtifact: adoptedDescriptor } : {}),
      ...(adoptedTemplateDescriptor ? { adoptedTemplateArtifact: adoptedTemplateDescriptor } : {}),
      selections,
      diagnostics,
    });
    for (const candidate of linkedTemplateTransitions.filter((item) =>
      normalizeArtifactPath(item.targetDescriptorRelativePath) === normalizeArtifactPath(row.target!.descriptorRelativePath!),
    )) {
      if (descriptors) {
        descriptors = {
          ...descriptors,
          children: bindExtensionLinkedTemplateTransition({
            nodes: descriptors.children,
            selections,
            candidate,
            targetRootPath: input.target.canonicalRootPath ?? input.target.rootPath,
          }),
        };
      } else {
        childNodes.push(templateTransitionBlockerNode(candidate));
      }
    }
    throwIfCompareCancelled(input.cancellation);
    if (descriptors) {childNodes.push(descriptors);}
    if (hasAdoptedProjection && adoptedPreparation.templates) {
      childNodes.push(...await appendExtensionAdoptedTemplateNodes({
        row,
        artifacts: adoptedPreparation.templates.artifacts,
        blockers: adoptedPreparation.templates.blockers,
        targetRootPath: targetInventory.rootPath,
        sourceRootPath: incomingInventory.rootPath,
        compare: (artifact, targetUnit, sourceUnit) => compareArtifact({
          input, targetInventory, incomingInventory, targetObject: row.target!, incomingObject: row.incoming!,
          kind: 'metadataXml', targetRelativePath: artifact.targetRelativePath, sourceRelativePath: artifact.sourceRelativePath,
          targetHash: artifact.targetHash, sourceHash: artifact.sourceHash, adapter: metadataXmlAdapter,
          label: `Макет: ${artifact.qualifiedName}`, row, allowed, readonlyReason,
          matchUnits: { target: targetUnit, source: sourceUnit }, adoptedTemplateArtifact: artifact, selections, diagnostics,
        }),
      }));
    }

    const paired = pairedXmlSidecars(row.target, row.incoming);
    const adoptedRights = hasAdoptedProjection ? adoptedPreparation.rights : undefined;
    const adoptedRoleRights = !hasAdoptedProjection && hasAdoptedRoleIdentity(row)
      ? adoptedRoleRightsBlockers(row)
      : [];
    childNodes.push(...adoptedRoleRights.map((blocker) => adoptedRoleRightsNode(row, blocker)));
    for (const duplicatePath of hasAdoptedProjection ? [] : paired.duplicatePaths) {
      diagnostics.push({
        severity: 'error', code: 'EXTENSION_SEMANTIC_PATH_AMBIGUOUS', phase: 'compare',
        sourceId: row.incoming.sourceId, path: duplicatePath, nodeId: row.id, blocking: true,
        suggestedAction: 'Несколько XML sidecar-файлов имеют один и тот же нормализованный относительный путь; семантическое сопоставление этого пути пропущено.',
      });
    }
    for (const pair of paired.pairs.filter((candidate) => !(hasAdoptedProjection && (candidate.kind === 'formXml' || candidate.kind === 'roleRightsXml'))
      && !(adoptedRoleRights.length > 0 && candidate.kind === 'roleRightsXml'))) {
      throwIfCompareCancelled(input.cancellation);
      const definition = XML_FILES.find((candidate) => candidate.kind === pair.kind)!;
      const [targetFormXml, sourceFormXml] = pair.kind === 'formXml'
        ? await Promise.all([
          capturedSidecar(input.target, pair.target),
          capturedSidecar(input.incoming, pair.source),
        ])
        : [undefined, undefined];
      if (pair.kind === 'formXml' && (!targetFormXml || !sourceFormXml)) {
        diagnostics.push(semanticReadDiagnostic(row, pair.relativePath));
      }
      const eventProjection = pair.kind === 'formXml' && targetFormXml && sourceFormXml
        ? await projectExtensionFormEventHandlers({
          row,
          targetRoot: input.target,
          incomingRoot: input.incoming,
          targetOwner: row.target,
          incomingOwner: row.incoming,
          targetFormPath: pair.target.relativePath,
          sourceFormPath: pair.source.relativePath,
          targetFormXml,
          sourceFormXml,
          rightSnapshotId: input.rightSnapshotId,
        })
        : undefined;
      if (eventProjection) {
        diagnostics.push(...eventProjection.diagnostics);
        eventProjection.routineSelections.forEach((selection, id) => linkedRoutineSelections.set(id, selection));
        if (eventProjection.module) {linkedFormModules.push(eventProjection.module);}
      }
      const node = await compareArtifact({
        input,
        targetInventory,
        incomingInventory,
        targetObject: row.target,
        incomingObject: row.incoming,
        kind: pair.kind,
        targetRelativePath: pair.target.relativePath,
        sourceRelativePath: pair.source.relativePath,
        targetHash: pair.target.hash,
        sourceHash: pair.source.hash,
        adapter: definition.adapter,
        label: `${definition.label}: ${path.posix.dirname(pair.relativePath)}`,
        row,
        allowed,
        readonlyReason,
        ...(eventProjection ? { linkedDesignerContext: { registrations: [], defaultObjectForms: [], formEventHandlers: eventProjection.context } } : {}),
        selections,
        diagnostics,
      });
      throwIfCompareCancelled(input.cancellation);
      if (node) {childNodes.push(node);}
      if (node && eventProjection?.module) {
        collectExtensionEventDependencies({
          nodes: node.children,
          capabilities: eventProjection.context,
          module: eventProjection.module,
          output: linkedEventDependencies,
        });
      }
      if (eventProjection) {childNodes.push(...eventProjection.routineNodes);}
    }
    if (adoptedRights) {
      childNodes.push(...await appendAdoptedRightsProjectionNodes({
        row,
        preparation: adoptedRights,
        compareArtifact: (artifact) => compareArtifact({
          input,
          targetInventory,
          incomingInventory,
          targetObject: row.target!,
          incomingObject: row.incoming!,
          kind: 'roleRightsXml',
          targetRelativePath: artifact.targetRelativePath,
          sourceRelativePath: artifact.sourceRelativePath,
          targetHash: artifact.targetHash,
          sourceHash: artifact.sourceHash,
          adapter: roleRightsXmlAdapter,
          label: `Права роли: ${path.posix.dirname(artifact.targetRelativePath)}`,
          row,
          allowed,
          readonlyReason,
          preparedRights: artifact,
          dependencyWitnesses: artifact.requiredWitnesses,
          selections,
          diagnostics,
        }),
      }));
    }
    for (const candidate of linkedTemplateTransitions.filter((item) =>
      normalizeArtifactPath(item.targetDescriptorRelativePath) !== normalizeArtifactPath(row.target!.descriptorRelativePath!),
    )) {
      const sourceRelativePath = candidate.sourceDescriptorRelativePath;
      const transition = candidate.transition;
      if (!sourceRelativePath || !transition || !candidate.targetIdentity || !candidate.sourceIdentity) {
        childNodes.push(templateTransitionBlockerNode(candidate));
        continue;
      }
      let templateNode = await compareArtifact({
        input,
        targetInventory,
        incomingInventory,
        targetObject: row.target,
        incomingObject: row.incoming,
        kind: 'metadataXml',
        targetRelativePath: candidate.targetDescriptorRelativePath,
        sourceRelativePath,
        targetHash: transition.targetDescriptorHash,
        sourceHash: transition.sourceDescriptorHash,
        adapter: metadataXmlAdapter,
        label: `Макет: ${candidate.qualifiedName}`,
        row,
        allowed,
        readonlyReason,
        matchUnits: {
          target: templateMetadataUnit(
            targetInventory.rootPath,
            candidate.targetDescriptorRelativePath,
            candidate.qualifiedName,
            candidate.targetIdentity.type,
            candidate.targetIdentity.uuid,
          ),
          source: templateMetadataUnit(
            incomingInventory.rootPath,
            sourceRelativePath,
            candidate.qualifiedName,
            candidate.sourceIdentity.type,
            candidate.sourceIdentity.uuid,
          ),
        },
        selections,
        diagnostics,
      });
      if (templateNode) {
        templateNode = {
          ...templateNode,
          children: bindExtensionLinkedTemplateTransition({
            nodes: templateNode.children,
            selections,
            candidate,
            targetRootPath: input.target.canonicalRootPath ?? input.target.rootPath,
          }),
        };
        childNodes.push(templateNode);
      } else {
        childNodes.push(templateTransitionBlockerNode(candidate));
      }
    }
    if (hasAdoptedProjection) {
      await appendExtensionFormProjectionNodes({
        row,
        targetRoot: input.target,
        incomingRoot: input.incoming,
        rightSnapshotId: input.rightSnapshotId,
        cancellation: input.cancellation,
        forms: adoptedPreparation.artifacts.filter((artifact) => artifact.kind === 'formXml').map((artifact) => ({
          payload: artifact,
          targetRelativePath: artifact.targetRelativePath,
          sourceRelativePath: artifact.sourceRelativePath,
          targetHash: artifact.targetHash,
          sourceHash: artifact.sourceHash,
          targetXml: artifact.targetXml,
          sourceXml: artifact.sourceXml,
        })),
        compare: ({ payload: artifact }, events) => compareArtifact({
          input, targetInventory, incomingInventory, targetObject: row.target!, incomingObject: row.incoming!,
          kind: 'formXml', targetRelativePath: artifact.targetRelativePath, sourceRelativePath: artifact.sourceRelativePath,
          targetHash: artifact.targetHash, sourceHash: artifact.sourceHash, adapter: formXmlAdapter,
          label: `Форма: ${path.posix.dirname(artifact.targetRelativePath)}`, row, allowed, readonlyReason,
          linkedDesignerContext: { registrations: [], defaultObjectForms: [], formEventHandlers: events.context },
          adoptedArtifact: artifact, selections, diagnostics,
        }),
        childNodes, diagnostics, linkedRoutineSelections, linkedFormModules, linkedEventDependencies,
      });
      for (const blocker of adoptedPreparation.blockers) {
        childNodes.push(adoptedBlockerNode(row, blocker));
      }
      await appendExtensionFormProjectionNodes({
        row,
        targetRoot: input.target,
        incomingRoot: input.incoming,
        rightSnapshotId: input.rightSnapshotId,
        cancellation: input.cancellation,
        forms: (adoptedPreparation.ownForms?.matchedForms ?? []).map((ownForm) => ({
          payload: ownForm,
          targetRelativePath: ownForm.recipe.targetRelativePath,
          sourceRelativePath: ownForm.recipe.sourceRelativePath,
          targetHash: ownForm.recipe.targetHash,
          sourceHash: ownForm.recipe.sourceHash,
          targetXml: ownForm.targetXml,
          sourceXml: ownForm.sourceXml,
        })),
        compare: ({ payload: ownForm }, events) => compareArtifact({
          input, targetInventory, incomingInventory, targetObject: row.target!, incomingObject: row.incoming!,
          kind: 'formXml', targetRelativePath: ownForm.recipe.targetRelativePath,
          sourceRelativePath: ownForm.recipe.sourceRelativePath, targetHash: ownForm.recipe.targetHash,
          sourceHash: ownForm.recipe.sourceHash, adapter: formXmlAdapter,
          label: `Форма: ${ownForm.recipe.targetIdentity.name}`, row, allowed, readonlyReason,
          linkedDesignerContext: { registrations: [], defaultObjectForms: [], formEventHandlers: events.context },
          dependencyWitnesses: ownForm.recipe.requiredWitnesses, adoptedOwnForm: ownForm.recipe,
          selections, diagnostics,
        }),
        childNodes, diagnostics, linkedRoutineSelections, linkedFormModules, linkedEventDependencies,
      });
    }
    nodes.push(rowNode(row, childNodes));
    if (row.mergeable) {mergeableNodeIds.push(row.id);}
    if (allowed) {
      for (const child of childNodes) {
        mergeableNodeIds.push(...collectMergeableIds(child));
      }
    }
  }

  const rootPurpose = await projectExtensionRootPurpose({
    target: input.target,
    incoming: input.incoming,
    session: input.session,
    globalBlockReason: input.globalBlockReason,
    cancellation: input.cancellation,
  });
  throwIfCompareCancelled(input.cancellation);
  diagnostics.push(...rootPurpose.diagnostics);
  if (rootPurpose.node?.mergeable) {mergeableNodeIds.push(rootPurpose.node.id);}
  return {
    nodes,
    ...(rootPurpose.node ? { rootPurposeNode: rootPurpose.node } : {}),
    mergeableNodeIds,
    selections,
    ...(rootPurpose.selection ? { rootPurposeSelection: rootPurpose.selection } : {}),
    diagnostics,
    linkedDesignerPackages,
    linkedRoutineSelections,
    linkedFormModules,
    linkedEventDependencies,
  };
}

async function capturedSidecar(
  root: ExtensionMetadataIndex,
  file: ExtensionIndexedObject['sidecarFiles'][number],
): Promise<Buffer | undefined> {
  if (file.content) {return Buffer.from(file.content);}
  const captured = await captureXmlArtifact(root.canonicalRootPath ?? root.rootPath, file.relativePath, file.hash);
  return captured;
}

async function compareArtifact(input: {
  input: ExtensionSemanticProjectionInput;
  targetInventory: ConfigurationInventory;
  incomingInventory: ConfigurationInventory;
  targetObject: ExtensionIndexedObject;
  incomingObject: ExtensionIndexedObject;
  kind: ExtensionSemanticSelection['kind'];
  targetRelativePath: string;
  sourceRelativePath: string;
  targetHash?: string;
  sourceHash?: string;
  adapter: MergeAdapter;
  label: string;
  row: ExtensionTransferRow;
  allowed: boolean;
  readonlyReason?: string;
  matchUnits?: { readonly target: MetadataObjectUnit; readonly source: MetadataObjectUnit };
  linkedDesignerContext?: NonNullable<AdapterCompareInput['linkedDesignerContext']>;
  linkedPackages?: readonly ExtensionLinkedDesignerPackage[];
  preserveAdoptedFormDeletes?: boolean;
  adoptedArtifact?: ExtensionAdoptedPreparedArtifact;
  adoptedTemplateArtifact?: import('./extensionAdoptedTemplateHost').ExtensionAdoptedPreparedTemplateArtifact;
  preparedRights?: import('./extensionAdoptedRightsHost').ExtensionAdoptedPreparedRightsArtifact;
  adoptedOwnForm?: import('./extensionAdoptedOwnFormHost').CapturedAdoptedOwnFormSelection;
  dependencyWitnesses?: readonly import('../merge/mergePreview').MergeFileWitness[];
  selections: Map<string, ExtensionSemanticSelection>;
  diagnostics: CompareMessage[];
}): Promise<CompareTreeNode | undefined> {
  const targetRoot = input.input.target.canonicalRootPath ?? input.input.target.rootPath;
  const sourceRoot = input.input.incoming.canonicalRootPath ?? input.input.incoming.rootPath;
  if (!input.adoptedArtifact && !input.adoptedTemplateArtifact && !input.preparedRights && (!input.targetHash || !input.sourceHash)) {
    return undefined;
  }
  if (!input.adoptedArtifact && !input.adoptedTemplateArtifact && !input.preparedRights && input.targetHash === input.sourceHash) {return undefined;}
  if (input.adoptedArtifact
      && (input.targetRelativePath !== input.adoptedArtifact.targetRelativePath
        || input.sourceRelativePath !== input.adoptedArtifact.sourceRelativePath
        || input.kind !== input.adoptedArtifact.kind)) {
    input.diagnostics.push(semanticReadDiagnostic(input.row, input.sourceRelativePath));
    return undefined;
  }
  if (input.adoptedTemplateArtifact
      && (input.kind !== 'metadataXml'
        || input.targetRelativePath !== input.adoptedTemplateArtifact.targetRelativePath
        || input.sourceRelativePath !== input.adoptedTemplateArtifact.sourceRelativePath)) {
    input.diagnostics.push(semanticReadDiagnostic(input.row, input.sourceRelativePath));
    return undefined;
  }
  const descriptorArtifact = input.adoptedArtifact ?? (input.adoptedTemplateArtifact
    ? createAdoptedTemplateDescriptorArtifact({
      artifact: input.adoptedTemplateArtifact,
      targetRootPath: targetRoot,
      sourceRootPath: sourceRoot,
    })
    : undefined);
  const [target, source] = input.adoptedTemplateArtifact
    ? [Buffer.from(input.adoptedTemplateArtifact.targetXml), Buffer.from(input.adoptedTemplateArtifact.sourceXml)]
    : descriptorArtifact
      ? [Buffer.from(descriptorArtifact.targetXml), Buffer.from(descriptorArtifact.sourceXml)]
    : input.preparedRights
      ? [Buffer.from(input.preparedRights.targetXml), Buffer.from(input.preparedRights.sourceXml)]
    : await Promise.all([
      captureXmlArtifact(targetRoot, input.targetRelativePath, input.targetHash!),
      captureXmlArtifact(sourceRoot, input.sourceRelativePath, input.sourceHash!),
    ]);
  if (!target || !source) {
    input.diagnostics.push(semanticReadDiagnostic(input.row, input.sourceRelativePath));
    return undefined;
  }
  if (descriptorArtifact && target.equals(source) && !input.adoptedTemplateArtifact?.bodyEffect) {
    return descriptorArtifact.issues.length === 0
      ? undefined
      : adoptedIssuesOnlyNode(input.row, input.kind, input.targetRelativePath, descriptorArtifact.issues);
  }
  if (input.preparedRights && target.equals(source) && input.preparedRights.issues.length === 0) {return undefined;}
  let sourceText = source.toString('utf8');
  const normalizeAdoptedRoot = input.kind === 'metadataXml'
    && !descriptorArtifact
    && (input.row.semanticAction === 'adopted-cfe-semantic' || input.row.action === 'adopted-cfe-copy')
    && input.row.sameProvenBase === true
    && input.targetObject.identity?.ownership === 'adopted'
    && input.incomingObject.identity?.ownership === 'adopted';
  if (normalizeAdoptedRoot) {
    const targetUuid = input.targetObject.identity?.uuid;
    const rebound = targetUuid ? replaceRootUuid(source, input.incomingObject.metadataType, targetUuid) : undefined;
    if (!rebound) {
      input.diagnostics.push({
        severity: 'error', code: 'EXTENSION_SEMANTIC_XML_UNAVAILABLE', phase: 'compare',
        sourceId: input.row.incoming?.sourceId ?? input.row.incomingRoot.sourceId,
        path: input.sourceRelativePath, nodeId: input.row.id, blocking: true,
        suggestedAction: 'Не удалось безопасно выровнять локальный UUID adopted-дескриптора перед семантическим сравнением.',
      });
      return undefined;
    }
    sourceText = rebound.toString('utf8');
  }

  const targetUnit = input.matchUnits?.target ?? inventoryObject(input.targetInventory, input.targetObject);
  const sourceUnit = input.matchUnits?.source ?? inventoryObject(input.incomingInventory, input.incomingObject);
  if (!targetUnit || !sourceUnit) {return undefined;}
  const metadataContext = await buildExtensionSemanticReferenceContext({
    row: input.row,
    kind: input.kind,
    targetRelativePath: input.targetRelativePath,
    sourceRelativePath: input.sourceRelativePath,
  });
  const compareInput: AdapterCompareInput = {
    strategy: 'full',
    leftInventory: input.targetInventory,
    rightInventory: input.incomingInventory,
    match: { left: targetUnit, right: sourceUnit },
    session: input.input.session,
    artifactPaths: {
      left: path.join(targetRoot, input.targetRelativePath),
      right: path.join(sourceRoot, input.sourceRelativePath),
    },
    semanticValidationContext: metadataContext.validationContext,
    semanticMetadataReferenceWitnesses: metadataContext.referenceWitnesses,
    semanticContextWitnesses: descriptorArtifact
      ? [...metadataContext.contextWitnesses, ...descriptorArtifact.recipe.requiredWitnesses, ...descriptorArtifact.dependencyWitnesses]
      : input.preparedRights
        ? metadataContext.contextWitnesses
      : [...metadataContext.contextWitnesses, ...(input.dependencyWitnesses ?? [])],
    linkedDesignerContext: input.linkedDesignerContext,
    ...(descriptorArtifact ? { allowMetadataChildOrder: true, allowFormSectionOrder: true } : {}),
    snapshots: { left: target.toString('utf8'), right: sourceText },
  };
  const adapterResult = await input.adapter.compare(compareInput);
  const result = input.preparedRights
    ? applyRoleRightsProjectionIssues(adapterResult, input.preparedRights.issues, path.join(targetRoot, input.targetRelativePath))
    : adapterResult;
  input.diagnostics.push(...result.diagnostics);
  if (result.nodes.length === 0) {
    const blocker = result.diagnostics.find((item) => item.blocking);
    const issues = descriptorArtifact?.issues ?? [];
    if (!blocker && issues.length === 0) {
      return input.adoptedTemplateArtifact
        ? createAdoptedTemplateBodyOnlyResultNode({
          rowId: input.row.id, label: input.label, kind: input.kind,
          targetRelativePath: input.targetRelativePath, artifact: input.adoptedTemplateArtifact,
          selections: input.selections, candidateFactories: result.candidateFactories,
          sourceId: input.row.incoming?.sourceId ?? input.row.incomingRoot.sourceId,
          rightSnapshotId: input.input.rightSnapshotId, targetRootPath: targetRoot, sourceRootPath: sourceRoot,
          allowed: input.allowed, readonlyReason: input.readonlyReason,
        })
        : undefined;
    }
    const reason = blocker?.suggestedAction ?? issues[0]?.reason ?? 'XML-артефакт доступен только для чтения.';
    return {
      id: `extension:xml:${input.row.id}:${input.kind}:${encodeURIComponent(input.targetRelativePath)}`,
      label: input.label,
      kind: 'extensionSemanticFile',
      status: 'changed',
      mergeable: false,
      conflict: { kind: 'unsupported', message: reason, blocking: true },
      mergeState: { state: 'blocked', reason, targetFilePath: input.targetRelativePath },
      children: issues.map((issue) => adoptedProjectionIssueNode(input.row, input.kind, input.targetRelativePath, issue)),
    };
  }

  const adoptedIssueMap = descriptorArtifact ? mapAdoptedIssuesToNodes(result.nodes, result.candidateFactories, descriptorArtifact.issues) : undefined;
  const adoptedTemplateTypeRoute = input.kind === 'metadataXml'
    && (descriptorArtifact?.kind === 'metadataXml'
      || (input.row.action === 'adopted-cfe-copy'
        && input.row.sameProvenBase === true
        && input.targetObject.identity?.ownership === 'adopted'
        && input.incomingObject.identity?.ownership === 'adopted'
        && input.row.targetRoot.rootKind === 'cfe'
        && input.row.incomingRoot.rootKind === 'cfe'));
  const adoptedTemplateTypeGuard = adoptedTemplateTypeRoute
    ? createAdoptedTemplateTypeGuard(target.toString('utf8'), sourceText)
    : undefined;
  const projectedContents = projectAdoptedTemplateCompareResult({
    nodes: result.nodes,
    projectNode: (node) => projectAdapterNode({
      node,
      factoryMap: result.candidateFactories,
      input,
      linkedPackages: input.linkedPackages ?? [],
      preserveAdoptedFormDeletes: input.preserveAdoptedFormDeletes,
      ...(adoptedTemplateTypeGuard ? { adoptedTemplateTypeGuard } : {}),
      ...(descriptorArtifact ? { adoptedArtifact: descriptorArtifact } : {}),
      ...(input.preparedRights ? { preparedRights: input.preparedRights } : {}),
      ...(input.adoptedOwnForm ? { adoptedOwnForm: input.adoptedOwnForm } : {}),
      ...(input.dependencyWitnesses ? { dependencyWitnesses: input.dependencyWitnesses } : {}),
      ...(adoptedIssueMap ? { adoptedIssueMap } : {}),
    }),
    appendUnmatchedIssues: adoptedIssueMap ? (contents) => {
      for (const issue of adoptedIssueMap.unmatched) {
        contents.push(adoptedProjectionIssueNode(input.row, input.kind, input.targetRelativePath, issue));
      }
    } : undefined,
    selections: input.selections,
    candidateFactories: result.candidateFactories,
    artifact: input.adoptedTemplateArtifact,
    rowId: input.row.id,
    sourceId: input.row.incoming?.sourceId ?? input.row.incomingRoot.sourceId,
    rightSnapshotId: input.input.rightSnapshotId,
    targetRootPath: targetRoot,
    sourceRootPath: sourceRoot,
    allowed: input.allowed,
    readonlyReason: input.readonlyReason,
  });
  const status: CompareTreeStatus = projectedContents.some((node) => node.status !== 'equal') ? 'changed' : 'equal';
  return {
    id: `extension:xml:${input.row.id}:${input.kind}:${encodeURIComponent(input.targetRelativePath)}`,
    label: input.label,
    kind: 'extensionSemanticFile',
    status,
    ...(input.allowed ? {} : { mergeable: false, mergeState: { state: 'blocked', reason: input.readonlyReason ?? 'Для этого направления переноса XML-слияние недоступно.' } as const }),
    children: [...projectedContents],
  };
}

function projectAdapterNode(input: {
  node: CompareTreeNode;
  factoryMap: ReadonlyMap<string, ExecutableCandidateFactory>;
  input: Parameters<typeof compareArtifact>[0];
  linkedPackages: readonly ExtensionLinkedDesignerPackage[];
  preserveAdoptedFormDeletes?: boolean;
  adoptedTemplateTypeGuard?: AdoptedTemplateTypeGuard;
  adoptedArtifact?: ExtensionAdoptedPreparedArtifact;
  preparedRights?: import('./extensionAdoptedRightsHost').ExtensionAdoptedPreparedRightsArtifact;
  adoptedOwnForm?: import('./extensionAdoptedOwnFormHost').CapturedAdoptedOwnFormSelection;
  dependencyWitnesses?: readonly import('../merge/mergePreview').MergeFileWitness[];
  adoptedIssueMap?: AdoptedIssueNodeMap;
}): CompareTreeNode {
  const node = input.node;
  const factory = input.factoryMap.get(node.id);
  const projectionIssues = input.adoptedIssueMap?.byNodeId.get(node.id);
  const projectionIssueReason = projectionIssues?.map((issue) =>
    `${issue.identityKey}${issue.propertyName ? `/${issue.propertyName}` : ''}: ${issue.reason}`,
  ).join(' ');
  const adoptedTemplateTypeReason = adoptedTemplateTypeGuardReason(node, input.adoptedTemplateTypeGuard);
  const linkedPackage = linkedPackageForRegistrationNode(node, input.linkedPackages);
  const protectedFormRegistrationReason = input.preserveAdoptedFormDeletes && isAdoptedFormRegistration(node)
    && (node.status === 'leftOnly' || node.status === 'rightOnly' && !linkedPackage)
    ? 'Новая Form требует доказанного полного own package; target-side Form registration и package автоматически не удаляются.'
    : undefined;
  const rightsScope = input.preparedRights ? adoptedRightsDeclarationScope(node) : undefined;
  const rightsScopeReason = rightsScope?.reason;
  const enabled = input.input.allowed && !projectionIssues?.length && !adoptedTemplateTypeReason
    && !protectedFormRegistrationReason && !rightsScopeReason && Boolean(factory) && node.mergeable === true;
  if (enabled && factory) {
    const dependency = selectionDependency(node, input.input.linkedDesignerContext);
    const candidateUuid = adoptedCandidateUuid(node);
    const registryWitnesses = candidateUuid && input.adoptedArtifact
      ? input.adoptedArtifact.uuidCandidateWitnesses.get(candidateUuid)
      : undefined;
    const candidateFactory = withRegistryCandidateWitnesses(
      withRootConfigurationWitnesses(factory, input.input.input.target, input.input.input.incoming),
      registryWitnesses ?? [],
    );
    const dependencyWitnesses = dedupeSemanticWitnesses([
      ...dependency.witnesses,
      ...(input.dependencyWitnesses ?? []),
    ]);
    input.input.selections.set(node.id, {
      nodeId: node.id,
      rowId: input.input.row.id,
      kind: input.input.kind,
      targetRelativePath: input.input.targetRelativePath,
      sourceRelativePath: input.input.sourceRelativePath,
      targetHash: input.input.targetHash!,
      sourceHash: input.input.sourceHash!,
      candidateFactory,
      ...(linkedPackage ? { linkedPackageId: linkedPackage.packageId } : {}),
      ...(dependency.requiredPackageId ? { requiredPackageId: dependency.requiredPackageId } : {}),
      ...(dependency.targetFormComplete !== undefined ? { targetFormComplete: dependency.targetFormComplete } : {}),
      ...(dependencyWitnesses.length ? { dependencyWitnesses } : {}),
      ...(input.adoptedArtifact ? { adoptedArtifact: input.adoptedArtifact } : {}),
      ...(input.preparedRights ? { adoptedRights: input.preparedRights.recipe } : {}),
      ...(rightsScope?.references.length ? { requiredCfeDeclarationReferences: rightsScope.references } : {}),
      ...(input.adoptedOwnForm ? { adoptedOwnForm: input.adoptedOwnForm } : {}),
    });
  }
  const children = node.children.map((child) => projectAdapterNode({ ...input, node: child }));
  return {
    ...node,
    ...(!input.input.allowed
      ? {
        mergeable: false,
        conflict: { kind: 'unsupported' as const, blocking: true, message: input.input.readonlyReason ?? 'Для этого направления переноса XML-слияние недоступно.' },
        mergeState: { state: 'blocked' as const, reason: input.input.readonlyReason ?? 'Для этого направления переноса XML-слияние недоступно.' },
      }
      : {}),
    ...(projectionIssueReason ? {
      mergeable: false,
      conflict: { kind: 'unsupported' as const, blocking: true, message: projectionIssueReason },
      mergeState: { state: 'blocked' as const, reason: projectionIssueReason, targetFilePath: input.input.targetRelativePath },
    } : {}),
    ...(adoptedTemplateTypeReason ? {
      mergeable: false,
      conflict: { kind: 'unsupported' as const, blocking: true, message: adoptedTemplateTypeReason },
      mergeState: {
        state: 'blocked' as const,
        reason: adoptedTemplateTypeReason,
        targetFilePath: node.mergeState?.targetFilePath ?? input.input.adoptedArtifact?.targetFilePath ?? input.input.targetRelativePath,
      },
    } : {}),
    ...(protectedFormRegistrationReason ? {
      mergeable: false,
      conflict: { kind: 'unsupported' as const, blocking: true, message: protectedFormRegistrationReason },
      mergeState: { state: 'blocked' as const, reason: protectedFormRegistrationReason },
    } : {}),
    ...(rightsScopeReason ? {
      mergeable: false,
      conflict: { kind: 'unsupported' as const, blocking: true, message: rightsScopeReason },
      mergeState: { state: 'blocked' as const, reason: rightsScopeReason, targetFilePath: input.input.targetRelativePath },
    } : {}),
    children,
  };
}

function isAdoptedFormRegistration(node: CompareTreeNode): boolean {
  return node.kind === 'xmlElement' && node.label.startsWith('Форма:');
}

function adoptedProjectionIssueNode(
  row: ExtensionTransferRow,
  kind: ExtensionSemanticSelection['kind'],
  relativePath: string,
  issue: ExtensionAdoptedPreparedArtifact['issues'][number],
): CompareTreeNode {
  const reason = `${issue.identityKey}${issue.propertyName ? `/${issue.propertyName}` : ''}: ${issue.reason}`;
  return {
    id: `extension:adopted-issue:${row.id}:${kind}:${encodeURIComponent(relativePath)}:${encodeURIComponent(issue.identityKey)}:${encodeURIComponent(issue.propertyName ?? '')}`,
    label: 'Непроецируемый элемент adopted Designer',
    kind: 'extensionSemanticFile',
    status: 'changed',
    mergeable: false,
    conflict: { kind: 'unsupported', blocking: true, message: reason },
    mergeState: { state: 'blocked', reason, targetFilePath: relativePath },
    children: [],
  };
}

function adoptedIssuesOnlyNode(
  row: ExtensionTransferRow,
  kind: ExtensionSemanticSelection['kind'],
  relativePath: string,
  issues: ExtensionAdoptedPreparedArtifact['issues'],
): CompareTreeNode {
  const firstReason = issues[0]?.reason ?? 'Элемент adopted Designer не может быть безопасно спроецирован.';
  return {
    id: `extension:adopted-issues:${row.id}:${kind}:${encodeURIComponent(relativePath)}`,
    label: `Непроецируемые изменения: ${relativePath}`,
    kind: 'extensionSemanticFile',
    status: 'changed',
    mergeable: false,
    conflict: { kind: 'unsupported', blocking: true, message: firstReason },
    mergeState: { state: 'blocked', reason: firstReason, targetFilePath: relativePath },
    children: issues.map((issue) => adoptedProjectionIssueNode(row, kind, relativePath, issue)),
  };
}

function rowNode(row: ExtensionTransferRow, children: readonly CompareTreeNode[]): CompareTreeNode {
  return {
    id: row.id,
    label: row.qualifiedName,
    kind: 'extensionMetadataObject',
    status: row.status,
    leftValue: row.target?.descriptorRelativePath,
    rightValue: row.incoming?.descriptorRelativePath,
    mergeable: row.mergeable,
    ...(row.reason ? { conflict: { kind: 'unsupported' as const, message: row.reason, blocking: true } } : {}),
    mergeState: row.mergeable
      ? { state: 'ready', targetFilePath: row.target?.descriptorRelativePath ?? row.incoming?.descriptorRelativePath }
      : { state: 'blocked', reason: row.reason ?? 'Объект не отличается или перенос не предусмотрен.' },
    children: [...children],
  };
}

function adoptedBlockerNode(row: ExtensionTransferRow, blocker: import('./extensionAdoptedSemanticHost').ExtensionAdoptedScopedBlocker): CompareTreeNode {
  const targetFilePath = blocker.targetRelativePath || row.target?.descriptorRelativePath || row.qualifiedName;
  return {
    id: `extension:adopted-blocker:${row.id}:${blocker.kind}:${encodeURIComponent(targetFilePath)}:${encodeURIComponent(blocker.reason)}`,
    label: `Проверка adopted Designer: ${targetFilePath}`,
    kind: 'extensionSemanticFile',
    status: 'changed',
    mergeable: false,
    conflict: { kind: 'unsupported', message: blocker.reason, blocking: true },
    mergeState: { state: 'blocked', reason: blocker.reason, targetFilePath },
    children: [],
  };
}

function semanticSelectionReason(row: ExtensionTransferRow): string | undefined {
  const targetIdentity = row.target?.identity;
  const incomingIdentity = row.incoming?.identity;
  if (row.semanticAction === 'adopted-cfe-semantic') {
    return 'Для CFE→CFE adopted semantics требуется отдельная захваченная host projection.';
  }
  if ((row.targetRoot.rootKind === 'cf' && row.incomingRoot.rootKind === 'cfe'
      || row.targetRoot.rootKind === 'cfe' && row.incomingRoot.rootKind === 'cf')
      && (targetIdentity?.ownership === 'adopted' || incomingIdentity?.ownership === 'adopted')) {
    return 'Глубокое слияние форм adopted-объекта между CF и CFE пока не поддерживается.';
  }
  if (!row.target || !row.incoming || !row.mergeable) {
    return row.reason ?? 'Семантические XML-изменения доступны только для сопоставленных изменённых объектов.';
  }
  const ownMatch = row.action === 'full-copy'
    && targetIdentity?.ownership === 'own'
    && incomingIdentity?.ownership === 'own'
    && targetIdentity.type === incomingIdentity.type
    && targetIdentity.uuid.toLowerCase() === incomingIdentity.uuid.toLowerCase();
  const adoptedMatch = row.action === 'adopted-cfe-copy'
    && targetIdentity?.ownership === 'adopted'
    && incomingIdentity?.ownership === 'adopted'
    && row.sameProvenBase === true
    && targetIdentity.type === incomingIdentity.type
    && targetIdentity.sourceUuid?.toLowerCase() === incomingIdentity.sourceUuid?.toLowerCase();
  if (ownMatch || adoptedMatch) {return undefined;}
  return row.reason ?? 'Семантическое XML-слияние доступно только для совпавших собственных объектов и adopted-объектов с доказанной общей базой.';
}

function templateMetadataUnit(
  rootPath: string,
  relativePath: string,
  qualifiedName: string,
  metadataType: 'Template' | 'CommonTemplate',
  uuid: string,
): MetadataObjectUnit {
  const descriptorPath = path.join(rootPath, relativePath);
  return {
    objectId: `${metadataType}:${qualifiedName.normalize('NFC').toLocaleLowerCase('en-US')}:${uuid.toLocaleLowerCase('en-US')}`,
    qualifiedName,
    metadataType,
    uuid,
    descriptorPath,
    containerPath: path.dirname(descriptorPath),
  };
}

function templateTransitionBlockerNode(candidate: import('../linkedDesignerTypes').LinkedTemplateTypeTransitionCandidate): CompareTreeNode {
  const reason = candidate.reason ?? 'Не удалось связать TemplateType с обязательным телом макета.';
  return {
    id: candidate.transitionId,
    label: `Тип макета и содержимое: ${candidate.targetTemplateType ?? '?'} → ${candidate.incomingTemplateType ?? '?'}`,
    kind: 'linkedTemplateTypeTransition',
    status: 'changed',
    leftValue: candidate.targetTemplateType,
    rightValue: candidate.incomingTemplateType,
    mergeable: false,
    payloadRef: `linkedTemplateType:${candidate.transitionId}`,
    conflict: { kind: 'unsupported', blocking: true, message: reason },
    mergeState: { state: 'blocked', reason, targetFilePath: candidate.targetDescriptorRelativePath },
    children: [],
  };
}

function inventoryObject(inventory: ConfigurationInventory, object: ExtensionIndexedObject): MetadataObjectUnit | undefined {
  const idPrefix = `${object.sourceId}:${object.qualifiedName.toLowerCase()}:`;
  return inventory.objects.find((unit) => unit.objectId.startsWith(idPrefix));
}

async function captureXmlArtifact(root: string, relativePath: string, expectedHash: string): Promise<Buffer | undefined> {
  try {
    const snapshot = await captureMergePath(path.join(root, relativePath), { retainContent: true });
    if (snapshot.state !== 'file' || snapshot.hash !== expectedHash || snapshot.contentBase64 === undefined) {return undefined;}
    return Buffer.from(snapshot.contentBase64, 'base64');
  } catch {
    return undefined;
  }
}

function projectReadDiagnostic(row: ExtensionTransferRow, relativePath: string): CompareMessage {
  return {
    severity: 'error', code: 'EXTENSION_SEMANTIC_XML_UNAVAILABLE', phase: 'compare',
    sourceId: row.incoming?.sourceId ?? row.incomingRoot.sourceId,
    path: relativePath, nodeId: row.id, blocking: true,
    suggestedAction: `Не удалось подтвердить байты XML для семантического сравнения: ${relativePath}`,
  };
}

function semanticReadDiagnostic(row: ExtensionTransferRow, relativePath: string): CompareMessage {
  return projectReadDiagnostic(row, relativePath);
}

function collectMergeableIds(node: CompareTreeNode): string[] {
  return [
    ...(node.mergeable === true ? [node.id] : []),
    ...node.children.flatMap(collectMergeableIds),
  ];
}

function isUnscopedAdoptedTemplatePackageDiagnostic(diagnostic: CompareMessage, rowId: string): boolean {
  if (diagnostic.nodeId !== rowId) {return false;}
  const message = diagnostic.suggestedAction ?? '';
  return /^(?:Дескриптор|Пакет) (?:Template|Command) /u.test(message)
    || /^В target уже есть файлы незарегистрированного пакета (?:Template|Command) /u.test(message);
}
