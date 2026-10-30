import * as path from 'path';

import type { CompareMessage } from '../domain/compareContracts';
import type { CompareSession } from '../domain/compareSession';
import type { CompareTreeNode, CompareTreeStatus } from '../compareTreeTypes';
import { throwIfCompareCancelled, type CompareCancellationToken } from '../compareCancellation';
import type { AdapterCompareInput, ArtifactUnit, ConfigurationInventory, ExecutableCandidateFactory, MergeAdapter, MetadataObjectUnit } from '../adapters/mergeAdapter';
import { metadataXmlAdapter } from '../adapters/xmlMetadataAdapter';
import { formXmlAdapter } from '../adapters/formXmlAdapter';
import { predefinedXmlAdapter } from '../adapters/predefinedXmlAdapter';
import { roleRightsXmlAdapter } from '../adapters/roleRightsXmlAdapter';
import { dcsXmlAdapter } from '../adapters/dcsXmlAdapter';
import { captureMergePath } from '../merge/mergeSnapshot';
import { replaceRootUuid } from './extensionXmlOverlay';
import type { ExtensionIndexedObject, ExtensionMetadataIndex } from './extensionMetadataIndex';
import type { ExtensionSemanticSelection, ExtensionTransferRow } from './extensionTransfer';
import { projectExtensionRootPurpose } from './extensionRootPurpose';
import { indexExtensionLinkedDesignerPackages, linkedPackageForRegistrationNode, type ExtensionLinkedDesignerPackage } from './extensionLinkedDesignerPackages';
import { collectExtensionEventDependencies, projectExtensionFormEventHandlers, type ExtensionLinkedRoutineSelection } from './extensionLinkedDesignerBsl';
import { bindExtensionLinkedTemplateTransition, captureExtensionLinkedTemplateTransitions } from './extensionLinkedTemplateTransitions';
import {
  createExtensionAdoptedUuidSnapshot,
  prepareExtensionAdoptedSemanticRow,
  type ExtensionAdoptedPreparedArtifact,
} from './extensionAdoptedSemanticHost';
import { adoptedTemplateTypeGuardReason, createAdoptedTemplateTypeGuard, type AdoptedTemplateTypeGuard } from './extensionAdoptedTemplateTypeGuard';
import type { LinkedEventDependency, LinkedFormModuleSnapshot } from '../linkedDesignerTypes';
import { LINKED_FORM_REFERENCE_PROPERTIES } from '../linkedDesignerUtils';
import { parseXmlDocument, textContent } from '../xml/xmlDom';
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
  ownerRelativePath,
  pairedXmlSidecars,
} from './extensionSemanticSidecars';

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
  const targetInventory = toInventory(input.target);
  const incomingInventory = toInventory(input.incoming);
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
    const adoptedPreparation = await prepareExtensionAdoptedSemanticRow({
      row,
      targetRoot: input.target,
      incomingRoot: input.incoming,
      uuidSnapshot: adoptedUuidSnapshot,
    });
    const hasAdoptedProjection = adoptedPreparation.applicable;
    const linkedTemplateTransitions = hasAdoptedProjection
      ? []
      : await captureExtensionLinkedTemplateTransitions({ row, targetRoot: input.target, incomingRoot: input.incoming });
    const ordinaryReadonlyReason = hasAdoptedProjection ? undefined : semanticSelectionReason(row);
    const adoptedReadonlyReason = hasAdoptedProjection && !row.semanticAction && (!row.mergeable || row.reason)
      ? row.reason ?? 'Объект недоступен для семантического переноса.'
      : undefined;
    const allowed = hasAdoptedProjection
      ? adoptedReadonlyReason === undefined
      : ordinaryReadonlyReason === undefined;
    const readonlyReason = hasAdoptedProjection ? adoptedReadonlyReason : ordinaryReadonlyReason;
    const childNodes: CompareTreeNode[] = [];
    const linkedIndex = await indexExtensionLinkedDesignerPackages({ row, target: input.target, incoming: input.incoming });
    diagnostics.push(...linkedIndex.diagnostics);
    for (const recipe of linkedIndex.packages) {linkedDesignerPackages.set(recipe.packageId, recipe);}
    const adoptedDescriptor = hasAdoptedProjection
      ? adoptedPreparation.artifacts.find((artifact) => artifact.kind === 'metadataXml')
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
      linkedDesignerContext: linkedIndex.capabilities,
      linkedPackages: linkedIndex.packages,
      ...(adoptedDescriptor ? { adoptedArtifact: adoptedDescriptor } : {}),
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

    const paired = pairedXmlSidecars(row.target, row.incoming);
    const adoptedRoleRights = hasAdoptedRoleIdentity(row)
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
    for (const pair of paired.pairs.filter((candidate) => !(hasAdoptedProjection && candidate.kind === 'formXml')
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
      for (const artifact of adoptedPreparation.artifacts.filter((candidate) => candidate.kind === 'formXml')) {
        throwIfCompareCancelled(input.cancellation);
        const eventProjection = await projectExtensionFormEventHandlers({
          row,
          targetRoot: input.target,
          incomingRoot: input.incoming,
          targetOwner: row.target,
          incomingOwner: row.incoming,
          targetFormPath: artifact.targetRelativePath,
          sourceFormPath: artifact.sourceRelativePath,
          targetFormXml: artifact.targetXml,
          sourceFormXml: artifact.sourceXml,
          rightSnapshotId: input.rightSnapshotId,
        });
        diagnostics.push(...eventProjection.diagnostics);
        eventProjection.routineSelections.forEach((selection, id) => linkedRoutineSelections.set(id, selection));
        if (eventProjection.module) {linkedFormModules.push(eventProjection.module);}
        const node = await compareArtifact({
          input,
          targetInventory,
          incomingInventory,
          targetObject: row.target,
          incomingObject: row.incoming,
          kind: 'formXml',
          targetRelativePath: artifact.targetRelativePath,
          sourceRelativePath: artifact.sourceRelativePath,
          targetHash: artifact.targetHash,
          sourceHash: artifact.sourceHash,
          adapter: formXmlAdapter,
          label: `Форма: ${path.posix.dirname(artifact.targetRelativePath)}`,
          row,
          allowed,
          readonlyReason,
          linkedDesignerContext: { registrations: [], defaultObjectForms: [], formEventHandlers: eventProjection.context },
          adoptedArtifact: artifact,
          selections,
          diagnostics,
        });
        throwIfCompareCancelled(input.cancellation);
        if (node) {childNodes.push(node);}
        if (node && eventProjection.module) {
          collectExtensionEventDependencies({
            nodes: node.children,
            capabilities: eventProjection.context,
            module: eventProjection.module,
            output: linkedEventDependencies,
          });
        }
        childNodes.push(...eventProjection.routineNodes);
      }
      for (const blocker of adoptedPreparation.blockers) {
        childNodes.push(adoptedBlockerNode(row, blocker));
      }
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
  adoptedArtifact?: ExtensionAdoptedPreparedArtifact;
  selections: Map<string, ExtensionSemanticSelection>;
  diagnostics: CompareMessage[];
}): Promise<CompareTreeNode | undefined> {
  const targetRoot = input.input.target.canonicalRootPath ?? input.input.target.rootPath;
  const sourceRoot = input.input.incoming.canonicalRootPath ?? input.input.incoming.rootPath;
  if (!input.adoptedArtifact && (!input.targetHash || !input.sourceHash)) {
    return undefined;
  }
  if (!input.adoptedArtifact && input.targetHash === input.sourceHash) {return undefined;}
  if (input.adoptedArtifact
      && (input.targetRelativePath !== input.adoptedArtifact.targetRelativePath
        || input.sourceRelativePath !== input.adoptedArtifact.sourceRelativePath
        || input.kind !== input.adoptedArtifact.kind)) {
    input.diagnostics.push(semanticReadDiagnostic(input.row, input.sourceRelativePath));
    return undefined;
  }
  const [target, source] = input.adoptedArtifact
    ? [Buffer.from(input.adoptedArtifact.targetXml), Buffer.from(input.adoptedArtifact.sourceXml)]
    : await Promise.all([
      captureXmlArtifact(targetRoot, input.targetRelativePath, input.targetHash!),
      captureXmlArtifact(sourceRoot, input.sourceRelativePath, input.sourceHash!),
    ]);
  if (!target || !source) {
    input.diagnostics.push(semanticReadDiagnostic(input.row, input.sourceRelativePath));
    return undefined;
  }
  if (input.adoptedArtifact && target.equals(source)) {
    return input.adoptedArtifact.issues.length === 0
      ? undefined
      : adoptedIssuesOnlyNode(input.row, input.kind, input.targetRelativePath, input.adoptedArtifact.issues);
  }
  let sourceText = source.toString('utf8');
  const normalizeAdoptedRoot = input.kind === 'metadataXml'
    && input.row.action === 'adopted-cfe-copy'
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
    semanticContextWitnesses: input.adoptedArtifact
      ? [...metadataContext.contextWitnesses, ...input.adoptedArtifact.recipe.requiredWitnesses, ...input.adoptedArtifact.dependencyWitnesses]
      : metadataContext.contextWitnesses,
    linkedDesignerContext: input.linkedDesignerContext,
    ...(input.adoptedArtifact ? { allowMetadataChildOrder: false, allowFormSectionOrder: false } : {}),
    snapshots: { left: target.toString('utf8'), right: sourceText },
  };
  const result = await input.adapter.compare(compareInput);
  input.diagnostics.push(...result.diagnostics);
  if (result.nodes.length === 0) {
    const blocker = result.diagnostics.find((item) => item.blocking);
    const issues = input.adoptedArtifact?.issues ?? [];
    if (!blocker && issues.length === 0) {return undefined;}
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

  const adoptedIssueMap = input.adoptedArtifact ? mapAdoptedIssuesToNodes(result.nodes, result.candidateFactories, input.adoptedArtifact.issues) : undefined;
  const adoptedTemplateTypeRoute = input.kind === 'metadataXml'
    && (input.adoptedArtifact?.kind === 'metadataXml'
      || (input.row.action === 'adopted-cfe-copy'
        && input.row.sameProvenBase === true
        && input.targetObject.identity?.ownership === 'adopted'
        && input.incomingObject.identity?.ownership === 'adopted'
        && input.row.targetRoot.rootKind === 'cfe'
        && input.row.incomingRoot.rootKind === 'cfe'));
  const adoptedTemplateTypeGuard = adoptedTemplateTypeRoute
    ? createAdoptedTemplateTypeGuard(target.toString('utf8'), sourceText)
    : undefined;
  const contents = result.nodes.map((node) => projectAdapterNode({
    node,
    factoryMap: result.candidateFactories,
    input,
    linkedPackages: input.linkedPackages ?? [],
    ...(adoptedTemplateTypeGuard ? { adoptedTemplateTypeGuard } : {}),
    ...(input.adoptedArtifact ? { adoptedArtifact: input.adoptedArtifact } : {}),
    ...(adoptedIssueMap ? { adoptedIssueMap } : {}),
  }));
  if (adoptedIssueMap) {
    for (const issue of adoptedIssueMap.unmatched) {
      contents.push(adoptedProjectionIssueNode(input.row, input.kind, input.targetRelativePath, issue));
    }
  }
  const status: CompareTreeStatus = contents.some((node) => node.status !== 'equal') ? 'changed' : 'equal';
  return {
    id: `extension:xml:${input.row.id}:${input.kind}:${encodeURIComponent(input.targetRelativePath)}`,
    label: input.label,
    kind: 'extensionSemanticFile',
    status,
    ...(input.allowed ? {} : { mergeable: false, mergeState: { state: 'blocked', reason: input.readonlyReason ?? 'Для этого направления переноса XML-слияние недоступно.' } as const }),
    children: contents,
  };
}

function projectAdapterNode(input: {
  node: CompareTreeNode;
  factoryMap: ReadonlyMap<string, ExecutableCandidateFactory>;
  input: Parameters<typeof compareArtifact>[0];
  linkedPackages: readonly ExtensionLinkedDesignerPackage[];
  adoptedTemplateTypeGuard?: AdoptedTemplateTypeGuard;
  adoptedArtifact?: ExtensionAdoptedPreparedArtifact;
  adoptedIssueMap?: AdoptedIssueNodeMap;
}): CompareTreeNode {
  const node = input.node;
  const factory = input.factoryMap.get(node.id);
  const projectionIssues = input.adoptedIssueMap?.byNodeId.get(node.id);
  const projectionIssueReason = projectionIssues?.map((issue) =>
    `${issue.identityKey}${issue.propertyName ? `/${issue.propertyName}` : ''}: ${issue.reason}`,
  ).join(' ');
  const adoptedTemplateTypeReason = adoptedTemplateTypeGuardReason(node, input.adoptedTemplateTypeGuard);
  const enabled = input.input.allowed && !projectionIssues?.length && !adoptedTemplateTypeReason && Boolean(factory) && node.mergeable === true;
  if (enabled && factory) {
    const linkedPackage = linkedPackageForRegistrationNode(node, input.linkedPackages);
    const dependency = selectionDependency(node, input.input.linkedDesignerContext);
    const candidateUuid = adoptedCandidateUuid(node);
    const registryWitnesses = candidateUuid && input.adoptedArtifact
      ? input.adoptedArtifact.uuidCandidateWitnesses.get(candidateUuid)
      : undefined;
    const candidateFactory = withRegistryCandidateWitnesses(
      withRootConfigurationWitnesses(factory, input.input.input.target, input.input.input.incoming),
      registryWitnesses ?? [],
    );
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
      ...(dependency.witnesses.length ? { dependencyWitnesses: dependency.witnesses } : {}),
      ...(input.adoptedArtifact ? { adoptedArtifact: input.adoptedArtifact } : {}),
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
    children,
  };
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

function selectionDependency(
  node: CompareTreeNode,
  context: AdapterCompareInput['linkedDesignerContext'],
): { requiredPackageId?: string; targetFormComplete?: boolean; witnesses: import('../merge/mergePreview').MergeFileWitness[] } {
  const payload = node.payloadRef ?? '';
  const decoded = payload.split('/').map((segment) => {
    try {return decodeURIComponent(segment);} catch {return segment;}
  });
  const propertyName = LINKED_FORM_REFERENCE_PROPERTIES.find((name) => decoded.some((part) => part === name || part.startsWith(`${name}[`)));
  if (propertyName) {
    const value = node.rightValue?.trim() ?? '';
    const capability = context?.defaultObjectForms.find((item) => item.propertyName === propertyName && item.value.trim() === value);
    if (!capability || !value) {return { witnesses: [] };}
    return {
      ...(capability.packageId && !capability.targetFormComplete ? { requiredPackageId: capability.packageId } : {}),
      targetFormComplete: capability.targetFormComplete,
      witnesses: [...(capability.targetWitnesses ?? [])],
    };
  }
  if (/(?:^|%2F|\/)Event(?:%5B|\[)/iu.test(payload)) {
    const handler = eventHandlerName(node.rightValue?.trim() ?? '');
    const capability = handler ? context?.formEventHandlers.find((item) => item.name.trim() === handler) : undefined;
    return { witnesses: [...(capability?.targetWitnesses ?? [])] };
  }
  return { witnesses: [] };
}

function eventHandlerName(value: string): string | undefined {
  if (!value) {return undefined;}
  try {
    const root = parseXmlDocument(value).root;
    return root.localName === 'Event' ? textContent(root).trim() || undefined : undefined;
  } catch {
    return value.startsWith('<') ? undefined : value;
  }
}

function withRootConfigurationWitnesses(
  factory: ExecutableCandidateFactory,
  target: ExtensionMetadataIndex,
  incoming: ExtensionMetadataIndex,
): ExecutableCandidateFactory {
  return async () => {
    const result = await factory();
    if (!result.ok || !result.candidate.xmlPatch) {return result;}
    const witnesses = (result.candidate.xmlPatch.sourceWitnesses ?? []).filter((witness) =>
      !((witness.sourceId === target.sourceId || witness.sourceId === incoming.sourceId)
        && witness.relativePath.replace(/\\/gu, '/') === 'Configuration.xml'));
    if (target.configurationHash) {
      witnesses.push({ sourceId: target.sourceId, relativePath: 'Configuration.xml', expectedHash: target.configurationHash, kind: 'file' });
    }
    if (incoming.configurationHash) {
      witnesses.push({ sourceId: incoming.sourceId, relativePath: 'Configuration.xml', expectedHash: incoming.configurationHash, kind: 'file' });
    }
    return {
      ok: true,
      candidate: {
        ...result.candidate,
        xmlPatch: { ...result.candidate.xmlPatch, sourceWitnesses: witnesses },
      },
    };
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

function toInventory(index: ExtensionMetadataIndex): ConfigurationInventory {
  const root = index.canonicalRootPath ?? index.rootPath;
  const objects: MetadataObjectUnit[] = [];
  const artifactsByObjectId = new Map<string, ArtifactUnit[]>();
  for (const object of index.objects) {
    if (!object.descriptorRelativePath) {continue;}
    const unit = toObjectUnit(root, object);
    objects.push(unit);
    const artifacts: ArtifactUnit[] = [];
    if (object.descriptorHash) {
      artifacts.push({
        artifactId: `${unit.objectId}:descriptor`, ownerObjectId: unit.objectId, kind: 'metadataXml',
        relativePath: object.descriptorRelativePath, filePath: unit.descriptorPath,
        contentHash: object.descriptorHash, mergeMode: 'xmlPatch',
      });
    }
    for (const file of object.sidecarFiles) {
      const relative = ownerRelativePath(object, file.relativePath);
      const baseName = path.posix.basename(relative.replace(/\\/gu, '/')).toLowerCase();
      const kind = baseName === 'form.xml' ? 'formXml'
        : baseName === 'predefined.xml' ? 'predefinedXml'
          : baseName === 'rights.xml' && file.rootExpandedName === '{http://v8.1c.ru/8.2/roles}Rights' ? 'roleRightsXml'
            : baseName === 'template.xml' && file.rootExpandedName === '{http://v8.1c.ru/8.1/data-composition-system/schema}DataCompositionSchema' ? 'dcsXml'
              : undefined;
      if (!kind) {continue;}
      artifacts.push({
        artifactId: `${unit.objectId}:${normalizeArtifactPath(file.relativePath)}`, ownerObjectId: unit.objectId,
        kind, relativePath: file.relativePath, filePath: path.join(root, file.relativePath),
        contentHash: file.hash, mergeMode: 'xmlPatch',
      });
    }
    artifactsByObjectId.set(unit.objectId, artifacts);
  }
  return { rootPath: root, objects, artifactsByObjectId };
}

function toObjectUnit(root: string, object: ExtensionIndexedObject): MetadataObjectUnit {
  const descriptorPath = path.join(root, object.descriptorRelativePath!);
  const containerPath = object.sidecarRelativePath
    ? path.join(root, object.sidecarRelativePath)
    : path.dirname(descriptorPath);
  return {
    objectId: `${object.sourceId}:${object.qualifiedName.toLowerCase()}:${object.identity?.uuid.toLowerCase() ?? 'invalid'}`,
    qualifiedName: object.qualifiedName,
    metadataType: object.metadataType,
    ...(object.identity?.uuid ? { uuid: object.identity.uuid } : {}),
    descriptorPath,
    containerPath,
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
