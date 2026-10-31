import { createHash } from 'crypto';
import * as path from 'path';

import type { ExtensionIndexedObject, ExtensionMetadataIndex } from './extensionMetadataIndex';
import type { ExtensionTransferRow } from './extensionTransfer';
import { captureMergePath } from '../merge/mergeSnapshot';
import { MISSING_TARGET_HASH, type MergeFileWitness } from '../merge/mergePreview';
import type { AdoptedSemanticArtifactCapture } from './extensionAdoptedSemanticBridge';
import type { ExtensionAdoptedDirection, ExtensionAdoptedRowProof } from './extensionAdoptedSemanticContext';
import {
  projectCapturedAdoptedRightsPair,
  type CapturedAdoptedRightsRecipe,
  type CapturedAdoptedRightsSide,
} from './extensionAdoptedRightsBridge';
import { roleRightsSidecars } from './extensionSemanticSidecars';
import { sameExtensionRelativePath } from './extensionRoleRightsWholeTransferPolicy';

const RIGHTS_ROOT = '{http://v8.1c.ru/8.2/roles}Rights';

export interface ExtensionAdoptedPreparedRightsArtifact {
  readonly targetRelativePath: string;
  readonly sourceRelativePath: string;
  readonly targetHash: string;
  readonly sourceHash: string;
  readonly targetXml: Buffer;
  readonly sourceXml: Buffer;
  readonly recipe: CapturedAdoptedRightsRecipe;
  readonly issues: CapturedAdoptedRightsRecipe['issues'];
  readonly requiredWitnesses: readonly MergeFileWitness[];
}

export interface ExtensionAdoptedRightsBlocker {
  readonly targetRelativePath: string;
  readonly sourceRelativePath?: string;
  readonly reason: string;
}

export interface ExtensionAdoptedRightsPreparation {
  readonly artifact?: ExtensionAdoptedPreparedRightsArtifact;
  readonly blockers: readonly ExtensionAdoptedRightsBlocker[];
}

/** Captures and projects the physical Role Rights pair before it enters the ordinary semantic adapter. */
export async function prepareExtensionAdoptedRightsForRow(input: {
  readonly row: ExtensionTransferRow;
  readonly targetRoot: ExtensionMetadataIndex;
  readonly incomingRoot: ExtensionMetadataIndex;
  readonly direction: ExtensionAdoptedDirection;
  readonly proof: Extract<ExtensionAdoptedRowProof, { readonly ok: true }>;
  readonly targetDescriptor: AdoptedSemanticArtifactCapture;
  readonly sourceDescriptor: AdoptedSemanticArtifactCapture;
  readonly baseDescriptor: AdoptedSemanticArtifactCapture;
  readonly otherBaseDescriptor?: AdoptedSemanticArtifactCapture;
  readonly configurationWitnesses: readonly MergeFileWitness[];
}): Promise<ExtensionAdoptedRightsPreparation> {
  const target = input.row.target;
  const source = input.row.incoming;
  const base = input.proof.baseObject;
  const otherBase = input.proof.otherBaseObject;
  const blockerPath = target?.descriptorRelativePath
    ? `${target.descriptorRelativePath.replace(/\\/gu, '/').replace(/\.xml$/iu, '')}/Ext/Rights.xml`
    : input.row.qualifiedName;
  if (!target || !source || target.metadataType !== 'Role' || source.metadataType !== 'Role'
      || base.metadataType !== 'Role' || input.proof.otherBaseRoot && otherBase?.metadataType !== 'Role') {
    return blocker(blockerPath, 'Adopted Rights capture требует точные Role target/source/base objects.');
  }
  const objects = [target, source, base, ...(otherBase ? [otherBase] : [])];
  if (!objects.some((object) => roleRightsSidecars(object).size > 0)) {
    return { blockers: [] };
  }
  if (input.proof.otherBaseRoot && !input.otherBaseDescriptor) {
    return blocker(blockerPath, 'Для второй captured CF базы отсутствует Role descriptor witness.');
  }

  const [targetRights, sourceRights, baseRights, otherBaseRights] = await Promise.all([
    captureRightsSide(input.targetRoot, target, input.targetDescriptor, true),
    captureRightsSide(input.incomingRoot, source, input.sourceDescriptor, true),
    captureRightsSide(input.proof.baseRoot, base, input.baseDescriptor, false),
    input.proof.otherBaseRoot && otherBase && input.otherBaseDescriptor
      ? captureRightsSide(input.proof.otherBaseRoot, otherBase, input.otherBaseDescriptor, false)
      : Promise.resolve(undefined),
  ]);
  if (!targetRights.ok || !sourceRights.ok || !baseRights.ok || otherBaseRights && !otherBaseRights.ok) {
    const failure = !targetRights.ok ? targetRights.reason : !sourceRights.ok ? sourceRights.reason
      : !baseRights.ok ? baseRights.reason : otherBaseRights && !otherBaseRights.ok ? otherBaseRights.reason : 'Captured Rights side отсутствует.';
    return blocker(blockerPath, failure);
  }
  if (baseRights.side.kind !== 'file' || otherBaseRights && otherBaseRights.side.kind !== 'file') {
    return blocker(blockerPath, 'У каждой собственной captured CF базы должен быть физический Rights.xml.');
  }
  const additionalBaseWitnesses: MergeFileWitness[] = [];
  if (input.otherBaseDescriptor && otherBaseRights?.side.kind === 'file') {
    if (!sameHash(input.baseDescriptor.witness.expectedHash, input.otherBaseDescriptor.witness.expectedHash)
        || !sameHash(baseRights.side.capture.witness.expectedHash, otherBaseRights.side.capture.witness.expectedHash)) {
      return blocker(blockerPath, 'Captured CF Role descriptor или Rights.xml hashes различаются между двумя purported common bases.');
    }
    additionalBaseWitnesses.push(input.otherBaseDescriptor.witness, otherBaseRights.side.capture.witness);
  }

  const projected = projectCapturedAdoptedRightsPair({
    direction: input.direction,
    formatVersion: input.targetRoot.formatVersion ?? '',
    targetDescriptor: input.targetDescriptor,
    sourceDescriptor: input.sourceDescriptor,
    baseDescriptor: input.baseDescriptor,
    baseRights: baseRights.side.capture,
    targetRights: targetRights.side,
    sourceRights: sourceRights.side,
    configurationWitnesses: input.configurationWitnesses,
    ...(additionalBaseWitnesses.length ? { additionalBaseWitnesses } : {}),
  });
  if (!projected.ok) { return blocker(blockerPath, projected.reason); }
  return {
    blockers: [],
    artifact: {
      targetRelativePath: projected.recipe.targetRightsRelativePath,
      sourceRelativePath: projected.recipe.sourceRightsRelativePath,
      targetHash: sideHash(projected.recipe.targetRights),
      sourceHash: sideHash(projected.recipe.sourceRights),
      targetXml: projected.targetXml,
      sourceXml: projected.sourceXml,
      recipe: projected.recipe,
      issues: projected.issues,
      requiredWitnesses: dedupeWitnesses([
        ...projected.requiredWitnesses,
        ...targetRights.alternateMissingWitnesses,
        ...sourceRights.alternateMissingWitnesses,
        ...baseRights.alternateMissingWitnesses,
        ...(otherBaseRights?.alternateMissingWitnesses ?? []),
      ]),
    },
  };
}

async function captureRightsSide(
  root: ExtensionMetadataIndex,
  object: ExtensionIndexedObject,
  descriptor: AdoptedSemanticArtifactCapture,
  allowAdoptedMissing: boolean,
): Promise<RightsSideCaptureResult> {
  const allowedPaths = allowedRightsPaths(object);
  if (!allowedPaths) { return { ok: false, reason: `Не удалось определить точные физические Rights.xml aliases для ${object.qualifiedName}.` }; }
  const indexedRights = roleRightsSidecars(object);
  if (indexedRights.size > 1) {
    return { ok: false, reason: `Rights.xml ${object.qualifiedName} неоднозначен: найдено несколько физических sidecar paths.` };
  }
  const indexed = [...indexedRights.values()][0]?.file;
  if (indexed && !allowedPaths.some((candidate) => sameExtensionRelativePath(indexed.relativePath, candidate))) {
    return { ok: false, reason: `Rights.xml ${object.qualifiedName} находится вне двух допустимых Designer paths.` };
  }
  if (indexed) {
    return captureIndexedRightsSide({ root, object, descriptor, expectedPath: indexed.relativePath, indexed });
  }
  if (!allowAdoptedMissing || descriptor.identity.ownership !== 'adopted' || root.rootKind !== 'cfe') {
    return { ok: false, reason: `Собственный Rights.xml для ${object.qualifiedName} отсутствует; его физическое отсутствие не подтверждено.` };
  }

  const missingWitnesses: MergeFileWitness[] = [];
  for (const relativePath of allowedPaths) {
    const absolute = path.resolve(root.canonicalRootPath ?? root.rootPath, relativePath);
    let snapshot;
    try { snapshot = await captureMergePath(absolute, { retainContent: false }); }
    catch (error) { return { ok: false, reason: `Не удалось захватить ${relativePath}: ${errorMessage(error)}` }; }
    if (snapshot.state !== 'missing') {
      return { ok: false, reason: `Физический Rights.xml обнаружен без соответствующей индексированной регистрации: ${relativePath}.` };
    }
    missingWitnesses.push({ sourceId: root.sourceId, relativePath, expectedHash: MISSING_TARGET_HASH, kind: 'file' });
  }
  const selectedPath = allowedPaths.find((candidate) => candidate.endsWith('/Ext/Rights.xml')) ?? allowedPaths[0]!;
  const extraMissing = missingWitnesses.find((witness) => !sameExtensionRelativePath(witness.relativePath, selectedPath));
  return {
    ok: true,
    side: { kind: 'missing', witness: { sourceId: root.sourceId, relativePath: selectedPath, expectedHash: MISSING_TARGET_HASH, kind: 'file' } },
    alternateMissingWitnesses: extraMissing ? [extraMissing] : [],
  };
}

type RightsSideCaptureResult =
  | { readonly ok: true; readonly side: CapturedAdoptedRightsSide; readonly alternateMissingWitnesses: readonly MergeFileWitness[] }
  | { readonly ok: false; readonly reason: string };

async function captureIndexedRightsSide(input: {
  readonly root: ExtensionMetadataIndex;
  readonly object: ExtensionIndexedObject;
  readonly descriptor: AdoptedSemanticArtifactCapture;
  readonly expectedPath: string;
  readonly indexed: ExtensionIndexedObject['sidecarFiles'][number];
}): Promise<RightsSideCaptureResult> {
  const absolute = path.resolve(input.root.canonicalRootPath ?? input.root.rootPath, input.expectedPath);
  let snapshot;
  try {
    snapshot = await captureMergePath(absolute, { retainContent: true });
  } catch (error) {
    return { ok: false, reason: `Не удалось захватить ${input.expectedPath}: ${errorMessage(error)}` };
  }
  if (snapshot.state === 'missing') {
    return { ok: false, reason: `Индексированный Rights.xml отсутствует после compare: ${input.expectedPath}.` };
  }
  if (snapshot.state !== 'file' || snapshot.contentBase64 === undefined) {
    return { ok: false, reason: `Физический ${input.expectedPath} не совпадает с индексированным regular Rights.xml.` };
  }
  const content = Buffer.from(snapshot.contentBase64, 'base64');
  if (input.indexed.rootExpandedName !== RIGHTS_ROOT || !sameHash(snapshot.hash, input.indexed.hash)
      || hash(content) !== normalizeHash(snapshot.hash)) {
    return { ok: false, reason: `Captured ${input.expectedPath} не совпадает с индексированным Rights root/SHA-256.` };
  }
  return {
    ok: true,
    side: {
      kind: 'file',
      capture: {
        content,
        witness: { sourceId: input.root.sourceId, relativePath: input.expectedPath, expectedHash: normalizeHash(snapshot.hash), kind: 'file' },
        identity: input.descriptor.identity,
      },
    },
    alternateMissingWitnesses: [],
  };
}

function allowedRightsPaths(object: ExtensionIndexedObject): readonly string[] | undefined {
  if (object.metadataType !== 'Role' || !object.identity || object.identity.type !== 'Role'
      || object.identity.name !== object.name || !object.descriptorRelativePath
      || !sameExtensionRelativePath(object.descriptorRelativePath, `Roles/${object.name}.xml`)
      || !sameExtensionRelativePath(object.identity.path, object.descriptorRelativePath)
      || !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(object.name)) {return undefined;}
  const owner = `Roles/${object.name}`;
  return [`${owner}/Rights.xml`, `${owner}/Ext/Rights.xml`];
}

function sideHash(side: CapturedAdoptedRightsSide): string {
  return side.kind === 'file' ? normalizeHash(side.capture.witness.expectedHash) : side.witness.expectedHash;
}

function blocker(targetRelativePath: string, reason: string): ExtensionAdoptedRightsPreparation {
  return { blockers: [{ targetRelativePath, reason }] };
}

function dedupeWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] {
  const result = new Map<string, MergeFileWitness>();
  for (const witness of witnesses) {
    const pathKey = process.platform === 'win32' ? witness.relativePath.toLowerCase() : witness.relativePath;
    const key = `${witness.sourceId}\0${pathKey}\0${witness.kind ?? 'file'}`;
    const previous = result.get(key);
    if (previous && !sameHash(previous.expectedHash, witness.expectedHash)) {
      throw new Error(`Conflicting Rights witnesses for ${witness.sourceId}:${witness.relativePath}.`);
    }
    result.set(key, witness);
  }
  return [...result.values()];
}

function sameHash(left: string, right: string): boolean { return normalizeHash(left) === normalizeHash(right); }
function normalizeHash(value: string): string { return value.replace(/^sha256:/iu, '').toLowerCase(); }
function hash(content: Buffer): string { return createHash('sha256').update(content).digest('hex'); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
