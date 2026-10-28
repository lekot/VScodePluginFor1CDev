import * as path from 'path';

import type { CompareMessage } from '../domain/compareContracts';
import type { CompareSession } from '../domain/compareSession';
import type { CompareTreeNode, CompareTreeStatus } from '../compareTreeTypes';
import { throwIfCompareCancelled, type CompareCancellationToken } from '../compareCancellation';
import type { AdapterCompareInput, ArtifactUnit, ConfigurationInventory, ExecutableCandidateFactory, MergeAdapter, MetadataObjectUnit } from '../adapters/mergeAdapter';
import { metadataXmlAdapter } from '../adapters/xmlMetadataAdapter';
import { formXmlAdapter } from '../adapters/formXmlAdapter';
import { predefinedXmlAdapter } from '../adapters/predefinedXmlAdapter';
import { captureMergePath } from '../merge/mergeSnapshot';
import { replaceRootUuid } from './extensionXmlOverlay';
import type { ExtensionIndexedObject, ExtensionMetadataIndex } from './extensionMetadataIndex';
import type { ExtensionSemanticSelection, ExtensionTransferRow } from './extensionTransfer';
import { projectExtensionRootPurpose } from './extensionRootPurpose';

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
}

const XML_FILES = [
  { kind: 'formXml' as const, fileName: 'form.xml', adapter: formXmlAdapter, label: 'Форма' },
  { kind: 'predefinedXml' as const, fileName: 'predefined.xml', adapter: predefinedXmlAdapter, label: 'Предопределённые данные' },
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

  for (const row of input.rows) {
    throwIfCompareCancelled(input.cancellation);
    if (!row.target || !row.incoming || !row.target.descriptorRelativePath || !row.incoming.descriptorRelativePath) {
      nodes.push(rowNode(row, []));
      continue;
    }
    const allowed = semanticSelectionReason(row) === undefined;
    const readonlyReason = semanticSelectionReason(row);
    const childNodes: CompareTreeNode[] = [];
    const descriptors = await compareArtifact({
      input,
      targetInventory,
      incomingInventory,
      targetObject: row.target,
      incomingObject: row.incoming,
      kind: 'metadataXml',
      targetRelativePath: row.target.descriptorRelativePath,
      sourceRelativePath: row.incoming.descriptorRelativePath,
      targetHash: row.target.descriptorHash,
      sourceHash: row.incoming.descriptorHash,
      adapter: metadataXmlAdapter,
      label: 'Дескриптор',
      row,
      allowed,
      readonlyReason,
      selections,
      diagnostics,
    });
    throwIfCompareCancelled(input.cancellation);
    if (descriptors) {childNodes.push(descriptors);}

    const paired = pairedXmlSidecars(row.target, row.incoming);
    for (const duplicatePath of paired.duplicatePaths) {
      diagnostics.push({
        severity: 'error', code: 'EXTENSION_SEMANTIC_PATH_AMBIGUOUS', phase: 'compare',
        sourceId: row.incoming.sourceId, path: duplicatePath, nodeId: row.id, blocking: true,
        suggestedAction: 'Несколько XML sidecar-файлов имеют один и тот же нормализованный относительный путь; семантическое сопоставление этого пути пропущено.',
      });
    }
    for (const pair of paired.pairs) {
      throwIfCompareCancelled(input.cancellation);
      const definition = XML_FILES.find((candidate) => candidate.kind === pair.kind)!;
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
        selections,
        diagnostics,
      });
      throwIfCompareCancelled(input.cancellation);
      if (node) {childNodes.push(node);}
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
  };
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
  selections: Map<string, ExtensionSemanticSelection>;
  diagnostics: CompareMessage[];
}): Promise<CompareTreeNode | undefined> {
  const targetRoot = input.input.target.canonicalRootPath ?? input.input.target.rootPath;
  const sourceRoot = input.input.incoming.canonicalRootPath ?? input.input.incoming.rootPath;
  if (!input.targetHash || !input.sourceHash) {
    return undefined;
  }
  if (input.targetHash === input.sourceHash) {return undefined;}
  const [target, source] = await Promise.all([
    captureXmlArtifact(targetRoot, input.targetRelativePath, input.targetHash),
    captureXmlArtifact(sourceRoot, input.sourceRelativePath, input.sourceHash),
  ]);
  if (!target || !source) {
    input.diagnostics.push(semanticReadDiagnostic(input.row, input.sourceRelativePath));
    return undefined;
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

  const targetUnit = inventoryObject(input.targetInventory, input.targetObject);
  const sourceUnit = inventoryObject(input.incomingInventory, input.incomingObject);
  if (!targetUnit || !sourceUnit) {return undefined;}
  const metadataContext = extensionMetadataReferenceContext(input.row);
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
    semanticContextWitnesses: metadataContext.contextWitnesses,
    snapshots: { left: target.toString('utf8'), right: sourceText },
  };
  const result = await input.adapter.compare(compareInput);
  input.diagnostics.push(...result.diagnostics);
  if (result.nodes.length === 0) {
    const blocker = result.diagnostics.find((item) => item.blocking);
    if (!blocker) {return undefined;}
    const reason = blocker.suggestedAction ?? 'XML-артефакт доступен только для чтения.';
    return {
      id: `extension:xml:${input.row.id}:${input.kind}:${encodeURIComponent(input.targetRelativePath)}`,
      label: input.label,
      kind: 'extensionSemanticFile',
      status: 'changed',
      mergeable: false,
      conflict: { kind: 'unsupported', message: reason, blocking: true },
      mergeState: { state: 'blocked', reason, targetFilePath: input.targetRelativePath },
      children: [],
    };
  }

  const contents = result.nodes.map((node) => projectAdapterNode({
    node,
    factoryMap: result.candidateFactories,
    input,
  }));
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

function extensionMetadataReferenceContext(row: ExtensionTransferRow): {
  validationContext: AdapterCompareInput['semanticValidationContext'];
  referenceWitnesses: NonNullable<AdapterCompareInput['semanticMetadataReferenceWitnesses']>;
  contextWitnesses: NonNullable<AdapterCompareInput['semanticContextWitnesses']>;
} {
  const target = row.targetRoot;
  const provenBase = row.sameProvenBase === true ? row.targetBase : undefined;
  const indexes = [target, provenBase].filter((index): index is ExtensionMetadataIndex => Boolean(index));
  const references = new Map<string, string>();
  const referenceWitnesses: Array<NonNullable<AdapterCompareInput['semanticMetadataReferenceWitnesses']>[number]> = [];
  const witnessed = new Set<string>();
  for (const index of indexes) {
    for (const object of index.objects) {
      if (!object.descriptorRelativePath || !object.descriptorHash) {continue;}
      const key = object.qualifiedName.normalize('NFC').toLowerCase();
      if (!references.has(key)) {references.set(key, object.qualifiedName);}
      const witnessKey = `${index.sourceId}\u0000${object.descriptorRelativePath}`;
      if (witnessed.has(witnessKey)) {continue;}
      witnessed.add(witnessKey);
      referenceWitnesses.push({
        qualifiedName: object.qualifiedName,
        witness: {
          sourceId: index.sourceId,
          relativePath: object.descriptorRelativePath,
          expectedHash: object.descriptorHash,
          kind: 'file',
        },
      });
    }
  }
  const contextWitnesses = provenBase?.configurationHash
    ? [{
      sourceId: provenBase.sourceId,
      relativePath: 'Configuration.xml',
      expectedHash: provenBase.configurationHash,
      kind: 'file' as const,
    }]
    : [];
  return {
    validationContext: target.hasConfigurationXml && target.configurationHash
      ? { availableMetadataReferences: [...references.values()] }
      : undefined,
    referenceWitnesses,
    contextWitnesses,
  };
}

function projectAdapterNode(input: {
  node: CompareTreeNode;
  factoryMap: ReadonlyMap<string, ExecutableCandidateFactory>;
  input: Parameters<typeof compareArtifact>[0];
}): CompareTreeNode {
  const node = input.node;
  const factory = input.factoryMap.get(node.id);
  const enabled = input.input.allowed && Boolean(factory) && node.mergeable === true;
  if (enabled && factory) {
    input.input.selections.set(node.id, {
      nodeId: node.id,
      rowId: input.input.row.id,
      kind: input.input.kind,
      targetRelativePath: input.input.targetRelativePath,
      sourceRelativePath: input.input.sourceRelativePath,
      targetHash: input.input.targetHash!,
      sourceHash: input.input.sourceHash!,
      candidateFactory: withRootConfigurationWitnesses(factory, input.input.input.target, input.input.input.incoming),
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
    children,
  };
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

function pairedXmlSidecars(
  target: ExtensionIndexedObject,
  incoming: ExtensionIndexedObject,
): {
  pairs: { kind: 'formXml' | 'predefinedXml'; relativePath: string; target: ExtensionIndexedObject['sidecarFiles'][number]; source: ExtensionIndexedObject['sidecarFiles'][number] }[];
  duplicatePaths: string[];
} {
  const targetFiles = xmlSidecarsByOwnerPath(target);
  const sourceFiles = xmlSidecarsByOwnerPath(incoming);
  const pairs: { kind: 'formXml' | 'predefinedXml'; relativePath: string; target: ExtensionIndexedObject['sidecarFiles'][number]; source: ExtensionIndexedObject['sidecarFiles'][number] }[] = [];
  for (const [key, targetFile] of targetFiles.files) {
    const sourceFile = sourceFiles.files.get(key);
    if (!sourceFile) {continue;}
    const fileName = path.posix.basename(key);
    const definition = XML_FILES.find((item) => item.fileName === fileName);
    if (!definition) {continue;}
    pairs.push({ kind: definition.kind, relativePath: ownerRelativePath(target, targetFile.relativePath), target: targetFile, source: sourceFile });
  }
  return {
    pairs: pairs.sort((left, right) => left.target.relativePath.toLowerCase().localeCompare(right.target.relativePath.toLowerCase())),
    duplicatePaths: [...targetFiles.duplicatePaths, ...sourceFiles.duplicatePaths],
  };
}

function xmlSidecarsByOwnerPath(object: ExtensionIndexedObject): {
  files: Map<string, ExtensionIndexedObject['sidecarFiles'][number]>;
  duplicatePaths: string[];
} {
  const result = new Map<string, ExtensionIndexedObject['sidecarFiles'][number]>();
  const duplicates = new Set<string>();
  for (const file of object.sidecarFiles) {
    const relative = ownerRelativePath(object, file.relativePath).replace(/\\/gu, '/');
    const name = path.posix.basename(relative).toLowerCase();
    if (name !== 'form.xml' && name !== 'predefined.xml') {continue;}
    const key = process.platform === 'win32' ? relative.toLowerCase() : relative;
    if (result.has(key)) {
      result.delete(key);
      duplicates.add(key);
    } else if (!duplicates.has(key)) {
      result.set(key, file);
    }
  }
  return { files: result, duplicatePaths: [...duplicates] };
}

function ownerRelativePath(object: ExtensionIndexedObject, relativePath: string): string {
  const prefix = (object.sidecarRelativePath ?? '').replace(/\\/gu, '/').replace(/\/$/u, '');
  const candidate = relativePath.replace(/\\/gu, '/');
  const parent = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const expectedPrefix = process.platform === 'win32' ? prefix.toLowerCase() : prefix;
  return expectedPrefix && parent.startsWith(`${expectedPrefix}/`)
    ? candidate.slice(prefix.length + 1)
    : candidate;
}

function normalizeArtifactPath(value: string): string {
  const normalized = value.replace(/\\/gu, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
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
      const kind = baseName === 'form.xml' ? 'formXml' : baseName === 'predefined.xml' ? 'predefinedXml' : undefined;
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
