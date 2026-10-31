import * as path from 'path';
import { pathToFileURL } from 'url';

import type { CompareTreeNode } from '../compareTreeTypes';
import type { ExecutableCandidateFactory, MetadataObjectUnit } from '../adapters/mergeAdapter';
import type { MergeFileWitness } from '../merge/mergePreview';
import { parseXmlAddressPointer, type XmlAddressSegment } from '../xml/xmlAddress';
import type { ExtensionSemanticSelection, ExtensionTransferRow } from './extensionTransfer';
import type {
  ExtensionAdoptedPreparedTemplateArtifact,
  ExtensionAdoptedTemplateBlocker,
} from './extensionAdoptedTemplateHost';
import type { AdoptedDescriptorArtifactRecipe } from './extensionAdoptedSemanticBridge';

export interface ExtensionAdoptedTemplateBindResult {
  readonly nodes: readonly CompareTreeNode[];
  readonly bundleNode: CompareTreeNode;
  readonly reason?: string;
}

/** Routes adapter descriptor nodes through the exact captured Template bundle binding. */
export function projectAdoptedTemplateCompareResult(input: {
  readonly nodes: readonly CompareTreeNode[];
  readonly projectNode: (node: CompareTreeNode) => CompareTreeNode;
  readonly appendUnmatchedIssues?: (nodes: CompareTreeNode[]) => void;
  readonly selections: Map<string, ExtensionSemanticSelection>;
  readonly candidateFactories?: ReadonlyMap<string, ExecutableCandidateFactory>;
  readonly artifact?: ExtensionAdoptedPreparedTemplateArtifact;
  readonly rowId: string;
  readonly sourceId: string;
  readonly rightSnapshotId: string;
  readonly targetRootPath: string;
  readonly sourceRootPath: string;
  readonly allowed: boolean;
  readonly readonlyReason?: string;
}): CompareTreeNode[] {
  const contents = input.nodes.map(input.projectNode);
  input.appendUnmatchedIssues?.(contents);
  if (!input.artifact) { return contents; }
  return [...bindExtensionAdoptedTemplateBundle({
    nodes: contents,
    selections: input.selections,
    candidateFactories: input.candidateFactories,
    artifact: input.artifact,
    rowId: input.rowId,
    sourceId: input.sourceId,
    rightSnapshotId: input.rightSnapshotId,
    targetRootPath: input.targetRootPath,
    sourceRootPath: input.sourceRootPath,
    allowed: input.allowed,
    readonlyReason: input.readonlyReason,
  }).nodes];
}

/** Produces a body-only file row when the captured descriptor is unchanged. */
export function createAdoptedTemplateBodyOnlyResultNode(input: {
  readonly rowId: string;
  readonly label: string;
  readonly kind: ExtensionSemanticSelection['kind'];
  readonly targetRelativePath: string;
  readonly artifact: ExtensionAdoptedPreparedTemplateArtifact;
  readonly selections: Map<string, ExtensionSemanticSelection>;
  readonly candidateFactories?: ReadonlyMap<string, ExecutableCandidateFactory>;
  readonly sourceId: string;
  readonly rightSnapshotId: string;
  readonly targetRootPath: string;
  readonly sourceRootPath: string;
  readonly allowed: boolean;
  readonly readonlyReason?: string;
}): CompareTreeNode | undefined {
  if (!input.artifact.bodyEffect) { return undefined; }
  const nodes = projectAdoptedTemplateCompareResult({
    nodes: [],
    projectNode: (node) => node,
    selections: input.selections,
    candidateFactories: input.candidateFactories,
    artifact: input.artifact,
    rowId: input.rowId,
    sourceId: input.sourceId,
    rightSnapshotId: input.rightSnapshotId,
    targetRootPath: input.targetRootPath,
    sourceRootPath: input.sourceRootPath,
    allowed: input.allowed,
    readonlyReason: input.readonlyReason,
  });
  return {
    id: `extension:xml:${input.rowId}:${input.kind}:${encodeURIComponent(input.targetRelativePath)}`,
    label: input.label,
    kind: 'extensionSemanticFile',
    status: 'changed',
    ...(input.allowed ? {} : { mergeable: false, mergeState: { state: 'blocked' as const, reason: input.readonlyReason } }),
    children: nodes,
  };
}

export async function appendExtensionAdoptedTemplateNodes(input: {
  readonly row: ExtensionTransferRow;
  readonly artifacts: readonly ExtensionAdoptedPreparedTemplateArtifact[];
  readonly blockers: readonly ExtensionAdoptedTemplateBlocker[];
  readonly targetRootPath: string;
  readonly sourceRootPath: string;
  readonly compare: (artifact: ExtensionAdoptedPreparedTemplateArtifact, target: MetadataObjectUnit, source: MetadataObjectUnit) => Promise<CompareTreeNode | undefined>;
}): Promise<CompareTreeNode[]> {
  const nodes: CompareTreeNode[] = [];
  for (const artifact of input.artifacts) {
    if (artifact.metadataType !== 'Template') { continue; }
    const targetIdentity = artifact.recipe.targetDescriptor.identity;
    const sourceIdentity = artifact.recipe.sourceDescriptor.identity;
    const target = templateUnit(input.targetRootPath, artifact.targetRelativePath, artifact.qualifiedName,
      artifact.metadataType, targetIdentity.uuid);
    const source = templateUnit(input.sourceRootPath, artifact.sourceRelativePath, artifact.qualifiedName,
      artifact.metadataType, sourceIdentity.uuid);
    const node = await input.compare(artifact, target, source);
    if (node) { nodes.push(node); }
  }
  for (const blocker of input.blockers) {
    const targetPath = blocker.targetRelativePath || input.row.target?.descriptorRelativePath || input.row.qualifiedName;
    nodes.push({
      id: `extension:adopted-template-blocker:${input.row.id}:${encodeURIComponent(targetPath)}:${encodeURIComponent(blocker.reason)}`,
      label: `Проверка adopted макета: ${targetPath}`,
      kind: 'extensionSemanticFile',
      status: 'changed',
      mergeable: false,
      conflict: { kind: 'unsupported', blocking: true, message: blocker.reason },
      mergeState: { state: 'blocked', reason: blocker.reason, targetFilePath: targetPath },
      children: [],
    });
  }
  return nodes;
}

/** Replaces a proven TemplateType leaf with one atomic descriptor/body selection. */
export function bindExtensionAdoptedTemplateBundle(input: {
  readonly nodes: readonly CompareTreeNode[];
  readonly selections: Map<string, ExtensionSemanticSelection>;
  /** Raw adapter factories are supplied before `projectAdapterNode` applies the type guard. */
  readonly candidateFactories?: ReadonlyMap<string, ExecutableCandidateFactory>;
  readonly artifact: ExtensionAdoptedPreparedTemplateArtifact;
  readonly rowId: string;
  readonly sourceId: string;
  readonly rightSnapshotId: string;
  readonly targetRootPath: string;
  readonly sourceRootPath: string;
  readonly allowed: boolean;
  readonly readonlyReason?: string;
}): ExtensionAdoptedTemplateBindResult {
  const descriptorPath = path.resolve(input.targetRootPath, input.artifact.targetRelativePath);
  const scalarNodes = collectNodes(input.nodes).filter((node) => node.kind === 'xmlProperty'
    && node.label === 'TemplateType'
    && sameTargetPath(descriptorPath, node.mergeState?.targetFilePath ?? ''));
  const scalar = scalarNodes.length === 1 ? scalarNodes[0] : undefined;
  const scalarSelection = scalar ? input.selections.get(scalar.id) : undefined;
  const scalarFactory = scalarSelection?.candidateFactory ?? (scalar ? input.candidateFactories?.get(scalar.id) : undefined);
  const typeChanged = input.artifact.recipe.targetTemplateType !== input.artifact.recipe.sourceTemplateType;
  const structuralReason = scalarNodes.length > 1
    ? 'В XML-проекции найдено несколько TemplateType для захваченного descriptor.'
    : typeChanged && !scalar
      ? 'Для изменённого TemplateType не найден единственный XML leaf.'
      : typeChanged && !scalarFactory
        ? 'TemplateType leaf не имеет captured candidate factory.'
        : undefined;
  const reason = structuralReason ?? (!input.allowed
    ? input.readonlyReason ?? 'Перенос Template недоступен для этого направления.'
    : undefined);
  const id = `adopted-template-bundle:${encodeURIComponent(input.artifact.qualifiedName)}`;
  const label = typeChanged ? 'Перенести тип и тело макета' : 'Перенести тело макета';
  const bundleNode: CompareTreeNode = {
    id,
    label,
    kind: 'adoptedTemplateBundle',
    status: 'changed',
    leftValue: input.artifact.recipe.targetTemplateType,
    rightValue: input.artifact.recipe.sourceTemplateType,
    mergeable: reason === undefined,
    payloadRef: `adoptedTemplateBundle:${encodeURIComponent(input.artifact.qualifiedName)}`,
    mergeState: reason
      ? { state: 'blocked', reason, targetFilePath: input.artifact.targetRelativePath }
      : { state: 'ready', targetFilePath: input.artifact.targetRelativePath },
    ...(reason ? { conflict: { kind: 'unsupported', blocking: true, message: reason } } : {}),
    children: scalar ? [{
      ...scalar,
      mergeable: false,
      destructive: undefined,
      conflict: { kind: 'unsupported', blocking: true, message: 'TemplateType переносится только вместе с телом макета.' },
      mergeState: {
        state: 'readOnly',
        reason: 'TemplateType переносится только вместе с телом макета.',
        targetFilePath: input.artifact.targetRelativePath,
      },
    }] : [],
  };

  let nodes = [...input.nodes];
  if (scalar) { nodes = replaceNode(nodes, scalar.id, bundleNode); }
  else if (input.artifact.bodyEffect) { nodes.push(bundleNode); }

  const changedPath = scalar ? addressPath(scalar.payloadRef) : undefined;
  if (changedPath) {
    const blockedIds = new Set(collectNodes(input.nodes).filter((node) => {
      if (node.id === scalar!.id) { return false; }
      const candidatePath = addressPath(node.payloadRef);
      return candidatePath ? pathsOverlap(candidatePath, changedPath) : false;
    }).map((node) => node.id));
    for (const nodeId of blockedIds) { input.selections.delete(nodeId); }
    nodes = disablePatchNodes(nodes, blockedIds, input.artifact.targetRelativePath);
  }
  if (scalar) { input.selections.delete(scalar.id); }

  if (!reason) {
    const candidateFactory = scalarFactory ?? bodyOnlyCandidateFactory({
      sourceId: input.sourceId,
      snapshotId: input.rightSnapshotId,
      nodeId: id,
      targetUri: pathToFileURL(descriptorPath).toString(),
      sourceWitnesses: input.artifact.requiredWitnesses,
    });
    const adoptedArtifact = scalarSelection?.adoptedArtifact ?? createAdoptedTemplateDescriptorArtifact({
      artifact: input.artifact,
      targetRootPath: input.targetRootPath,
      sourceRootPath: input.sourceRootPath,
    });
    const dependencyWitnesses = uniqueWitnesses([
      ...(scalarSelection?.dependencyWitnesses ?? []),
      ...input.artifact.requiredWitnesses,
    ]);
    input.selections.set(id, {
      ...(scalarSelection ?? {
        nodeId: id,
        rowId: input.rowId,
        kind: 'metadataXml' as const,
        targetRelativePath: input.artifact.targetRelativePath,
        sourceRelativePath: input.artifact.sourceRelativePath,
        targetHash: input.artifact.targetHash,
        sourceHash: input.artifact.sourceHash,
        candidateFactory,
      }),
      nodeId: id,
      rowId: input.rowId,
      kind: 'metadataXml',
      targetRelativePath: input.artifact.targetRelativePath,
      sourceRelativePath: input.artifact.sourceRelativePath,
      targetHash: input.artifact.targetHash,
      sourceHash: input.artifact.sourceHash,
      candidateFactory,
      dependencyWitnesses,
      adoptedArtifact,
      adoptedTemplateBundle: input.artifact.recipe,
    });
  }

  return { nodes, bundleNode, ...(reason ? { reason } : {}) };
}

/** Adds the matching adopted descriptor binding to ordinary nested Template scalar selections. */
export function bindAdoptedTemplateDescriptorSelections(input: {
  readonly selections: Map<string, ExtensionSemanticSelection>;
  readonly artifact: ExtensionAdoptedPreparedTemplateArtifact;
  readonly targetRootPath: string;
  readonly sourceRootPath: string;
}): void {
  const adoptedArtifact = createAdoptedTemplateDescriptorArtifact(input);
  for (const [nodeId, selection] of input.selections) {
    if (selection.kind !== 'metadataXml'
        || !samePath(selection.targetRelativePath, input.artifact.targetRelativePath)
        || !samePath(selection.sourceRelativePath, input.artifact.sourceRelativePath)
        || !sameHash(selection.targetHash, input.artifact.targetHash)
        || !sameHash(selection.sourceHash, input.artifact.sourceHash)) { continue; }
    input.selections.set(nodeId, {
      ...selection,
      dependencyWitnesses: uniqueWitnesses([...(selection.dependencyWitnesses ?? []), ...input.artifact.requiredWitnesses]),
      adoptedArtifact,
    });
  }
}

export function createAdoptedTemplateDescriptorArtifact(input: {
  readonly artifact: ExtensionAdoptedPreparedTemplateArtifact;
  readonly targetRootPath: string;
  readonly sourceRootPath: string;
}): NonNullable<ExtensionSemanticSelection['adoptedArtifact']> {
  const { artifact } = input;
  return {
    kind: 'metadataXml',
    targetRelativePath: artifact.targetRelativePath,
    sourceRelativePath: artifact.sourceRelativePath,
    targetFilePath: path.resolve(input.targetRootPath, artifact.targetRelativePath),
    sourceFilePath: path.resolve(input.sourceRootPath, artifact.sourceRelativePath),
    targetHash: artifact.targetHash,
    sourceHash: artifact.sourceHash,
    targetXml: Buffer.from(artifact.targetXml),
    sourceXml: Buffer.from(artifact.sourceXml),
    recipe: artifact.recipe.descriptorRecipe as AdoptedDescriptorArtifactRecipe,
    issues: [],
    uuidCandidateWitnesses: new Map(),
    dependencyWitnesses: [...artifact.requiredWitnesses],
  };
}

function bodyOnlyCandidateFactory(input: {
  readonly sourceId: string;
  readonly snapshotId: string;
  readonly nodeId: string;
  readonly targetUri: string;
  readonly sourceWitnesses: readonly MergeFileWitness[];
}): NonNullable<ExtensionSemanticSelection['candidateFactory']> {
  const sourceWitnesses = uniqueWitnesses(input.sourceWitnesses);
  return async () => ({
    ok: true,
    candidate: {
      kind: 'fileWrite',
      sourceId: input.sourceId,
      snapshotId: input.snapshotId,
      nodeId: input.nodeId,
      targetUri: input.targetUri,
      sourceWitnesses,
    },
  });
}

function templateUnit(
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

function disablePatchNodes(nodes: readonly CompareTreeNode[], nodeIds: ReadonlySet<string>, targetPath: string): CompareTreeNode[] {
  return nodes.map((node) => {
    const children = disablePatchNodes(node.children, nodeIds, targetPath);
    if (!nodeIds.has(node.id)) { return { ...node, children }; }
    const reason = 'Изменение TemplateType разрешено только внутри захваченного пакета типа и тела макета.';
    return {
      ...node,
      mergeable: false,
      destructive: undefined,
      conflict: { kind: 'unsupported', blocking: true, message: reason },
      mergeState: { state: 'readOnly', reason, targetFilePath: targetPath },
      children,
    };
  });
}

function replaceNode(nodes: readonly CompareTreeNode[], id: string, replacement: CompareTreeNode): CompareTreeNode[] {
  return nodes.map((node) => node.id === id
    ? replacement
    : { ...node, children: replaceNode(node.children, id, replacement) });
}

function collectNodes(nodes: readonly CompareTreeNode[]): CompareTreeNode[] {
  return nodes.flatMap((node) => [node, ...collectNodes(node.children)]);
}

function addressPath(payloadRef?: string): XmlAddressSegment[] | undefined {
  if (!payloadRef?.startsWith('xmlPatch:')) { return undefined; }
  try { return parseXmlAddressPointer(payloadRef.slice('xmlPatch:'.length)); }
  catch { return undefined; }
}

function pathsOverlap(left: readonly XmlAddressSegment[], right: readonly XmlAddressSegment[]): boolean {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index++) {
    if (left[index]!.localName !== right[index]!.localName || left[index]!.selector !== right[index]!.selector) { return false; }
  }
  return true;
}

function sameTargetPath(expectedAbsolutePath: string, actualPath: string): boolean {
  if (!actualPath) { return false; }
  return path.resolve(actualPath) === expectedAbsolutePath;
}

function uniqueWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] {
  const output = new Map<string, MergeFileWitness>();
  for (const witness of witnesses) {
    const key = `${witness.sourceId}\0${normalizePath(witness.relativePath)}\0${witness.kind ?? 'file'}`;
    const existing = output.get(key);
    if (existing && !sameHash(existing.expectedHash, witness.expectedHash)) {
      throw new Error(`Raw Template witnesses конфликтуют: ${witness.relativePath}.`);
    }
    if (!existing) { output.set(key, { ...witness, kind: witness.kind ?? 'file' }); }
  }
  return [...output.values()];
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/gu, '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}
function samePath(left: string, right: string): boolean { return normalizePath(left) === normalizePath(right); }
function normalizeHash(value: string): string { return value.replace(/^sha256:/iu, '').toLowerCase(); }
function sameHash(left: string, right: string): boolean { return normalizeHash(left) === normalizeHash(right); }
