import * as path from 'path';
import { validateElementName } from '../../utils/elementNameValidator';
import type { CompareMessage } from '../domain/compareContracts';
import type { CompareTreeNode, CompareTreeStatus } from '../compareTreeTypes';
import type { ExtensionIndexedObject, ExtensionMetadataIndex } from './extensionMetadataIndex';
import { captureMergePath } from '../merge/mergeSnapshot';
import type { MergeCandidate } from '../merge/mergePreview';
import { hasNonEmptyChildObjects, hasUnknownInterceptShape, hasUnsupportedPropertyChanges, isSemanticOverlayChanged, isValidPropertyState, overlaySimpleProperties, replaceRootUuid } from './extensionXmlOverlay';

export { materializeExtensionSelection } from './extensionMaterializer';

const RIGHT_SOURCE_ID = 'right-source';
export type ExtensionTransferAction =
  | 'full-copy'
  | 'borrow-shell'
  | 'overlay-adopted'
  | 'adopted-to-cf-overlay'
  | 'adopted-cfe-copy';

export interface ExtensionTransferRow {
  readonly id: string;
  readonly qualifiedName: string;
  readonly status: CompareTreeStatus;
  readonly target?: ExtensionIndexedObject;
  readonly incoming?: ExtensionIndexedObject;
  readonly targetRoot: ExtensionMetadataIndex;
  readonly incomingRoot: ExtensionMetadataIndex;
  readonly action?: ExtensionTransferAction;
  readonly mergeable: boolean;
  readonly reason?: string;
  readonly targetBase?: ExtensionMetadataIndex;
  readonly incomingBase?: ExtensionMetadataIndex;
  readonly targetBaseIsIncoming?: boolean;
  readonly incomingBaseIsTarget?: boolean;
  readonly sameProvenBase?: boolean;
}

export interface ExtensionTransferAnalysis {
  readonly rows: readonly ExtensionTransferRow[];
  readonly nodes: readonly CompareTreeNode[];
  readonly mergeableNodeIds: readonly string[];
  readonly diagnostics: readonly CompareMessage[];
}

export interface ExtensionMaterializerInput {
  readonly target: ExtensionMetadataIndex;
  readonly incoming: ExtensionMetadataIndex;
  readonly rows: readonly ExtensionTransferRow[];
  readonly leftSnapshotId: string;
  readonly rightSnapshotId: string;
  readonly cancellation?: import('../compareCancellation').CompareCancellationToken;
}

export type ExtensionMaterializerResult =
  | { readonly ok: true; readonly candidates: readonly MergeCandidate[] }
  | { readonly ok: false; readonly diagnostics: CompareMessage[] };

/** Builds visible semantic rows. Only the incoming/right object can produce a candidate. */
export async function analyzeExtensionTransfers(input: {
  readonly target: ExtensionMetadataIndex;
  readonly incoming: ExtensionMetadataIndex;
  readonly targetBase?: ExtensionMetadataIndex;
  readonly incomingBase?: ExtensionMetadataIndex;
  readonly targetBaseIsIncoming: boolean;
  readonly incomingBaseIsTarget: boolean;
  readonly globalBlockReason?: string;
}): Promise<ExtensionTransferAnalysis> {
  const diagnostics: CompareMessage[] = [];
  const rows: ExtensionTransferRow[] = [];
  const targetObjects = input.target.objects;
  const incomingObjects = input.incoming.objects;
  const targetDuplicates = duplicateReasons(targetObjects);
  const incomingDuplicates = duplicateReasons(incomingObjects);
  const matchedTarget = new Set<ExtensionIndexedObject>();

  for (const incoming of incomingObjects) {
    const id = rowId(incoming);
    const incomingDuplicate = incomingDuplicates.get(incoming);
    const targetMatch = findTargetMatch(incoming, input);
    if (targetMatch.object) {
      matchedTarget.add(targetMatch.object);
    }
    let reason = input.globalBlockReason ?? incomingDuplicate ?? targetMatch.reason;
    let action: ExtensionTransferAction | undefined;
    if (!reason) {
      const decision = decideTransfer(input, incoming, targetMatch.object, targetMatch.sameProvenBase);
      action = decision.action;
      reason = decision.reason;
    }
    if (!reason && action) {
      reason = publishedRootUuidCollision(input.target, incoming, targetMatch.object, action);
    }
    if (!reason && incoming.unsupportedReason) {
      reason = incoming.unsupportedReason;
    }
    if (!reason && !incoming.valid) {
      reason = 'Дескриптор объекта не прошёл проверку.';
    }
    if (!reason && !incoming.supportedRootType) {
      reason = 'Перенос этого типа корневого объекта не поддержан.';
    }
    if (!reason && targetMatch.object) {
      reason = targetDuplicates.get(targetMatch.object);
    }
    if (!reason && action === 'full-copy' && !targetMatch.object) {
      reason = await inspectUnregisteredTargetCollision(input.target, incoming);
    }
    if (!reason && action === 'overlay-adopted' && targetMatch.object?.descriptorContent && incoming.descriptorContent) {
      const overlay = overlaySimpleProperties(targetMatch.object.descriptorContent, incoming.descriptorContent, incoming.metadataType);
      if ('error' in overlay) {reason = overlay.error;}
    }
    const semanticChange = targetMatch.object
      ? isSemanticTransferChanged(action, targetMatch.object, incoming)
      : true;
    const status: CompareTreeStatus = targetMatch.object
      ? semanticChange ? 'changed' : 'equal'
      : 'rightOnly';
    const mergeable = Boolean(action && !reason && incoming.valid && incoming.supportedRootType && semanticChange);
    const row: ExtensionTransferRow = {
      id,
      qualifiedName: incoming.qualifiedName,
      status,
      target: targetMatch.object,
      incoming,
      targetRoot: input.target,
      incomingRoot: input.incoming,
      action,
      mergeable,
      reason,
      targetBase: input.targetBase,
      incomingBase: input.incomingBase,
      targetBaseIsIncoming: input.targetBaseIsIncoming,
      incomingBaseIsTarget: input.incomingBaseIsTarget,
      sameProvenBase: targetMatch.sameProvenBase,
    };
    rows.push(row);
    if (reason) {
      diagnostics.push(compareDiagnostic(reason, RIGHT_SOURCE_ID, id));
    }
  }

  for (const target of targetObjects) {
    if (matchedTarget.has(target)) {
      continue;
    }
    const reason = targetDuplicates.get(target) ?? target.unsupportedReason;
    rows.push({
      id: rowId(target, 'left-only'),
      qualifiedName: target.qualifiedName,
      status: 'leftOnly',
      target,
      targetRoot: input.target,
      incomingRoot: input.incoming,
      mergeable: false,
      reason,
    });
  }

  const nodes = rows.map(projectTransferRow);
  return {
    rows,
    nodes,
    mergeableNodeIds: rows.filter((row) => row.mergeable).map((row) => row.id),
    diagnostics,
  };
}

function decideTransfer(
  input: Parameters<typeof analyzeExtensionTransfers>[0],
  incoming: ExtensionIndexedObject,
  targetObject?: ExtensionIndexedObject,
  sameProvenBase = false,
): { action?: ExtensionTransferAction; reason?: string } {
  const sourceIdentity = incoming.identity;
  if (!sourceIdentity) {
    return { reason: 'У объекта отсутствует строгая UUID identity.' };
  }
  if (targetObject?.identity && sourceIdentity.type === targetObject.identity.type) {
    if (sourceIdentity.ownership === 'own' && targetObject.identity.ownership === 'own'
      && sameUuid(sourceIdentity.uuid, targetObject.identity.uuid)
      && (sourceIdentity.name !== targetObject.identity.name || incoming.qualifiedName !== targetObject.qualifiedName)) {
      return { reason: 'Одинаковый UUID имеет разные qualified name; переименование через сравнение не поддержано.' };
    }
    if (sourceIdentity.ownership === 'adopted' && targetObject.identity.ownership === 'adopted'
      && sameUuid(sourceIdentity.sourceUuid, targetObject.identity.sourceUuid)
      && (sourceIdentity.name !== targetObject.identity.name || incoming.qualifiedName !== targetObject.qualifiedName)) {
      return { reason: 'У adopted object одинаковый anchor, но разные имена; переименование не поддержано.' };
    }
  }

  if (sourceIdentity.ownership === 'own') {
    return decideOwnTransfer(input, incoming, targetObject);
  }
  return decideAdoptedTransfer(input, incoming, targetObject, sameProvenBase);
}

function decideOwnTransfer(
  input: Parameters<typeof analyzeExtensionTransfers>[0],
  incoming: ExtensionIndexedObject,
  targetObject?: ExtensionIndexedObject,
): { action?: ExtensionTransferAction; reason?: string } {
  const identity = incoming.identity!;
  const target = input.target;
  const targetIdentity = targetObject?.identity;
  const sourceIsProvenTargetBase = target.rootKind === 'cfe'
    && input.incoming.rootKind === 'cf'
    && input.targetBaseIsIncoming
    && isEquivalentOwnObject(input.targetBase ?? input.incoming, input.incoming, identity.type, identity.uuid);
  const provenBaseObject = sourceIsProvenTargetBase
    ? findOwnBaseObject(input.targetBase ?? input.incoming, identity.type, identity.uuid)
    : undefined;
  if (provenBaseObject && provenBaseObject.name !== identity.name) {
    return { reason: 'Base object имеет тот же UUID, но другое имя; перенос заблокирован.' };
  }
  const isBorrowedBaseObject = Boolean(provenBaseObject && provenBaseObject.name === identity.name);
  const isProvenAdoptedTarget = target.rootKind === 'cfe'
    && input.incoming.rootKind === 'cf'
    && sourceIsProvenTargetBase
    && targetIdentity?.ownership === 'adopted'
    && targetIdentity.type === identity.type
    && targetIdentity.sourceUuid?.toLowerCase() === identity.uuid.toLowerCase();
  const isExactOwnTarget = targetIdentity?.ownership === 'own'
    && targetIdentity.type === identity.type
    && targetIdentity.uuid.toLowerCase() === identity.uuid.toLowerCase();
  if (targetObject && !isExactOwnTarget && !isProvenAdoptedTarget) {
    return { reason: 'Qualified name занят объектом с другой identity.' };
  }
  if (target.rootKind === 'cfe') {
    const namePrefix = target.namePrefix ?? '';
    if ((!isBorrowedBaseObject && !isProvenAdoptedTarget && !identity.name.startsWith(namePrefix))
      || validateElementName(identity.name, []) !== null) {
      return { reason: 'Имя собственного объекта не соответствует NamePrefix целевого CFE.' };
    }
    if (!targetObject && target.purpose === 'Patch') {
      return { reason: 'Создание собственного объекта в CFE назначения Patch не поддержано.' };
    }
  }

  if (isBorrowedBaseObject) {
    if (targetObject && isProvenAdoptedTarget) {
      return { action: 'overlay-adopted' };
    }
    return { action: 'borrow-shell' };
  }
  if (targetObject) {
    if (targetIdentity?.ownership === 'adopted') {
      return { reason: 'Собственный исходный объект конфликтует с adopted object цели.' };
    }
    return { action: 'full-copy' };
  }
  return { action: 'full-copy' };
}

function decideAdoptedTransfer(
  input: Parameters<typeof analyzeExtensionTransfers>[0],
  incoming: ExtensionIndexedObject,
  targetObject?: ExtensionIndexedObject,
  sameProvenBase = false,
): { action?: ExtensionTransferAction; reason?: string } {
  const identity = incoming.identity!;
  const target = input.target;
  if (target.rootKind === 'cf') {
    if (!input.incomingBase || !input.incomingBaseIsTarget
      || !isEquivalentOwnObject(input.incomingBase, target, identity.type, identity.sourceUuid ?? '')) {
      return { reason: 'Для переноса adopted object в CF не доказана его базовая конфигурация.' };
    }
    const baseObject = findOwnBaseObject(input.incomingBase, identity.type, identity.sourceUuid ?? '');
    if (!baseObject || baseObject.name !== identity.name) {
      return { reason: 'Adopted anchor не совпадает с объектом доказанной базовой конфигурации.' };
    }
    if (!targetObject || targetObject.identity?.ownership !== 'own'
      || !sameUuid(targetObject.identity.uuid, identity.sourceUuid) || targetObject.identity.type !== identity.type) {
      return { reason: 'Целевая CF не содержит точный объект base anchor.' };
    }
    if (targetObject.qualifiedName !== incoming.qualifiedName) {
      return { reason: 'Adopted object qualified name отличается от base object.' };
    }
    if (incoming.sidecarFiles.length > 0 || hasNonEmptyChildObjects(incoming)) {
      return { reason: 'Adopted object содержит sidecars или children; перенос в CF отброшенные данные потерял бы.' };
    }
    if (!isValidPropertyState(incoming) || hasUnknownInterceptShape(incoming)) {
      return { reason: 'Adopted object содержит неподдерживаемый PropertyState или форму intercept.' };
    }
    if (hasUnsupportedPropertyChanges(incoming, baseObject)) {
      return { reason: 'Adopted object меняет свойства за пределами разрешённого overlay Synonym/Comment/whitelisted booleans.' };
    }
    return { action: 'adopted-to-cf-overlay' };
  }

  if (target.rootKind !== 'cfe') {
    return { reason: 'Тип целевого корня не подтверждён.' };
  }
  if (target.rootKind === 'cfe' && input.incoming.rootKind === 'cf') {
    return { reason: 'CF не может быть источником adopted object.' };
  }
  if (!sameProvenBase) {
    return { reason: 'Для CFE↔CFE adopted transfer не доказана эквивалентность базовых root/object descriptors.' };
  }
  if (input.target.purpose !== input.incoming.purpose) {
    return { reason: 'Перенос adopted object между разными ConfigurationExtensionPurpose не поддержан.' };
  }
  if (targetObject && (targetObject.identity?.ownership !== 'adopted'
    || !sameUuid(targetObject.identity.sourceUuid, identity.sourceUuid))) {
    return { reason: 'Qualified name цели занят объектом с другим ownership или anchor.' };
  }
  if (!isValidPropertyState(incoming) || hasUnknownInterceptShape(incoming)) {
    return { reason: 'В adopted descriptor обнаружен неизвестный intercept или некорректный PropertyState.' };
  }
  return { action: 'adopted-cfe-copy' };
}

function findTargetMatch(
  incoming: ExtensionIndexedObject,
  input: Parameters<typeof analyzeExtensionTransfers>[0],
): { object?: ExtensionIndexedObject; reason?: string; sameProvenBase?: boolean } {
  const identity = incoming.identity;
  if (!identity) {
    return { object: findByQualifiedName(input.target.objects, incoming.qualifiedName) };
  }
  const sameQualifiedName = findByQualifiedName(input.target.objects, incoming.qualifiedName);
  let object: ExtensionIndexedObject | undefined;
  if (identity.ownership === 'own') {
    object = input.target.objects.find((item) => item.identity?.ownership === 'own'
      && item.identity.type === identity.type && item.identity.uuid.toLowerCase() === identity.uuid.toLowerCase());
    if (input.target.rootKind === 'cfe' && input.incoming.rootKind === 'cf' && input.targetBaseIsIncoming
      && isEquivalentOwnObject(input.targetBase ?? input.incoming, input.incoming, identity.type, identity.uuid)) {
      const adopted = input.target.objects.find((item) => item.identity?.ownership === 'adopted'
        && item.identity.type === identity.type
        && item.identity.sourceUuid?.toLowerCase() === identity.uuid.toLowerCase());
      object = object ?? adopted;
    }
  } else {
    if (input.target.rootKind === 'cfe') {
      object = input.target.objects.find((item) => item.identity?.ownership === 'adopted'
        && item.identity.type === identity.type
        && item.identity.sourceUuid?.toLowerCase() === identity.sourceUuid?.toLowerCase());
    } else {
      object = input.target.objects.find((item) => item.identity?.ownership === 'own'
        && item.identity.type === identity.type
        && item.identity.uuid.toLowerCase() === identity.sourceUuid?.toLowerCase());
    }
  }
  if (sameQualifiedName && object && sameQualifiedName !== object) {
    return { object: sameQualifiedName, reason: 'Qualified name и semantic UUID/anchor указывают на разные объекты цели.' };
  }
  const sameProvenBase = identity.ownership === 'adopted'
    ? compareBaseForAnchor(input.targetBase, input.incomingBase, identity.type, identity.sourceUuid)
    : undefined;
  return { object: object ?? sameQualifiedName, sameProvenBase };
}

function compareBaseForAnchor(
  targetBase: ExtensionMetadataIndex | undefined,
  incomingBase: ExtensionMetadataIndex | undefined,
  type: string,
  anchorUuid: string | undefined,
): boolean {
  if (!targetBase || !incomingBase || !anchorUuid) {
    return false;
  }
  if (targetBase.canonicalRootPath && targetBase.canonicalRootPath === incomingBase.canonicalRootPath) {
    return Boolean(findOwnBaseObject(targetBase, type, anchorUuid) && findOwnBaseObject(incomingBase, type, anchorUuid));
  }
  if (!targetBase.configurationUuid || targetBase.configurationUuid.toLowerCase() !== incomingBase.configurationUuid?.toLowerCase()
    || !targetBase.configurationHash || targetBase.configurationHash !== incomingBase.configurationHash) {
    return false;
  }
  const leftObject = findOwnBaseObject(targetBase, type, anchorUuid);
  const rightObject = findOwnBaseObject(incomingBase, type, anchorUuid);
  return Boolean(leftObject?.descriptorHash && leftObject.descriptorHash === rightObject?.descriptorHash);
}

function isSemanticTransferChanged(
  action: ExtensionTransferAction | undefined,
  target: ExtensionIndexedObject,
  incoming: ExtensionIndexedObject,
): boolean {
  if (!target.descriptorContent || !incoming.descriptorContent) {return true;}
  if (action === 'overlay-adopted' || action === 'adopted-to-cf-overlay') {
    return isSemanticOverlayChanged(target.descriptorContent, incoming.descriptorContent, incoming.metadataType);
  }
  let descriptorContent = incoming.descriptorContent;
  if (action === 'adopted-cfe-copy' && target.identity?.ownership === 'adopted') {
    const rebound = replaceRootUuid(descriptorContent, incoming.metadataType, target.identity.uuid);
    if (rebound) {descriptorContent = rebound;}
  }
  return !target.descriptorContent.equals(descriptorContent) || !sameSidecarFiles(target.sidecarFiles, incoming.sidecarFiles);
}

function sameSidecarFiles(
  targetFiles: readonly ExtensionIndexedObject['sidecarFiles'][number][],
  incomingFiles: readonly ExtensionIndexedObject['sidecarFiles'][number][],
): boolean {
  if (targetFiles.length !== incomingFiles.length) {return false;}
  const incomingHashes = new Map(incomingFiles.map((file) => [file.relativePath.toLocaleLowerCase(), file.hash]));
  return targetFiles.every((file) => incomingHashes.get(file.relativePath.toLocaleLowerCase()) === file.hash);
}

function isEquivalentOwnObject(
  expectedBase: ExtensionMetadataIndex,
  candidate: ExtensionMetadataIndex,
  type: string,
  anchorUuid: string,
): boolean {
  if (expectedBase.canonicalRootPath && expectedBase.canonicalRootPath === candidate.canonicalRootPath) {
    return Boolean(findOwnBaseObject(expectedBase, type, anchorUuid) && findOwnBaseObject(candidate, type, anchorUuid));
  }
  if (!expectedBase.configurationUuid
    || expectedBase.configurationUuid.toLowerCase() !== candidate.configurationUuid?.toLowerCase()
    || !expectedBase.configurationHash
    || expectedBase.configurationHash !== candidate.configurationHash) {
    return false;
  }
  const expectedObject = findOwnBaseObject(expectedBase, type, anchorUuid);
  const candidateObject = findOwnBaseObject(candidate, type, anchorUuid);
  return Boolean(expectedObject?.descriptorHash && expectedObject.descriptorHash === candidateObject?.descriptorHash);
}

function findOwnBaseObject(base: ExtensionMetadataIndex, type: string, uuid: string): ExtensionIndexedObject | undefined {
  return base.objects.find((object) => object.valid && object.identity?.ownership === 'own'
    && object.metadataType === type && object.identity.uuid.toLowerCase() === uuid.toLowerCase());
}

function duplicateReasons(objects: readonly ExtensionIndexedObject[]): Map<ExtensionIndexedObject, string> {
  const result = new Map<ExtensionIndexedObject, string>();
  const byUuid = new Map<string, ExtensionIndexedObject[]>();
  const byName = new Map<string, ExtensionIndexedObject[]>();
  const byAnchor = new Map<string, ExtensionIndexedObject[]>();
  for (const object of objects) {
    const identity = object.identity;
    if (identity) {
      addGroup(byUuid, identity.uuid.toLowerCase(), object);
      if (identity.ownership === 'adopted' && identity.sourceUuid) {
        addGroup(byAnchor, `${identity.type}:${identity.sourceUuid.toLowerCase()}`, object);
      }
    }
    addGroup(byName, object.qualifiedName.toLocaleLowerCase(), object);
  }
  for (const [key, group] of byUuid) {
    if (group.length > 1) {
      for (const object of group) {result.set(object, `UUID ${key} повторяется в корневых объектах одной стороны.`);}
    }
  }
  for (const [key, group] of byName) {
    if (group.length > 1) {
      for (const object of group) {result.set(object, `Qualified name ${key} повторяется в одной стороне.`);}
    }
  }
  for (const [key, group] of byAnchor) {
    if (group.length > 1) {
      for (const object of group) {result.set(object, `Adopted anchor ${key} повторяется в корневых объектах.`);}
    }
  }
  return result;
}

function addGroup(
  groups: Map<string, ExtensionIndexedObject[]>,
  key: string,
  object: ExtensionIndexedObject,
): void {
  const group = groups.get(key);
  if (group) {group.push(object);}
  else {groups.set(key, [object]);}
}

function publishedRootUuidCollision(
  target: ExtensionMetadataIndex,
  incoming: ExtensionIndexedObject,
  targetObject: ExtensionIndexedObject | undefined,
  action: ExtensionTransferAction,
): string | undefined {
  const uuid = finalPublishedRootUuid(incoming, targetObject, action);
  if (!uuid) {return undefined;}
  const collision = target.objects.find((object) => object !== targetObject
    && object.identity && sameUuid(object.identity.uuid, uuid));
  if (!collision) {return undefined;}
  return `Локальный UUID результата ${uuid} уже занят целевым объектом ${collision.qualifiedName}.`;
}

function finalPublishedRootUuid(
  incoming: ExtensionIndexedObject,
  targetObject: ExtensionIndexedObject | undefined,
  action: ExtensionTransferAction,
): string | undefined {
  if (action === 'borrow-shell') {return undefined;}
  if (action === 'overlay-adopted' || action === 'adopted-to-cf-overlay') {
    return targetObject?.identity?.uuid;
  }
  if (action === 'adopted-cfe-copy' && targetObject?.identity?.ownership === 'adopted') {
    return targetObject.identity.uuid;
  }
  return incoming.identity?.uuid;
}

function sameUuid(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left.toLowerCase() === right.toLowerCase();
}

function findByQualifiedName(objects: readonly ExtensionIndexedObject[], qualifiedName: string): ExtensionIndexedObject | undefined {
  return objects.find((item) => item.qualifiedName.toLocaleLowerCase() === qualifiedName.toLocaleLowerCase());
}

async function inspectUnregisteredTargetCollision(target: ExtensionMetadataIndex, incoming: ExtensionIndexedObject): Promise<string | undefined> {
  if (!incoming.descriptorRelativePath) {
    return 'Для объекта не вычислен безопасный target path.';
  }
  const targetRoot = target.canonicalRootPath ?? target.rootPath;
  const descriptorState = await captureMergePath(path.join(targetRoot, incoming.descriptorRelativePath), { retainContent: false });
  const sidecarState = incoming.sidecarRelativePath
    ? await captureMergePath(path.join(targetRoot, incoming.sidecarRelativePath), { retainContent: false })
    : { state: 'missing' } as const;
  if (descriptorState.state !== 'missing' || sidecarState.state !== 'missing') {
    return 'Target path уже занят незарегистрированным файловым объектом.';
  }
  return undefined;
}

function projectTransferRow(row: ExtensionTransferRow): CompareTreeNode {
  const reason = row.reason;
  return {
    id: row.id,
    label: row.qualifiedName,
    kind: 'extensionMetadataObject',
    status: row.status,
    leftValue: row.target?.descriptorRelativePath,
    rightValue: row.incoming?.descriptorRelativePath,
    mergeable: row.mergeable,
    ...(row.action === 'full-copy' || row.action === 'adopted-cfe-copy' ? { destructive: hasTargetOrphans(row) } : {}),
    ...(reason ? { conflict: { kind: 'unsupported', message: reason, blocking: true } } : {}),
    mergeState: row.mergeable
      ? { state: 'ready', targetFilePath: row.target?.descriptorRelativePath ?? row.incoming?.descriptorRelativePath }
      : { state: 'blocked', reason: reason ?? 'Объект не отличается или перенос не предусмотрен.' },
    children: [],
  };
}

function hasTargetOrphans(row: ExtensionTransferRow): boolean {
  if (!row.target || !row.incoming) {return false;}
  const sourcePaths = new Set(row.incoming.sidecarFiles.map((file) => file.relativePath.toLocaleLowerCase()));
  return row.target.sidecarFiles.some((file) => !sourcePaths.has(file.relativePath.toLocaleLowerCase()));
}

function rowId(object: ExtensionIndexedObject, status?: string): string {
  return `extension:${status ?? 'object'}:${encodeURIComponent(object.qualifiedName)}:${object.identity?.uuid.toLowerCase() ?? 'invalid'}`;
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
