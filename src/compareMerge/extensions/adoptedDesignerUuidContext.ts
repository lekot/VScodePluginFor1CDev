import { randomUUID, createHash } from 'crypto';
import * as path from 'path';

import type { MergeFileWitness } from '../merge/mergePreview';
import { captureMergePath } from '../merge/mergeSnapshot';
import type { AdoptedDesignerChildUuidRequirement } from './adoptedDesignerChildIdentity';
import type { ExtensionAdoptedProjectionIssue } from './adoptedDesignerCandidatePolicy';
import { elementChildren, parseXmlDocument, textContent } from '../xml/xmlDom';
import { namespaceUriForName } from '../adapters/semanticXml/semanticXmlIdentity';
import {
  buildAdoptedDesignerGlobalUuidRegistry,
  collectNewOwnMetadataChildUuids,
  registeredNestedMetadataDescriptors,
  sameAdoptedUuidIdentity,
  sameAdoptedUuidIdentityAtProvenOwner,
  type AdoptedUuidRegistryDefinition,
  type AdoptedDesignerGlobalUuidRegistry,
  type AdoptedUuidRegistryFileCapture,
  type NewMetadataChildUuid,
} from './adoptedDesignerGlobalUuidRegistry';
import type { ExtensionMetadataIndex } from './extensionMetadataIndex';

const UUID_PATTERN = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';

/** One instance is created per compare and shared by every row in that snapshot. */
export interface ExtensionAdoptedUuidSnapshot {
  readonly childUuidByAnchor: Map<string, string>;
  readonly reservedTargetUuids: Set<string>;
}

export interface ExtensionAdoptedUuidProof {
  readonly issues: readonly ExtensionAdoptedProjectionIssue[];
  readonly witnesses: ReadonlyMap<string, readonly MergeFileWitness[]>;
}

export type RegisteredOwnFormDescriptorUuidProof =
  | { readonly ok: true; readonly uuid: string; readonly witnesses: readonly MergeFileWitness[] }
  | { readonly ok: false; readonly reason: string };

interface UuidSnapshotState {
  readonly allocateUuid: () => string;
  readonly allocatedByKey: Map<string, string>;
  readonly registry: AdoptedDesignerGlobalUuidRegistry;
  readonly registryFailure?: string;
}

const uuidSnapshotState = new WeakMap<ExtensionAdoptedUuidSnapshot, UuidSnapshotState>();

/** Captures complete UUID definitions once for the target/incoming compare roots. */
export async function createExtensionAdoptedUuidSnapshot(input: {
  readonly targetRoot: ExtensionMetadataIndex;
  readonly incomingRoot: ExtensionMetadataIndex;
  readonly allocateUuid?: () => string;
}): Promise<ExtensionAdoptedUuidSnapshot> {
  const [targetFiles, sourceFiles] = await Promise.all([
    captureUuidRegistryFiles(input.targetRoot),
    captureUuidRegistryFiles(input.incomingRoot),
  ]);
  const registry = buildAdoptedDesignerGlobalUuidRegistry({ target: targetFiles, source: sourceFiles });
  const reservedTargetUuids = new Set(registry.target.definitionsByUuid.keys());
  const registryFailure = registry.target.complete
    ? undefined
    : registry.target.reasons[0] ?? 'Реестр UUID целевого корня неполон.';
  const snapshot: ExtensionAdoptedUuidSnapshot = {
    childUuidByAnchor: new Map(),
    reservedTargetUuids,
  };
  uuidSnapshotState.set(snapshot, {
    allocateUuid: input.allocateUuid ?? randomUUID,
    allocatedByKey: new Map(),
    registry,
    ...(registryFailure ? { registryFailure } : {}),
  });
  return snapshot;
}

/** Proves one captured registered own Form descriptor introduces a UUID absent from target. */
export function proveRegisteredOwnFormDescriptorUuid(
  snapshot: ExtensionAdoptedUuidSnapshot,
  input: {
    readonly sourceId: string;
    readonly relativePath: string;
    readonly name: string;
    readonly uuid: string;
    readonly descriptorContent: Buffer;
    readonly formatVersion: string;
  },
): RegisteredOwnFormDescriptorUuidProof {
  const state = uuidSnapshotState.get(snapshot);
  if (!state) { return { ok: false, reason: 'UUID proof context не принадлежит текущему compare snapshot.' }; }
  const source = state.registry.source;
  const target = state.registry.target;
  if (!target.complete) { return { ok: false, reason: target.reasons[0] ?? 'Captured target UUID registry неполон.' }; }
  if (!source.complete) { return { ok: false, reason: source.reasons[0] ?? 'Captured source UUID registry неполон.' }; }
  const identity = readRegisteredOwnFormIdentity(input.descriptorContent, input.name, input.formatVersion);
  if (!identity || normalizeUuid(identity.uuid) !== normalizeUuid(input.uuid)) {
    return { ok: false, reason: `Captured descriptor ${input.relativePath} не является exact own Form ${input.name} с ожидаемым UUID/version.` };
  }
  const uuid = normalizeUuid(identity.uuid);
  const sourceDefinitions = source.definitionsByUuid.get(uuid) ?? [];
  if (sourceDefinitions.length !== 1) {
    return { ok: false, reason: sourceDefinitions.length === 0
      ? `UUID ${uuid} отсутствует в registered source UUID registry.`
      : `UUID ${uuid} неоднозначен: в source обнаружено ${sourceDefinitions.length} metadata definitions.` };
  }
  const definition = sourceDefinitions[0]!;
  if (definition.sourceId !== input.sourceId
    || normalizeRelativePath(definition.relativePath) !== normalizeRelativePath(input.relativePath)
    || definition.kind !== 'root'
    || definition.metadataType !== 'Form'
    || definition.name !== identity.name) {
    return { ok: false, reason: `UUID ${uuid} source registry определяет другую registration/path/type/name.` };
  }
  const sourceFileWitness = source.witnesses.find((witness) => witness.sourceId === input.sourceId
    && normalizeRelativePath(witness.relativePath) === normalizeRelativePath(input.relativePath));
  const contentHash = hash(input.descriptorContent);
  if (!sourceFileWitness || normalizeHash(sourceFileWitness.expectedHash) !== contentHash) {
    return { ok: false, reason: `Captured own Form descriptor ${input.relativePath} не совпадает с registered source UUID snapshot.` };
  }
  const targetDefinitions = target.definitionsByUuid.get(uuid) ?? [];
  if (targetDefinitions.length > 0) {
    const existing = targetDefinitions[0]!;
    return { ok: false, reason: `UUID ${uuid} уже определён в target как ${existing.metadataType}${existing.name ? ` ${existing.name}` : ''}: ${existing.relativePath}.` };
  }
  return {
    ok: true,
    uuid,
    witnesses: dedupeUuidWitnesses([...target.witnesses, ...source.witnesses]),
  };
}

export function allocateExtensionAdoptedChildUuids(
  requirements: readonly Pick<AdoptedDesignerChildUuidRequirement, 'mapKey' | 'anchorUuid'>[],
  snapshot: ExtensionAdoptedUuidSnapshot,
): { readonly ok: true; readonly map: ReadonlyMap<string, string> } | { readonly ok: false; readonly reason: string } {
  const state = uuidSnapshotState.get(snapshot);
  if (!state) { return { ok: false, reason: 'UUID allocation context не принадлежит текущему compare snapshot.' }; }
  if (requirements.length && state.registryFailure) { return { ok: false, reason: state.registryFailure }; }
  const seenKeys = new Set<string>();
  const pending = new Map<string, string>();
  const pendingReserved = new Set(snapshot.reservedTargetUuids);
  for (const requirement of requirements) {
    if (seenKeys.has(requirement.mapKey)) {
      return { ok: false, reason: `UUID allocation requirement ${requirement.mapKey} повторяется.` };
    }
    seenKeys.add(requirement.mapKey);
    const existing = snapshot.childUuidByAnchor.get(requirement.mapKey);
    if (existing) {
      if (!validAllocatedUuid(existing, requirement.anchorUuid)
        || state.allocatedByKey.get(requirement.mapKey) !== normalizeUuid(existing)
        || !snapshot.reservedTargetUuids.has(normalizeUuid(existing))) {
        return { ok: false, reason: `Повторный UUID allocation ${requirement.mapKey} изменён или конфликтует с target registry.` };
      }
      continue;
    }
    const allocated = state.allocateUuid();
    if (!validAllocatedUuid(allocated, requirement.anchorUuid)) {
      return { ok: false, reason: `Allocator вернул некорректный или anchor-equal local UUID для child ${requirement.mapKey}.` };
    }
    const normalized = normalizeUuid(allocated);
    if (pendingReserved.has(normalized)) {
      return { ok: false, reason: `Выделенный local UUID ${allocated} уже существует в captured target root/children.` };
    }
    pending.set(requirement.mapKey, allocated);
    pendingReserved.add(normalized);
  }
  for (const [key, allocated] of pending) {
    const normalized = normalizeUuid(allocated);
    snapshot.childUuidByAnchor.set(key, allocated);
    snapshot.reservedTargetUuids.add(normalized);
    state.allocatedByKey.set(key, normalized);
  }
  return { ok: true, map: new Map(snapshot.childUuidByAnchor) };
}

export function allocatedChildUuidProof(
  snapshot: ExtensionAdoptedUuidSnapshot,
  requirements: readonly Pick<AdoptedDesignerChildUuidRequirement, 'mapKey'>[],
  allocation: ReadonlyMap<string, string>,
): ExtensionAdoptedUuidProof {
  const state = uuidSnapshotState.get(snapshot);
  if (!state?.registry.target.complete) { return { issues: [], witnesses: new Map() }; }
  const witnessSet = dedupeUuidWitnesses(state.registry.target.witnesses);
  const witnesses = new Map<string, readonly MergeFileWitness[]>();
  for (const requirement of requirements) {
    const allocated = allocation.get(requirement.mapKey);
    if (allocated) { witnesses.set(normalizeUuid(allocated), witnessSet); }
  }
  return { issues: [], witnesses };
}

/** Proves source-own child UUIDs that adopted materialization may introduce under a proven base owner. */
export function copiedOwnChildUuidProof(
  snapshot: ExtensionAdoptedUuidSnapshot,
  sourceXml: Buffer,
  baseXml: Buffer,
  targetXml: Buffer,
  provenOwnerRootUuid: string,
  targetDescriptorRelativePath: string,
): ExtensionAdoptedUuidProof {
  const children = collectNewOwnMetadataChildUuids({ sourceXml, baseXml });
  if (!children.ok) {
    return { issues: [{ side: 'source', identityKey: 'root=ChildObjects', reason: children.reason }], witnesses: new Map() };
  }
  const state = uuidSnapshotState.get(snapshot);
  if (!state) {
    return {
      issues: children.children.map((child) => ({
        side: 'source', identityKey: child.identityKey,
        reason: 'Реестр UUID не принадлежит текущему compare snapshot.', structuralPath: child.structuralPath,
      })),
      witnesses: new Map(),
    };
  }
  const issues: ExtensionAdoptedProjectionIssue[] = [];
  const witnesses = new Map<string, readonly MergeFileWitness[]>();
  const target = state.registry.target;
  const source = state.registry.source;
  const sourceOwnCfRoot = children.sourceRootBelonging === undefined && children.sourceRootAnchor === undefined;
  const sourceAdoptedRootAtProvenBase = children.sourceRootBelonging === 'Adopted'
    && Boolean(children.sourceRootAnchor)
    && normalizeUuid(children.sourceRootAnchor!) === normalizeUuid(provenOwnerRootUuid);
  if (!sourceOwnCfRoot && !sourceAdoptedRootAtProvenBase) {
    return {
      issues: children.children.map((child) => ({
        side: 'source', identityKey: child.identityKey,
        reason: 'Source owner root не является собственным CF descriptor или adopted root с точным anchor proven CF base.',
        structuralPath: child.structuralPath,
      })),
      witnesses: new Map(),
    };
  }
  let targetChildren: readonly NewMetadataChildUuid[] | undefined;
  let targetChildrenError: string | undefined;
  if (children.children.some((child) => (target.definitionsByUuid.get(child.uuid) ?? []).length === 1)) {
    const parsed = collectNewOwnMetadataChildUuids({ sourceXml: targetXml, baseXml });
    if (!parsed.ok) {
      targetChildrenError = `Не удалось сравнить target physical child с proven base: ${parsed.reason}`;
    } else {
      const targetOwnCfRoot = parsed.sourceRootBelonging === undefined && parsed.sourceRootAnchor === undefined;
      const targetAdoptedRootAtProvenBase = parsed.sourceRootBelonging === 'Adopted'
        && Boolean(parsed.sourceRootAnchor)
        && normalizeUuid(parsed.sourceRootAnchor!) === normalizeUuid(provenOwnerRootUuid);
      if (!targetOwnCfRoot && !targetAdoptedRootAtProvenBase) {
        targetChildrenError = 'Target owner root не является собственным CF descriptor или adopted root с точным anchor proven CF base.';
      } else {
        targetChildren = parsed.children;
      }
    }
  }
  for (const child of children.children) {
    const targetDefinitions = target.definitionsByUuid.get(child.uuid) ?? [];
    const sourceDefinitions = source.definitionsByUuid.get(child.uuid) ?? [];
    let reason: string | undefined;
    if (!target.complete) {
      reason = target.reasons[0] ?? 'Captured target UUID registry неполон.';
    } else if (!source.complete) {
      reason = source.reasons[0] ?? 'Captured source UUID registry неполон.';
    } else if (!child.logicalPathComplete || (sourceOwnCfRoot && normalizeUuid(child.ownerRootUuid) !== normalizeUuid(provenOwnerRootUuid))) {
      reason = `UUID ${child.uuid} не имеет полного пути под точным proven CF owner.`;
    } else if (targetDefinitions.length === 1 && targetChildrenError) {
      reason = targetChildrenError;
    } else if (targetDefinitions.length > 1
      || (targetDefinitions.length === 1 && !samePhysicalChildAtTargetPath(
        child, targetDefinitions[0]!, targetDescriptorRelativePath,
        targetChildren ?? [],
      ))) {
      const owner = targetDefinitions[0]!;
      reason = `UUID ${child.uuid} уже определён в target как ${owner.metadataType}${owner.name ? ` ${owner.name}` : ''} в ${owner.relativePath}.`;
    } else if (sourceDefinitions.length !== 1) {
      reason = sourceDefinitions.length === 0
        ? `UUID ${child.uuid} отсутствует в captured source registry и не может быть доказан.`
        : `UUID ${child.uuid} неоднозначен: в source обнаружено ${sourceDefinitions.length} metadata definitions.`;
    } else if (!sameAdoptedUuidIdentity(child, sourceDefinitions[0]!)) {
      reason = `Captured source UUID ${child.uuid} относится к другой metadata identity или ancestor scope.`;
    }
    if (reason) {
      issues.push({ side: 'source', identityKey: child.identityKey, reason, structuralPath: child.structuralPath });
      continue;
    }
    if (targetDefinitions.length === 0) {
      witnesses.set(child.uuid, dedupeUuidWitnesses([...target.witnesses, ...source.witnesses]));
    }
  }
  return { issues, witnesses };
}

export function promotedChildUuidProof(
  snapshot: ExtensionAdoptedUuidSnapshot,
  sourceXml: Buffer,
  baseXml: Buffer,
  provenOwnerRootUuid: string,
): ExtensionAdoptedUuidProof {
  const children = collectNewOwnMetadataChildUuids({ sourceXml, baseXml });
  if (!children.ok) {
    return { issues: [{ side: 'source', identityKey: 'root=ChildObjects', reason: children.reason }], witnesses: new Map() };
  }
  const state = uuidSnapshotState.get(snapshot);
  if (!state) {
    return {
      issues: children.children.map((child) => ({
        side: 'source', identityKey: child.identityKey,
        reason: 'Реестр UUID не принадлежит текущему compare snapshot.', structuralPath: child.structuralPath,
      })),
      witnesses: new Map(),
    };
  }
  const issues: ExtensionAdoptedProjectionIssue[] = [];
  const witnesses = new Map<string, readonly MergeFileWitness[]>();
  const target = state.registry.target;
  const source = state.registry.source;
  if (children.sourceRootBelonging !== 'Adopted'
    || !children.sourceRootAnchor
    || normalizeUuid(children.sourceRootAnchor) !== normalizeUuid(provenOwnerRootUuid)) {
    return {
      issues: children.children.map((child) => ({
        side: 'source', identityKey: child.identityKey,
        reason: 'Логический owner UUID не совпадает с точным anchor proven CF base.',
        structuralPath: child.structuralPath,
      })),
      witnesses: new Map(),
    };
  }
  for (const child of children.children) {
    const targetDefinitions = target.definitionsByUuid.get(child.uuid) ?? [];
    const sourceDefinitions = source.definitionsByUuid.get(child.uuid) ?? [];
    let reason: string | undefined;
    if (!target.complete) {
      reason = target.reasons[0] ?? 'Captured target UUID registry неполон.';
    } else if (!source.complete) {
      reason = source.reasons[0] ?? 'Captured source UUID registry неполон.';
    } else if (!child.logicalPathComplete) {
      reason = `UUID ${child.uuid} находится под adopted ancestor, для которого нет единственного точного anchor в proven base.`;
    } else if (targetDefinitions.length > 1
      || (targetDefinitions.length === 1
        && !sameAdoptedUuidIdentityAtProvenOwner(child, targetDefinitions[0]!, provenOwnerRootUuid))) {
      const owner = targetDefinitions[0]!;
      reason = `UUID ${child.uuid} уже определён как ${owner.metadataType}${owner.name ? ` ${owner.name}` : ''} в target ${owner.relativePath}.`;
    } else if (sourceDefinitions.length !== 1) {
      reason = sourceDefinitions.length === 0
        ? `UUID ${child.uuid} отсутствует в captured source registry и не может быть доказан.`
        : `UUID ${child.uuid} неоднозначен: в source обнаружено ${sourceDefinitions.length} metadata definitions.`;
    } else if (!sameAdoptedUuidIdentity(child, sourceDefinitions[0]!)) {
      reason = `Captured source UUID ${child.uuid} относится к другой metadata identity или ancestor scope.`;
    }
    if (reason) {
      issues.push({ side: 'source', identityKey: child.identityKey, reason, structuralPath: child.structuralPath });
      continue;
    }
    if (targetDefinitions.length === 0) {
      witnesses.set(child.uuid, dedupeUuidWitnesses([...target.witnesses, ...source.witnesses]));
    }
  }
  return { issues, witnesses };
}

async function captureUuidRegistryFiles(root: ExtensionMetadataIndex): Promise<AdoptedUuidRegistryFileCapture[]> {
  const files: AdoptedUuidRegistryFileCapture[] = [];
  const configuration = await captureUuidRegistryFile(root, {
    relativePath: 'Configuration.xml',
    expectedHash: root.configurationHash,
    kind: 'configuration',
    expectedName: root.configurationName,
    expectedUuid: root.configurationUuid,
    missingReason: `У корня ${root.sourceId} отсутствует captured Configuration.xml для проверки UUID.`,
  });
  files.push(configuration.record);

  for (const object of root.objects) {
    const descriptor = await captureUuidRegistryFile(root, {
      relativePath: object.descriptorRelativePath,
      expectedHash: object.descriptorHash,
      kind: 'metadata-descriptor',
      expectedType: object.metadataType,
      expectedName: object.name,
      expectedUuid: object.identity?.uuid,
      missingReason: `Для ${object.qualifiedName} отсутствует captured root descriptor; реестр UUID неполон.`,
    });
    files.push(descriptor.record);
    if (!descriptor.content || !object.sidecarRelativePath) { continue; }
    const registrations = registeredNestedMetadataDescriptors({
      descriptorXml: descriptor.content,
      sidecarRelativePath: object.sidecarRelativePath,
    });
    if (!registrations.ok) {
      files.push({
        sourceId: root.sourceId,
        relativePath: `${object.descriptorRelativePath ?? object.qualifiedName}#nested-registrations`,
        expectedHash: '',
        kind: 'metadata-descriptor',
        captureError: `Не удалось проверить registered nested UUID для ${object.qualifiedName}: ${registrations.reason}`,
      });
      continue;
    }
    for (const registration of registrations.descriptors) {
      const matches = object.sidecarFiles.filter((file) => normalizeRelativePath(file.relativePath) === normalizeRelativePath(registration.relativePath));
      const sidecar = matches.length === 1 ? matches[0] : undefined;
      const nested = await captureUuidRegistryFile(root, {
        relativePath: registration.relativePath,
        expectedHash: sidecar?.hash,
        kind: 'metadata-descriptor',
        expectedType: registration.metadataType,
        expectedName: registration.name,
        missingReason: matches.length === 0
          ? `Зарегистрированный ${registration.metadataType} ${registration.name} отсутствует в captured sidecar index.`
          : `Путь зарегистрированного ${registration.metadataType} ${registration.name} неоднозначен в captured sidecar index.`,
      });
      files.push(nested.record);
    }
  }
  return files;
}

async function captureUuidRegistryFile(
  root: ExtensionMetadataIndex,
  input: {
    readonly relativePath?: string;
    readonly expectedHash?: string;
    readonly kind: 'configuration' | 'metadata-descriptor';
    readonly expectedType?: string;
    readonly expectedName?: string;
    readonly expectedUuid?: string;
    readonly missingReason: string;
  },
): Promise<{ readonly record: AdoptedUuidRegistryFileCapture; readonly content?: Buffer }> {
  const relativePath = input.relativePath ?? '';
  const failure = (reason: string) => ({
    record: {
      sourceId: root.sourceId,
      relativePath: relativePath || 'Configuration.xml',
      expectedHash: normalizeHash(input.expectedHash ?? ''),
      kind: input.kind,
      ...(input.expectedType ? { expectedType: input.expectedType } : {}),
      ...(input.expectedName ? { expectedName: input.expectedName } : {}),
      ...(input.expectedUuid ? { expectedUuid: input.expectedUuid } : {}),
      captureError: reason,
    } satisfies AdoptedUuidRegistryFileCapture,
  });
  if (!relativePath || !input.expectedHash || !/^[\da-f]{64}$/iu.test(normalizeHash(input.expectedHash))) {
    return failure(input.missingReason);
  }
  const normalized = normalizeRelativePath(relativePath);
  if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
    return failure(`Captured descriptor имеет небезопасный путь ${relativePath}.`);
  }
  try {
    const absolute = path.join(root.canonicalRootPath ?? root.rootPath, ...normalized.split('/'));
    const snapshot = await captureMergePath(absolute, { retainContent: true });
    if (snapshot.state !== 'file' || snapshot.contentBase64 === undefined) {
      return failure(`Captured metadata UUID file отсутствует или небезопасен: ${relativePath}.`);
    }
    const content = Buffer.from(snapshot.contentBase64, 'base64');
    const expectedHash = normalizeHash(input.expectedHash);
    if (normalizeHash(snapshot.hash) !== expectedHash || hash(content) !== expectedHash) {
      return failure(`Physical SHA-256 ${relativePath} изменился после metadata indexing.`);
    }
    return {
      record: {
        sourceId: root.sourceId,
        relativePath: normalized,
        expectedHash,
        content,
        kind: input.kind,
        ...(input.expectedType ? { expectedType: input.expectedType } : {}),
        ...(input.expectedName ? { expectedName: input.expectedName } : {}),
        ...(input.expectedUuid ? { expectedUuid: input.expectedUuid } : {}),
      },
      content,
    };
  } catch (error) {
    return failure(`Не удалось захватить ${relativePath}: ${errorMessage(error)}`);
  }
}

function validAllocatedUuid(value: string, anchor: string): boolean {
  return UUID_PATTERN.test(value) && normalizeUuid(value) !== ZERO_UUID && normalizeUuid(value) !== normalizeUuid(anchor);
}

function samePhysicalChildAtTargetPath(
  child: NewMetadataChildUuid,
  definition: AdoptedUuidRegistryDefinition,
  targetDescriptorRelativePath: string,
  targetChildren: readonly NewMetadataChildUuid[],
): boolean {
  if (normalizeRelativePath(definition.relativePath) !== normalizeRelativePath(targetDescriptorRelativePath)) { return false; }
  const targetChild = targetChildren.find((candidate) => candidate.metadataType === definition.metadataType
    && normalizeUuid(candidate.uuid) === normalizeUuid(definition.uuid)
    && normalizeName(candidate.name ?? '') === normalizeName(definition.name ?? '')
    && candidate.structuralPath.map(normalizeSelector).join('/') === definition.structuralPath.map(normalizeSelector).join('/'));
  return Boolean(targetChild?.logicalPathComplete && child.logicalPathComplete
    && child.metadataType === targetChild.metadataType
    && normalizeUuid(child.uuid) === normalizeUuid(targetChild.uuid)
    && normalizeName(child.name ?? '') === normalizeName(targetChild.name ?? '')
    && child.logicalStructuralPath.map(normalizeSelector).join('/') === targetChild.logicalStructuralPath.map(normalizeSelector).join('/'));
}

function normalizeSelector(value: string): string { return value.toLocaleLowerCase('en-US'); }
function normalizeName(value: string): string { return value.trim().normalize('NFC').toLocaleLowerCase('en-US'); }

function readRegisteredOwnFormIdentity(
  content: Buffer,
  expectedName: string,
  expectedVersion: string,
): { readonly name: string; readonly uuid: string } | undefined {
  try {
    const root = parseXmlDocument(content.toString('utf8')).root;
    if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MDCLASSES_NAMESPACE
      || !expectedVersion || attributeValue(root, 'version') !== expectedVersion) { return undefined; }
    const descriptors = elementChildren(root);
    if (descriptors.length !== 1 || descriptors[0]!.localName !== 'Form'
      || namespaceUriForName(descriptors[0]!) !== MDCLASSES_NAMESPACE) { return undefined; }
    const descriptor = descriptors[0]!;
    const uuid = attributeValue(descriptor, 'uuid')?.trim() ?? '';
    if (!UUID_PATTERN.test(uuid) || normalizeUuid(uuid) === ZERO_UUID) { return undefined; }
    const properties = elementChildren(descriptor).filter((element) => element.localName === 'Properties'
      && namespaceUriForName(element) === MDCLASSES_NAMESPACE);
    if (properties.length !== 1) { return undefined; }
    const fields = elementChildren(properties[0]!);
    const names = fields.filter((element) => element.localName === 'Name' && namespaceUriForName(element) === MDCLASSES_NAMESPACE);
    if (names.length !== 1) { return undefined; }
    const name = textContent(names[0]!).trim().normalize('NFC');
    if (!name || name !== expectedName.trim().normalize('NFC')
      || fields.some((element) => element.localName === 'ObjectBelonging' || element.localName === 'ExtendedConfigurationObject')) {
      return undefined;
    }
    const childObjects = elementChildren(descriptor).filter((element) => element.localName === 'ChildObjects');
    if (childObjects.length > 1 || childObjects.some((element) => namespaceUriForName(element) !== MDCLASSES_NAMESPACE
      || elementChildren(element).length > 0)) { return undefined; }
    return { name, uuid: normalizeUuid(uuid) };
  } catch {
    return undefined;
  }
}

function attributeValue(element: ReturnType<typeof parseXmlDocument>['root'], name: string): string | undefined {
  return element.attributes.find((attribute) => attribute.name === name)?.value;
}

function dedupeUuidWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] {
  const byKey = new Map<string, MergeFileWitness>();
  for (const witness of witnesses) {
    const key = `${witness.sourceId}\0${normalizeRelativePath(witness.relativePath)}\0${witness.kind ?? 'file'}`;
    const previous = byKey.get(key);
    if (previous && normalizeHash(previous.expectedHash) !== normalizeHash(witness.expectedHash)) {
      throw new Error(`Conflicting raw hash witnesses for ${witness.sourceId}:${witness.relativePath}.`);
    }
    byKey.set(key, { ...witness, expectedHash: normalizeHash(witness.expectedHash) });
  }
  return [...byKey.values()];
}

function normalizeUuid(value: string): string { return value.toLowerCase(); }
function normalizeHash(value: string): string { return value.replace(/^sha256:/iu, '').toLowerCase(); }
function normalizeRelativePath(value: string): string { return value.replace(/\\/gu, '/').replace(/^\.\//u, ''); }
function hash(content: Buffer): string { return createHash('sha256').update(content).digest('hex'); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
