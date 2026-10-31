import * as path from 'path';

import { SUPPORTED_EXTENSION_FORMATS, type ExtensionIndexedObject, type ExtensionMetadataIndex } from './extensionMetadataIndex';
import type { ExtensionTransferRow } from './extensionTransfer';
import type { AdoptedDesignerDirection } from './adoptedDesignerProjection';
import type { MergeFileWitness } from '../merge/mergePreview';
import { captureMergePath } from '../merge/mergeSnapshot';

export type ExtensionAdoptedDirection = AdoptedDesignerDirection;

export type ExtensionAdoptedRowProof =
  | {
    readonly ok: true;
    readonly baseRoot: ExtensionMetadataIndex;
    readonly baseObject: ExtensionIndexedObject;
    readonly otherBaseRoot?: ExtensionMetadataIndex;
    readonly otherBaseObject?: ExtensionIndexedObject;
    readonly provenOwnerRootUuid: string;
  }
  | { readonly ok: false; readonly reason: string };

export function directionForExtensionAdoptedRow(row: ExtensionTransferRow): ExtensionAdoptedDirection | undefined {
  const action = row.semanticAction ?? row.action;
  if (action === 'overlay-adopted') { return 'cf-to-adopted'; }
  if (action === 'adopted-to-cf-overlay') { return 'adopted-to-cf'; }
  if (action === 'adopted-cfe-semantic') { return 'adopted-to-adopted'; }
  return undefined;
}

export function resolveExtensionAdoptedRowProof(
  row: ExtensionTransferRow,
  targetRoot: ExtensionMetadataIndex,
  incomingRoot: ExtensionMetadataIndex,
  direction: ExtensionAdoptedDirection,
): ExtensionAdoptedRowProof {
  const target = row.target;
  const incoming = row.incoming;
  if (!target?.identity || !incoming?.identity) { return { ok: false, reason: 'Для adopted projection отсутствует полная target/source identity.' }; }
  if (targetRoot.sourceId !== row.targetRoot.sourceId || incomingRoot.sourceId !== row.incomingRoot.sourceId) {
    return { ok: false, reason: 'Переданные root indexes не совпадают с captured roots transfer row.' };
  }

  if (direction === 'adopted-to-adopted') {
    return resolveAdoptedToAdoptedProof(row, targetRoot, incomingRoot);
  }

  const baseRoot = direction === 'cf-to-adopted' ? row.targetBase : row.incomingBase;
  const proofFlag = direction === 'cf-to-adopted' ? row.targetBaseIsIncoming : row.incomingBaseIsTarget;
  if (!baseRoot || baseRoot.rootKind !== 'cf') { return { ok: false, reason: 'Для CF↔CFE adopted projection отсутствует captured CF base.' }; }
  if ((direction === 'cf-to-adopted' && (targetRoot.rootKind !== 'cfe' || incomingRoot.rootKind !== 'cf'))
    || (direction === 'adopted-to-cf' && (targetRoot.rootKind !== 'cf' || incomingRoot.rootKind !== 'cfe'))) {
    return { ok: false, reason: 'Root kind не соответствует направлению adopted Designer transfer.' };
  }
  if (row.semanticAction) {
    const matchingAction = direction === 'cf-to-adopted' ? 'overlay-adopted' : 'adopted-to-cf-overlay';
    const comparedCfRoot = direction === 'cf-to-adopted' ? incomingRoot : targetRoot;
    if (row.semanticAction !== matchingAction || !sameCapturedCfConfiguration(baseRoot, comparedCfRoot)
      || !sameSupportedRootFormat(baseRoot, targetRoot, incomingRoot)) {
      return { ok: false, reason: 'Семантическая projection требует одинаковые точные Configuration UUID/name и поддерживаемый формат у захваченной CF base и текущего CF.' };
    }
  } else if (!proofFlag) {
    return { ok: false, reason: 'Перенос без semanticAction требует существующее доказательство exact proven CF base.' };
  }
  const cfIdentity = direction === 'cf-to-adopted' ? incoming.identity : target.identity;
  const adoptedIdentity = direction === 'cf-to-adopted' ? target.identity : incoming.identity;
  const anchorUuid = cfIdentity.uuid;
  const matches = baseRoot.objects.filter((object) => object.identity?.ownership === 'own'
    && object.identity.type === cfIdentity.type
    && object.metadataType === cfIdentity.type
    && normalizeUuid(object.identity.uuid) === normalizeUuid(anchorUuid));
  if (matches.length !== 1) { return { ok: false, reason: 'В proven CF base нет единственного собственного объекта с точной identity transfer row.' }; }
  const baseObject = matches[0]!;
  const [targetIdentity, incomingIdentity, baseIdentity] = [target.identity, incoming.identity, baseObject.identity];
  if (!targetIdentity || !incomingIdentity || !baseIdentity
    || targetIdentity.type !== incomingIdentity.type || incomingIdentity.type !== baseIdentity.type
    || targetIdentity.name !== incomingIdentity.name || incomingIdentity.name !== baseIdentity.name
    || targetIdentity.type !== baseObject.metadataType || incomingIdentity.type !== baseObject.metadataType
    || row.qualifiedName !== baseObject.qualifiedName
    || normalizeUuid(baseIdentity.uuid) !== normalizeUuid(adoptedIdentity.sourceUuid ?? '')
    || normalizeUuid(baseIdentity.uuid) !== normalizeUuid(cfIdentity.uuid)) {
    return { ok: false, reason: 'Target, source и proven base не имеют согласованной root identity и anchor UUID.' };
  }
  if ((direction === 'cf-to-adopted' && (targetIdentity.ownership !== 'adopted' || incomingIdentity.ownership !== 'own'))
    || (direction === 'adopted-to-cf' && (targetIdentity.ownership !== 'own' || incomingIdentity.ownership !== 'adopted'))) {
    return { ok: false, reason: 'Ownership стороны не соответствует направлению CF↔CFE transfer.' };
  }
  return { ok: true, baseRoot, baseObject, provenOwnerRootUuid: normalizeUuid(baseIdentity.uuid) };
}

function resolveAdoptedToAdoptedProof(
  row: ExtensionTransferRow,
  targetRoot: ExtensionMetadataIndex,
  incomingRoot: ExtensionMetadataIndex,
): ExtensionAdoptedRowProof {
  const target = row.target!;
  const incoming = row.incoming!;
  const targetBase = row.targetBase;
  const incomingBase = row.incomingBase;
  const targetIdentity = target.identity!;
  const incomingIdentity = incoming.identity!;
  if (row.semanticAction !== 'adopted-cfe-semantic' || row.sameProvenBase !== true) {
    return { ok: false, reason: 'Granular CFE→CFE semantics требуют отдельного proof action и результата exact common-base проверки.' };
  }
  if (targetRoot.rootKind !== 'cfe' || incomingRoot.rootKind !== 'cfe'
    || targetIdentity.ownership !== 'adopted' || incomingIdentity.ownership !== 'adopted') {
    return { ok: false, reason: 'Направление CFE→CFE требует две adopted CFE стороны.' };
  }
  if (!targetBase || !incomingBase || targetBase.rootKind !== 'cf' || incomingBase.rootKind !== 'cf') {
    return { ok: false, reason: 'Для гранулярной CFE→CFE projection нужны обе captured CF базы.' };
  }
  if (!sameCapturedCfConfiguration(targetBase, incomingBase)
    || !sameSupportedRootFormat(targetBase, targetRoot, incomingRoot)
    || targetBase.formatVersion !== incomingBase.formatVersion
    || normalizeHash(targetBase.configurationHash ?? '') !== normalizeHash(incomingBase.configurationHash ?? '')) {
    return { ok: false, reason: 'Captured CF базы имеют разные Configuration identity, hash или формат.' };
  }
  const anchorUuid = targetIdentity.sourceUuid ?? '';
  const targetBaseObject = uniqueOwnBaseObject(targetBase, targetIdentity.type, anchorUuid);
  const incomingBaseObject = uniqueOwnBaseObject(incomingBase, incomingIdentity.type, incomingIdentity.sourceUuid ?? '');
  if (!targetBaseObject || !incomingBaseObject) {
    return { ok: false, reason: 'В каждой captured CF базе должен быть единственный собственный объект с точным adopted anchor.' };
  }
  const targetBaseIdentity = targetBaseObject.identity!;
  const incomingBaseIdentity = incomingBaseObject.identity!;
  if (targetIdentity.type !== incomingIdentity.type || targetIdentity.name !== incomingIdentity.name
    || target.metadataType !== incoming.metadataType || row.qualifiedName !== targetBaseObject.qualifiedName
    || row.qualifiedName !== incomingBaseObject.qualifiedName
    || normalizeUuid(targetIdentity.sourceUuid ?? '') !== normalizeUuid(incomingIdentity.sourceUuid ?? '')
    || targetIdentity.type !== targetBaseObject.metadataType || incomingIdentity.type !== incomingBaseObject.metadataType
    || targetIdentity.name !== targetBaseIdentity.name || incomingIdentity.name !== incomingBaseIdentity.name
    || normalizeUuid(targetBaseIdentity.uuid) !== normalizeUuid(anchorUuid)
    || normalizeUuid(incomingBaseIdentity.uuid) !== normalizeUuid(anchorUuid)
    || !targetBaseObject.descriptorHash || !incomingBaseObject.descriptorHash
    || normalizeHash(targetBaseObject.descriptorHash) !== normalizeHash(incomingBaseObject.descriptorHash)) {
    return { ok: false, reason: 'Target/source adopted identities или owner descriptors не совпадают с exact common base.' };
  }
  return {
    ok: true,
    baseRoot: targetBase,
    baseObject: targetBaseObject,
    otherBaseRoot: incomingBase,
    otherBaseObject: incomingBaseObject,
    provenOwnerRootUuid: normalizeUuid(targetBaseIdentity.uuid),
  };
}

export async function captureExtensionAdoptedConfigurationWitnesses(input: {
  readonly targetRoot: ExtensionMetadataIndex;
  readonly incomingRoot: ExtensionMetadataIndex;
  readonly baseRoots: readonly ExtensionMetadataIndex[];
}): Promise<{ readonly ok: true; readonly witnesses: readonly MergeFileWitness[] } | { readonly ok: false; readonly reason: string }> {
  const roots = [input.targetRoot, input.incomingRoot, ...input.baseRoots];
  const bySource = new Map(roots.map((root) => [root.sourceId, root]));
  const witnesses: MergeFileWitness[] = [];
  for (const root of bySource.values()) {
    if (!root.hasConfigurationXml || !root.configurationHash) {
      return { ok: false, reason: `У корня ${root.sourceId} нет captured Configuration.xml hash для adopted semantic proof.` };
    }
    try {
      const snapshot = await captureMergePath(path.join(root.canonicalRootPath ?? root.rootPath, 'Configuration.xml'), { retainContent: false });
      if (snapshot.state !== 'file' || normalizeHash(snapshot.hash) !== normalizeHash(root.configurationHash)) {
        return { ok: false, reason: `Captured Configuration.xml корня ${root.sourceId} изменился или отсутствует.` };
      }
      witnesses.push({ sourceId: root.sourceId, relativePath: 'Configuration.xml', expectedHash: normalizeHash(snapshot.hash), kind: 'file' });
    } catch (error) {
      return { ok: false, reason: `Не удалось захватить Configuration.xml корня ${root.sourceId}: ${errorMessage(error)}` };
    }
  }
  return { ok: true, witnesses: dedupeWitnesses(witnesses) };
}

function uniqueOwnBaseObject(root: ExtensionMetadataIndex, type: string, uuid: string): ExtensionIndexedObject | undefined {
  const matches = root.objects.filter((object) => object.identity?.ownership === 'own'
    && object.identity.type === type
    && object.metadataType === type
    && normalizeUuid(object.identity.uuid) === normalizeUuid(uuid));
  if (matches.length !== 1) { return undefined; }
  const object = matches[0]!;
  return object.valid && object.supportedRootType && !object.unsupportedReason
    && Boolean(object.identity && object.descriptorContent && object.descriptorHash && object.descriptorRelativePath)
    ? object : undefined;
}

function sameCapturedCfConfiguration(left: ExtensionMetadataIndex, right: ExtensionMetadataIndex): boolean {
  return left.rootKind === 'cf' && right.rootKind === 'cf'
    && left.hasConfigurationXml && right.hasConfigurationXml
    && Boolean(left.configurationHash && right.configurationHash)
    && Boolean(left.configurationUuid && right.configurationUuid
      && normalizeUuid(left.configurationUuid) === normalizeUuid(right.configurationUuid))
    && Boolean(left.configurationName && right.configurationName && left.configurationName === right.configurationName)
    && Boolean(left.formatVersion && right.formatVersion && left.formatVersion === right.formatVersion
      && SUPPORTED_EXTENSION_FORMATS.has(left.formatVersion));
}

function sameSupportedRootFormat(
  base: ExtensionMetadataIndex,
  target: ExtensionMetadataIndex,
  incoming: ExtensionMetadataIndex,
): boolean {
  const formatVersion = base.formatVersion;
  return Boolean(formatVersion && target.formatVersion === formatVersion && incoming.formatVersion === formatVersion
    && SUPPORTED_EXTENSION_FORMATS.has(formatVersion));
}

function dedupeWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] {
  const byKey = new Map<string, MergeFileWitness>();
  for (const witness of witnesses) {
    const key = `${witness.sourceId}\0${witness.relativePath.replace(/\\/gu, '/')}`;
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
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
