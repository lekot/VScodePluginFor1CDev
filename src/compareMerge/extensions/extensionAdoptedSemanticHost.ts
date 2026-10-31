import { createHash } from 'crypto';
import * as path from 'path';
import { compareOrdinalStrings } from '../ordinalStringOrder';

import { parseCfeObjectIdentity, type CfeObjectIdentity } from '../../extensionSupport/cfeProject/ownership';
import { requiredLinkedDesignerBodyPath } from '../linkedDesignerPackageRules';
import type { XmlPatchPayload, MergeFileWitness } from '../merge/mergePreview';
import { MISSING_TARGET_HASH } from '../merge/mergePreview';
import { applySelectedXmlPatches } from '../merge/semanticXmlMerge';
import { captureMergePath } from '../merge/mergeSnapshot';
import { elementChildren, parseXmlDocument, textContent, type XmlElement } from '../xml/xmlDom';
import { localFilePath } from '../adapters/semanticXml/semanticXmlAdapterUtils';
import { getExplicitGeneratedTypeSpecs } from '../../utils/xml/metadataGeneratedTypeSchema';
import type { ExtensionSemanticWrite } from './extensionSemanticMaterializer';
import { type ExtensionIndexedObject, type ExtensionMetadataIndex } from './extensionMetadataIndex';
import type { ExtensionTransferRow } from './extensionTransfer';
import type { ExtensionLinkedDesignerPackage } from './extensionLinkedDesignerPackages';
import {
  prepareExtensionAdoptedRightsForRow,
  type ExtensionAdoptedRightsPreparation,
} from './extensionAdoptedRightsHost';
import {
  prepareExtensionAdoptedOwnForms,
  type ExtensionAdoptedOwnFormPreparation,
} from './extensionAdoptedOwnFormHost';
import {
  prepareExtensionAdoptedTemplatesForRow,
  type ExtensionAdoptedTemplatePreparation,
} from './extensionAdoptedTemplateHost';
import type { ExtensionAdoptedProjectionIssue } from './adoptedDesignerCandidatePolicy';
import {
  allocateExtensionAdoptedChildUuids,
  allocatedChildUuidProof,
  copiedOwnChildUuidProof,
  promotedChildUuidProof,
  type ExtensionAdoptedUuidSnapshot,
} from './adoptedDesignerUuidContext';
import { introducedAdoptedDescriptorUuidDefinitions } from './adoptedDesignerPhysicalUuidDefinitions';
import {
  collectExtensionAdoptedChildUuidRequirements,
  materializeExtensionAdoptedArtifact,
  projectExtensionAdoptedDescriptor,
  projectExtensionAdoptedForm,
  type AdoptedSemanticArtifactCapture,
  type AdoptedSemanticArtifactRecipe,
} from './extensionAdoptedSemanticBridge';
import type { AdoptedDesignerIdentity } from './adoptedDesignerProjection';
import { createAdoptedDesignerTypeIdResolver, type AdoptedDesignerTypeIdReferenceDescriptor } from './adoptedDesignerTypeId';
import {
  captureExtensionAdoptedConfigurationWitnesses,
  directionForExtensionAdoptedRow,
  resolveExtensionAdoptedRowProof,
  type ExtensionAdoptedDirection,
  type ExtensionAdoptedRowProof,
} from './extensionAdoptedSemanticContext';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const READABLE_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/readable';
const FORM_METADATA_TYPES = new Set(['Form', 'CommonForm']);
const UUID_PATTERN = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;

export type { ExtensionAdoptedDirection } from './extensionAdoptedSemanticContext';
export { createExtensionAdoptedUuidSnapshot } from './adoptedDesignerUuidContext';
export type { ExtensionAdoptedUuidSnapshot } from './adoptedDesignerUuidContext';

export interface ExtensionAdoptedPreparedArtifact {
  readonly kind: 'metadataXml' | 'formXml';
  readonly targetRelativePath: string;
  readonly sourceRelativePath: string;
  /** The absolute left-side path used by the semantic adapter's XML addresses. */
  readonly targetFilePath: string;
  readonly sourceFilePath: string;
  /** Raw physical hashes; a missing Form body uses MISSING_TARGET_HASH. */
  readonly targetHash: string;
  readonly sourceHash: string;
  readonly targetXml: Buffer;
  readonly sourceXml: Buffer;
  readonly recipe: AdoptedSemanticArtifactRecipe;
  readonly issues: readonly ExtensionAdoptedProjectionIssue[];
  /** Raw registry witnesses keyed by the new child's normalized UUID. */
  readonly uuidCandidateWitnesses: ReadonlyMap<string, readonly MergeFileWitness[]>;
  /** Extra raw witnesses for the owner and nested Form descriptor registrations. */
  readonly dependencyWitnesses: readonly MergeFileWitness[];
}

export interface ExtensionAdoptedScopedBlocker {
  readonly kind: 'metadataXml' | 'formXml';
  readonly targetRelativePath: string;
  readonly sourceRelativePath?: string;
  readonly reason: string;
}

export type ExtensionAdoptedRowPreparation =
  | { readonly applicable: false }
  | {
    readonly applicable: true;
    readonly direction: ExtensionAdoptedDirection;
    readonly artifacts: readonly ExtensionAdoptedPreparedArtifact[];
    readonly blockers: readonly ExtensionAdoptedScopedBlocker[];
    readonly ownForms?: ExtensionAdoptedOwnFormPreparation;
    readonly rights?: ExtensionAdoptedRightsPreparation;
    readonly templates?: ExtensionAdoptedTemplatePreparation;
  };

export type ExtensionAdoptedBatchMaterialization =
  | { readonly ok: true; readonly changed: false }
  | {
    readonly ok: true;
    readonly changed: true;
    readonly write: ExtensionSemanticWrite;
    readonly expectedTargetHash: string;
  }
  | { readonly ok: false; readonly reason: string };

/** Prepares only actions whose ownership direction and exact CF base are host-proven. */
export async function prepareExtensionAdoptedSemanticRow(input: {
  readonly row: ExtensionTransferRow;
  readonly targetRoot: ExtensionMetadataIndex;
  readonly incomingRoot: ExtensionMetadataIndex;
  readonly uuidSnapshot: ExtensionAdoptedUuidSnapshot;
  readonly linkedPackages?: readonly ExtensionLinkedDesignerPackage[];
}): Promise<ExtensionAdoptedRowPreparation> {
  const direction = directionForExtensionAdoptedRow(input.row);
  if (!direction) { return { applicable: false }; }
  const artifacts: ExtensionAdoptedPreparedArtifact[] = [];
  const blockers: ExtensionAdoptedScopedBlocker[] = [];
  const proof = resolveExtensionAdoptedRowProof(input.row, input.targetRoot, input.incomingRoot, direction);
  if (!proof.ok) {
    return {
      applicable: true,
      direction,
      artifacts,
      blockers: [{ kind: 'metadataXml', targetRelativePath: input.row.target?.descriptorRelativePath ?? '', reason: proof.reason }],
    };
  }

  const configurationWitnesses = await captureExtensionAdoptedConfigurationWitnesses({
    targetRoot: input.targetRoot,
    incomingRoot: input.incomingRoot,
    baseRoots: [proof.baseRoot, ...(proof.otherBaseRoot ? [proof.otherBaseRoot] : [])],
  });
  if (!configurationWitnesses.ok) {
    return {
      applicable: true,
      direction,
      artifacts,
      blockers: [{ kind: 'metadataXml', targetRelativePath: input.row.target!.descriptorRelativePath ?? '', reason: configurationWitnesses.reason }],
    };
  }

  const ownForms = await prepareExtensionAdoptedOwnForms({
    row: input.row,
    targetRoot: input.targetRoot,
    incomingRoot: input.incomingRoot,
    proof,
    uuidSnapshot: input.uuidSnapshot,
    linkedPackages: input.linkedPackages ?? [],
    configurationWitnesses: configurationWitnesses.witnesses,
  });
  for (const ownFormBlocker of ownForms.blockers) {
    blockers.push({ kind: 'formXml', targetRelativePath: ownFormBlocker.relativePath, reason: ownFormBlocker.reason });
  }

  const targetCapture = await captureObjectDescriptor(input.targetRoot, input.row.target!);
  const sourceCapture = await captureObjectDescriptor(input.incomingRoot, input.row.incoming!);
  const baseCapture = await captureObjectDescriptor(proof.baseRoot, proof.baseObject);
  const otherBaseCapture = proof.otherBaseRoot && proof.otherBaseObject
    ? await captureObjectDescriptor(proof.otherBaseRoot, proof.otherBaseObject)
    : undefined;
  if (!targetCapture.ok || !sourceCapture.ok || !baseCapture.ok || otherBaseCapture && !otherBaseCapture.ok) {
    const failure = !targetCapture.ok ? targetCapture.reason : !sourceCapture.ok ? sourceCapture.reason
      : !baseCapture.ok ? baseCapture.reason : otherBaseCapture && !otherBaseCapture.ok ? otherBaseCapture.reason
        : 'Не удалось захватить descriptor.';
    return {
      applicable: true,
      direction,
      artifacts,
      blockers: [{ kind: 'metadataXml', targetRelativePath: input.row.target!.descriptorRelativePath ?? '', sourceRelativePath: input.row.incoming!.descriptorRelativePath, reason: failure }],
    };
  }

  const rights = input.row.target?.metadataType === 'Role' && input.row.incoming?.metadataType === 'Role'
    ? await prepareExtensionAdoptedRightsForRow({
      row: input.row,
      targetRoot: input.targetRoot,
      incomingRoot: input.incomingRoot,
      direction,
      proof,
      targetDescriptor: targetCapture.capture,
      sourceDescriptor: sourceCapture.capture,
      baseDescriptor: baseCapture.capture,
      ...(otherBaseCapture?.ok ? { otherBaseDescriptor: otherBaseCapture.capture } : {}),
      configurationWitnesses: configurationWitnesses.witnesses,
    })
    : undefined;
  const templates = await prepareExtensionAdoptedTemplatesForRow({
    row: input.row,
    targetRoot: input.targetRoot,
    incomingRoot: input.incomingRoot,
    direction,
    proof,
    ownerCaptures: {
      target: targetCapture.capture,
      source: sourceCapture.capture,
      targetBase: baseCapture.capture,
      sourceBase: otherBaseCapture?.ok ? otherBaseCapture.capture : baseCapture.capture,
    },
    configurationWitnesses: configurationWitnesses.witnesses,
  });

  const typeIdReferenceDescriptors = typeIdContext(direction, input.incomingRoot, proof.baseRoot, proof.otherBaseRoot);
  const descriptorDependencyWitnesses = dedupeWitnesses([
    ...configurationWitnesses.witnesses,
    ...(otherBaseCapture?.ok ? [otherBaseCapture.capture.witness] : []),
    ...ownForms.descriptorWitnesses,
  ]);
  const descriptorInput = {
    direction,
    target: targetCapture.capture,
    source: sourceCapture.capture,
    base: baseCapture.capture,
    formatVersion: input.targetRoot.formatVersion ?? '',
    typeIdReferenceDescriptors,
    ownFormRegistrations: ownForms.ownFormRegistrations,
  } as const;
  if (direction === 'cf-to-adopted') {
    const requirements = collectExtensionAdoptedChildUuidRequirements(descriptorInput);
    if (!requirements.ok) {
      blockers.push({ kind: 'metadataXml', targetRelativePath: input.row.target!.descriptorRelativePath!, sourceRelativePath: input.row.incoming!.descriptorRelativePath, reason: requirements.reason });
    } else {
      const allocation = allocateExtensionAdoptedChildUuids(requirements.requirements, input.uuidSnapshot);
      if (!allocation.ok) {
        blockers.push({ kind: 'metadataXml', targetRelativePath: input.row.target!.descriptorRelativePath!, sourceRelativePath: input.row.incoming!.descriptorRelativePath, reason: allocation.reason });
      } else {
        const projected = projectExtensionAdoptedDescriptor({ ...descriptorInput, adoptedChildUuidByAnchor: allocation.map });
        const uuidProof = combineUuidProofs(
          allocatedChildUuidProof(input.uuidSnapshot, requirements.requirements, allocation.map),
          copiedOwnChildUuidProof(
            input.uuidSnapshot,
            sourceCapture.capture.content,
            baseCapture.capture.content,
            targetCapture.capture.content,
            proof.provenOwnerRootUuid,
            targetCapture.capture.witness.relativePath,
          ),
        );
        addDescriptorProjection(projected, input, allocation.map, typeIdReferenceDescriptors, descriptorDependencyWitnesses, artifacts, blockers, uuidProof);
      }
    }
  } else {
    const requirements = collectExtensionAdoptedChildUuidRequirements(descriptorInput);
    if (!requirements.ok) {
      blockers.push({ kind: 'metadataXml', targetRelativePath: input.row.target!.descriptorRelativePath!, sourceRelativePath: input.row.incoming!.descriptorRelativePath, reason: requirements.reason });
    } else {
      const allocation = allocateExtensionAdoptedChildUuids(requirements.requirements, input.uuidSnapshot);
      if (!allocation.ok) {
        blockers.push({ kind: 'metadataXml', targetRelativePath: input.row.target!.descriptorRelativePath!, sourceRelativePath: input.row.incoming!.descriptorRelativePath, reason: allocation.reason });
      } else {
        const projected = projectExtensionAdoptedDescriptor({ ...descriptorInput, adoptedChildUuidByAnchor: allocation.map });
        const uuidProof = combineUuidProofs(
          allocatedChildUuidProof(input.uuidSnapshot, requirements.requirements, allocation.map),
          direction === 'adopted-to-adopted'
            ? copiedOwnChildUuidProof(
              input.uuidSnapshot,
              sourceCapture.capture.content,
              baseCapture.capture.content,
              targetCapture.capture.content,
              proof.provenOwnerRootUuid,
              targetCapture.capture.witness.relativePath,
            )
            : promotedChildUuidProof(input.uuidSnapshot, sourceCapture.capture.content, baseCapture.capture.content, proof.provenOwnerRootUuid),
        );
        addDescriptorProjection(projected, input, allocation.map, typeIdReferenceDescriptors, descriptorDependencyWitnesses, artifacts, blockers, uuidProof);
      }
    }
  }

  await prepareFormArtifacts(input, proof, direction, descriptorDependencyWitnesses, artifacts, blockers, ownForms);
  return { applicable: true, direction, artifacts, blockers, ownForms, ...(rights ? { rights } : {}), templates };
}

/** Applies one artifact's selected patch batch to its logical target and re-encodes physical XML. */
export function materializeExtensionAdoptedPatchBatch(input: {
  readonly artifact: ExtensionAdoptedPreparedArtifact;
  readonly targetRelativePath: string;
  readonly patches: readonly XmlPatchPayload[];
  readonly supplementalWitnesses?: readonly MergeFileWitness[];
}): ExtensionAdoptedBatchMaterialization {
  const { artifact, patches } = input;
  if (normalizeRelativePath(input.targetRelativePath) !== normalizeRelativePath(artifact.targetRelativePath)) {
    return { ok: false, reason: 'Выбранные XML-операции относятся к другому целевому файлу.' };
  }
  if (patches.length === 0) { return { ok: true, changed: false }; }
  const expectedFilePath = path.resolve(artifact.targetFilePath);
  for (const patch of patches) {
    if (patch.semanticKind !== artifact.kind) {
      return { ok: false, reason: 'Пакет содержит XML-операцию другого вида документа.' };
    }
    const addresses = [patch.target, patch.destinationParent, patch.insertBefore].filter((value) => value !== undefined);
    if (addresses.some((address) => !sameFilePath(localFilePath(address.filePath), expectedFilePath))) {
      return { ok: false, reason: 'XML-операция ссылается на файл вне выбранного adopted-артефакта.' };
    }
  }

  const applied = applySelectedXmlPatches(artifact.recipe.initialLogicalTarget.toString('utf8'), patches);
  if (!applied.ok) { return { ok: false, reason: applied.message }; }
  const materialized = materializeExtensionAdoptedArtifact(artifact.recipe, Buffer.from(applied.source, 'utf8'));
  if (!materialized.ok) { return { ok: false, reason: materialized.reason }; }
  if (artifact.targetHash !== MISSING_TARGET_HASH && hash(materialized.content) === normalizeHash(artifact.targetHash)) {
    return { ok: true, changed: false };
  }
  const uuidWitnesses = introducedDefinitionUuidWitnesses(artifact, materialized.content);
  if (!uuidWitnesses.ok) { return uuidWitnesses; }
  const writeWitnesses = physicalWriteWitnesses(
    artifact,
    [...materialized.requiredWitnesses, ...uuidWitnesses.witnesses],
    patches,
    input.supplementalWitnesses ?? [],
  );
  if (!writeWitnesses.ok) { return writeWitnesses; }
  const write: ExtensionSemanticWrite = {
    relativePath: artifact.targetRelativePath,
    content: materialized.content,
    sourceWitnesses: writeWitnesses.witnesses,
  };
  return { ok: true, changed: true, write, expectedTargetHash: artifact.targetHash };
}

async function prepareFormArtifacts(
  input: Parameters<typeof prepareExtensionAdoptedSemanticRow>[0],
  proof: Extract<ExtensionAdoptedRowProof, { readonly ok: true }>,
  direction: ExtensionAdoptedDirection,
  configurationWitnesses: readonly MergeFileWitness[],
  artifacts: ExtensionAdoptedPreparedArtifact[],
  blockers: ExtensionAdoptedScopedBlocker[],
  ownForms: ExtensionAdoptedOwnFormPreparation,
): Promise<void> {
  const targetOwner = input.row.target!;
  const sourceOwner = input.row.incoming!;
  const baseOwner = proof.baseObject;
  const [targetForms, sourceForms, baseForms, otherBaseForms] = await Promise.all([
    readFormRecords(input.targetRoot, targetOwner),
    readFormRecords(input.incomingRoot, sourceOwner),
    readFormRecords(proof.baseRoot, baseOwner),
    proof.otherBaseRoot && proof.otherBaseObject
      ? readFormRecords(proof.otherBaseRoot, proof.otherBaseObject)
      : Promise.resolve(undefined),
  ]);
  for (const result of [targetForms, sourceForms, baseForms, ...(otherBaseForms ? [otherBaseForms] : [])]) {
    if (!result.ok) {
      const root = result.root;
      blockers.push({ kind: 'formXml', targetRelativePath: root, reason: result.reason });
    }
  }
  if (!targetForms.ok || !sourceForms.ok || !baseForms.ok || otherBaseForms && !otherBaseForms.ok) { return; }
  const sourceByName = mapForms(sourceForms.forms);
  const baseByName = mapForms(baseForms.forms);
  const otherBaseByName = otherBaseForms?.ok ? mapForms(otherBaseForms.forms) : undefined;
  const targetByName = mapForms(targetForms.forms);
  const authorizedOwnSourceForms = new Set(ownForms.ownFormRegistrations.source.map(normalizeName));
  for (const [key, sourceForm] of sourceByName) {
    if (authorizedOwnSourceForms.has(key)) { continue; }
    const baseForm = baseByName.get(key);
    const otherBaseForm = otherBaseByName?.get(key);
    if (!baseForm || sourceForm.identity.type !== baseForm.identity.type) {
      blockers.push({
        kind: 'formXml',
        targetRelativePath: targetFormBodyPath(targetOwner, sourceForm.name),
        sourceRelativePath: sourceForm.bodyRelativePath,
        reason: 'Формы нет в захваченной базе; для новой формы нужен связанный перенос регистрации, дескриптора и файлов',
      });
      continue;
    }
    if (proof.otherBaseRoot && (!otherBaseForm
      || otherBaseForm.identity.type !== baseForm.identity.type
      || !baseForm.descriptorCapture || !otherBaseForm.descriptorCapture
      || normalizeHash(baseForm.descriptorCapture.witness.expectedHash) !== normalizeHash(otherBaseForm.descriptorCapture.witness.expectedHash)
      || Boolean(baseForm.bodyCapture) !== Boolean(otherBaseForm.bodyCapture)
      || baseForm.bodyCapture && otherBaseForm.bodyCapture
        && normalizeHash(baseForm.bodyCapture.witness.expectedHash) !== normalizeHash(otherBaseForm.bodyCapture.witness.expectedHash))) {
      blockers.push({ kind: 'formXml', targetRelativePath: baseForm.bodyRelativePath, sourceRelativePath: sourceForm.bodyRelativePath, reason: 'Используемые nested Form descriptor/body hashes различаются между captured CF базами.' });
      continue;
    }
    const targetForm = targetByName.get(key);
    if (!targetForm) {
      blockers.push({ kind: 'formXml', targetRelativePath: sourceForm.bodyRelativePath, sourceRelativePath: sourceForm.bodyRelativePath, reason: 'У target нет зарегистрированного Form-дескриптора; host не создаёт новую Form-регистрацию или дескриптор в этой projection.' });
      continue;
    }
    if (targetForm.identity.type !== sourceForm.identity.type || targetForm.identity.type !== baseForm.identity.type) {
      blockers.push({ kind: 'formXml', targetRelativePath: targetForm.bodyRelativePath, sourceRelativePath: sourceForm.bodyRelativePath, reason: 'Target, source и proven base Form имеют разные виды метаданных.' });
      continue;
    }
    if (!sourceForm.bodyCapture || !baseForm.bodyCapture) {
      blockers.push({ kind: 'formXml', targetRelativePath: targetForm.bodyRelativePath, sourceRelativePath: sourceForm.bodyRelativePath, reason: 'Не удалось подтвердить физический source/base Form.xml для adopted projection.' });
      continue;
    }
    const targetRegistrationWitnesses = [
      witnessForObject(input.targetRoot, targetOwner),
      targetForm.descriptorCapture?.witness,
    ].filter((witness): witness is MergeFileWitness => witness !== undefined);
    let result;
    if (!targetForm.bodyCapture) {
      if (direction !== 'cf-to-adopted' || !targetForm.descriptorCapture) {
        blockers.push({ kind: 'formXml', targetRelativePath: targetForm.bodyRelativePath, sourceRelativePath: sourceForm.bodyRelativePath, reason: 'Отсутствующий Form.xml можно синтезировать только для уже зарегистрированной CF→CFE borrowed Form.' });
        continue;
      }
      const missingTarget = {
        identity: targetForm.identity,
        relativePath: targetForm.bodyRelativePath,
        targetWitness: {
          sourceId: input.targetRoot.sourceId,
          relativePath: targetForm.bodyRelativePath,
          expectedHash: MISSING_TARGET_HASH,
          kind: 'file' as const,
        },
        registrationWitnesses: targetRegistrationWitnesses,
      };
      result = projectExtensionAdoptedForm({
        direction,
        missingTarget,
        source: sourceForm.bodyCapture,
        baseForm: baseForm.bodyCapture,
        formatVersion: input.targetRoot.formatVersion ?? '',
      });
    } else {
      result = projectExtensionAdoptedForm({
        direction,
        target: targetForm.bodyCapture,
        source: sourceForm.bodyCapture,
        baseForm: baseForm.bodyCapture,
        formatVersion: input.targetRoot.formatVersion ?? '',
      });
    }
    if (!result.ok) {
      blockers.push({ kind: 'formXml', targetRelativePath: targetForm.bodyRelativePath, sourceRelativePath: sourceForm.bodyRelativePath, reason: result.reason });
      continue;
    }
    artifacts.push({
      kind: 'formXml',
      targetRelativePath: targetForm.bodyRelativePath,
      sourceRelativePath: sourceForm.bodyRelativePath,
      targetFilePath: path.resolve(input.targetRoot.canonicalRootPath ?? input.targetRoot.rootPath, targetForm.bodyRelativePath),
      sourceFilePath: path.resolve(input.incomingRoot.canonicalRootPath ?? input.incomingRoot.rootPath, sourceForm.bodyRelativePath),
      targetHash: result.recipe.kind === 'adopted-form' && result.recipe.targetWasMissing ? MISSING_TARGET_HASH : targetForm.bodyCapture?.witness.expectedHash ?? '',
      sourceHash: sourceForm.bodyCapture.witness.expectedHash,
      targetXml: Buffer.from(result.targetXml),
      sourceXml: Buffer.from(result.sourceXml),
      recipe: result.recipe,
      issues: result.issues,
      uuidCandidateWitnesses: new Map(),
      dependencyWitnesses: dedupeWitnesses([
        ...configurationWitnesses,
        ...targetRegistrationWitnesses,
        targetForm.descriptorCapture?.witness,
        sourceForm.descriptorCapture?.witness,
        baseForm.descriptorCapture?.witness,
        otherBaseForm?.descriptorCapture?.witness,
        otherBaseForm?.bodyCapture?.witness,
      ].filter((witness): witness is MergeFileWitness => witness !== undefined)),
    });
  }
}

function targetFormBodyPath(owner: ExtensionIndexedObject, formName: string): string {
  const ownerSidecar = owner.sidecarRelativePath?.replace(/\\/gu, '/');
  if (!ownerSidecar || !formName || formName === '.' || formName === '..' || /[\\/\0]/u.test(formName)) {
    return owner.descriptorRelativePath ?? '';
  }
  const normalizedOwner = path.posix.normalize(ownerSidecar);
  if (normalizedOwner === '.' || normalizedOwner === '..' || normalizedOwner.startsWith('../') || path.posix.isAbsolute(normalizedOwner)) {
    return owner.descriptorRelativePath ?? '';
  }
  return path.posix.join(normalizedOwner, 'Forms', formName, 'Ext', 'Form.xml');
}

function addDescriptorProjection(
  projected: ReturnType<typeof projectExtensionAdoptedDescriptor>,
  input: Parameters<typeof prepareExtensionAdoptedSemanticRow>[0],
  adoptedChildUuidByAnchor: ReadonlyMap<string, string> | undefined,
  typeIdReferenceDescriptors: readonly AdoptedDesignerTypeIdReferenceDescriptor[],
  configurationWitnesses: readonly MergeFileWitness[],
  artifacts: ExtensionAdoptedPreparedArtifact[],
  blockers: ExtensionAdoptedScopedBlocker[],
  uuidProof: { readonly issues: readonly ExtensionAdoptedProjectionIssue[]; readonly witnesses: ReadonlyMap<string, readonly MergeFileWitness[]> } = { issues: [], witnesses: new Map() },
): void {
  if (!projected.ok) {
    blockers.push({ kind: 'metadataXml', targetRelativePath: input.row.target!.descriptorRelativePath!, sourceRelativePath: input.row.incoming!.descriptorRelativePath, reason: projected.reason });
    return;
  }
  const target = input.row.target!;
  const incoming = input.row.incoming!;
  if (!target.descriptorRelativePath || !incoming.descriptorRelativePath) {
    blockers.push({ kind: 'metadataXml', targetRelativePath: target.descriptorRelativePath ?? '', sourceRelativePath: incoming.descriptorRelativePath, reason: 'Для adopted semantic projection нужны физические пути обоих дескрипторов.' });
    return;
  }
  const recipe = adoptedChildUuidByAnchor && projected.recipe.kind === 'adopted-descriptor'
    ? { ...projected.recipe, adoptedChildUuidByAnchor: new Map(adoptedChildUuidByAnchor), typeIdReferenceDescriptors }
    : projected.recipe;
  artifacts.push({
    kind: 'metadataXml',
    targetRelativePath: target.descriptorRelativePath,
    sourceRelativePath: incoming.descriptorRelativePath,
    targetFilePath: path.resolve(input.targetRoot.canonicalRootPath ?? input.targetRoot.rootPath, target.descriptorRelativePath),
    sourceFilePath: path.resolve(input.incomingRoot.canonicalRootPath ?? input.incomingRoot.rootPath, incoming.descriptorRelativePath),
    targetHash: recipe.kind === 'adopted-descriptor' ? recipe.target.witness.expectedHash : target.descriptorHash ?? '',
    sourceHash: recipe.kind === 'adopted-descriptor' ? recipe.source.witness.expectedHash : incoming.descriptorHash ?? '',
    targetXml: Buffer.from(projected.targetXml),
    sourceXml: Buffer.from(projected.sourceXml),
    recipe,
    issues: [...projected.issues, ...uuidProof.issues],
    uuidCandidateWitnesses: uuidProof.witnesses,
    dependencyWitnesses: configurationWitnesses,
  });
}

function typeIdContext(
  direction: ExtensionAdoptedDirection,
  incomingRoot: ExtensionMetadataIndex,
  baseRoot: ExtensionMetadataIndex,
  otherBaseRoot?: ExtensionMetadataIndex,
): AdoptedDesignerTypeIdReferenceDescriptor[] {
  const indexes = direction === 'cf-to-adopted'
    ? [incomingRoot]
    : [incomingRoot, baseRoot, ...(otherBaseRoot ? [otherBaseRoot] : [])];
  const result: AdoptedDesignerTypeIdReferenceDescriptor[] = [];
  const mappingsByDescriptor = new Map<AdoptedDesignerTypeIdReferenceDescriptor, string | undefined>();
  const seenPaths = new Set<string>();
  for (const index of indexes) {
    for (const object of index.objects) {
      if (object.identity?.ownership !== 'own' || !object.identity || !object.descriptorContent
        || !object.descriptorRelativePath || !object.descriptorHash) { continue; }
      const key = `${index.sourceId}\0${normalizeRelativePath(object.descriptorRelativePath)}`;
      if (seenPaths.has(key)) { continue; }
      seenPaths.add(key);
      const candidate: AdoptedDesignerTypeIdReferenceDescriptor = {
        descriptorXml: Buffer.from(object.descriptorContent),
        identity: identityFor(object.identity),
        provenance: index === baseRoot || index === otherBaseRoot ? 'proven-base' : 'own',
        sourceId: index.sourceId,
        relativePath: object.descriptorRelativePath,
        expectedHash: object.descriptorHash,
      };
      const mapping = typeIdMappingSignature(candidate);
      mappingsByDescriptor.set(candidate, mapping);
      const equivalentIndex = mapping === undefined ? -1 : result.findIndex((previous) =>
        previous.identity.type === candidate.identity.type
        && previous.identity.name === candidate.identity.name
        && normalizeUuid(previous.identity.uuid) === normalizeUuid(candidate.identity.uuid)
        && mappingsByDescriptor.get(previous) === mapping,
      );
      if (equivalentIndex < 0) {
        result.push(candidate);
      } else if (candidate.provenance === 'proven-base' && result[equivalentIndex]!.provenance !== 'proven-base') {
        // Prefer the exact proven-base capture when both captured descriptors prove the same mapping.
        result[equivalentIndex] = candidate;
      }
    }
  }
  return result;
}

/** Returns a mapping signature only when every GeneratedType is explicitly and uniquely valid. */
function typeIdMappingSignature(input: AdoptedDesignerTypeIdReferenceDescriptor): string | undefined {
  if (input.identity.ownership !== 'own' || hash(input.descriptorXml) !== normalizeHash(input.expectedHash)) { return undefined; }
  try {
    const document = parseXmlDocument(input.descriptorXml.toString('utf8'));
    const metadata = document.root;
    if (expandedName(metadata) !== `{${MDCLASSES_NAMESPACE}}MetaDataObject`) { return undefined; }
    const roots = elementChildren(metadata).filter((element) => namespaceOf(element) === MDCLASSES_NAMESPACE);
    if (roots.length !== 1) { return undefined; }
    const root = roots[0]!;
    const properties = directInNamespace(root, 'Properties', MDCLASSES_NAMESPACE);
    if (root.localName !== input.identity.type || properties.length !== 1
      || attributeValue(root, 'uuid')?.toLowerCase() !== input.identity.uuid.toLowerCase()) { return undefined; }
    const nameNodes = directInNamespace(properties[0]!, 'Name', MDCLASSES_NAMESPACE);
    if (nameNodes.length !== 1 || textContent(nameNodes[0]!).trim() !== input.identity.name) { return undefined; }
    const infos = directInNamespace(root, 'InternalInfo', MDCLASSES_NAMESPACE);
    if (infos.length !== 1) { return undefined; }
    const generated = elementChildren(infos[0]!).filter((element) => element.localName === 'GeneratedType' && namespaceOf(element) === READABLE_NAMESPACE);
    if (generated.length === 0) { return undefined; }
    const specs = getExplicitGeneratedTypeSpecs(root.localName);
    if (!specs) { return undefined; }
    const entries: string[] = [];
    const usedIds = new Set<string>();
    for (const item of generated) {
      const name = attributeValue(item, 'name');
      const category = attributeValue(item, 'category');
      const matched = specs.filter((spec) => spec.category === category && `${spec.namePrefix}.${input.identity.name}` === name);
      const ids = directInNamespace(item, 'TypeId', READABLE_NAMESPACE);
      const id = ids.length === 1 ? textContent(ids[0]!).trim() : '';
      if (matched.length !== 1 || ids.length !== 1 || !UUID_PATTERN.test(id) || usedIds.has(normalizeUuid(id))) { return undefined; }
      usedIds.add(normalizeUuid(id));
      entries.push(`${normalizeUuid(id)}=${matched[0]!.namePrefix}.${input.identity.name}`);
    }
    const version = attributeValue(metadata, 'version');
    if (!version) { return undefined; }
    const singleResolver = createAdoptedDesignerTypeIdResolver(version, [input]);
    for (const entry of entries) {
      const id = entry.slice(0, entry.indexOf('='));
      const resolved = singleResolver.resolve(id);
      if (resolved.reason || resolved.qualifiedName !== `cfg:${entry.slice(entry.indexOf('=') + 1)}`) { return undefined; }
    }
    return entries.sort(compareOrdinalStrings).join('\n');
  } catch {
    return undefined;
  }
}

function expandedName(element: XmlElement): string { return `{${namespaceOf(element) ?? ''}}${element.localName}`; }

function attributeValue(element: XmlElement, name: string): string | undefined {
  return element.attributes.find((attribute) => attribute.name === name)?.value;
}

async function captureObjectDescriptor(root: ExtensionMetadataIndex, object: ExtensionIndexedObject): Promise<{ readonly ok: true; readonly capture: AdoptedSemanticArtifactCapture } | { readonly ok: false; readonly reason: string }> {
  if (!object.descriptorRelativePath || !object.descriptorHash || !object.identity) {
    return { ok: false, reason: `Для ${object.qualifiedName} нет индексированного descriptor с raw hash и identity.` };
  }
  return capturePhysicalFile(root, object.descriptorRelativePath, object.descriptorHash, object.identity);
}

async function capturePhysicalFile(
  root: ExtensionMetadataIndex,
  relativePath: string,
  expectedHash: string,
  identity: CfeObjectIdentity | AdoptedDesignerIdentity,
): Promise<{ readonly ok: true; readonly capture: AdoptedSemanticArtifactCapture } | { readonly ok: false; readonly reason: string }> {
  try {
    const snapshot = await captureMergePath(path.join(root.canonicalRootPath ?? root.rootPath, relativePath), { retainContent: true });
    if (snapshot.state !== 'file' || snapshot.contentBase64 === undefined) {
      return { ok: false, reason: `Захваченный физический файл отсутствует или не является regular file: ${relativePath}` };
    }
    const content = Buffer.from(snapshot.contentBase64, 'base64');
    if (normalizeHash(snapshot.hash) !== normalizeHash(expectedHash) || hash(content) !== normalizeHash(expectedHash)) {
      return { ok: false, reason: `Физический SHA-256 ${relativePath} изменился после индексации.` };
    }
    return {
      ok: true,
      capture: {
        content,
        witness: { sourceId: root.sourceId, relativePath, expectedHash: snapshot.hash, kind: 'file' },
        identity: identityFor(identity),
      },
    };
  } catch (error) {
    return { ok: false, reason: `Не удалось захватить ${relativePath}: ${errorMessage(error)}` };
  }
}

interface FormRecord {
  readonly name: string;
  readonly identity: AdoptedDesignerIdentity;
  readonly descriptorRelativePath: string;
  readonly descriptorCapture?: AdoptedSemanticArtifactCapture;
  readonly bodyRelativePath: string;
  readonly bodyCapture?: AdoptedSemanticArtifactCapture;
}

type FormRecordResult =
  | { readonly ok: true; readonly forms: readonly FormRecord[] }
  | { readonly ok: false; readonly root: string; readonly reason: string };

async function readFormRecords(root: ExtensionMetadataIndex, owner: ExtensionIndexedObject): Promise<FormRecordResult> {
  if (!owner.descriptorRelativePath || !owner.descriptorContent || !owner.sidecarRelativePath) {
    return { ok: false, root: owner.descriptorRelativePath ?? '', reason: `Не удалось прочитать descriptor/sidecar регистрации Form для ${owner.qualifiedName}.` };
  }
  if (FORM_METADATA_TYPES.has(owner.metadataType)) {
    const identity = owner.identity;
    if (!identity || identity.type !== owner.metadataType) {
      return { ok: false, root: owner.descriptorRelativePath, reason: `У root ${owner.qualifiedName} отсутствует точная Form identity.` };
    }
    const bodyPath = requiredLinkedDesignerBodyPath('Form', owner.descriptorRelativePath, owner.descriptorContent);
    if (!bodyPath) { return { ok: false, root: owner.descriptorRelativePath, reason: `Не удалось вывести путь Form.xml для ${owner.qualifiedName}.` }; }
    const descriptorCapture = await captureObjectDescriptor(root, owner);
    if (!descriptorCapture.ok) { return { ok: false, root: owner.descriptorRelativePath, reason: descriptorCapture.reason }; }
    const body = await captureIndexedSidecar(root, owner, bodyPath, identity);
    if (!body.ok && matchingSidecars(owner, bodyPath).length) { return { ok: false, root: bodyPath, reason: body.reason }; }
    return {
      ok: true,
      forms: [{
        name: owner.name,
        identity: identityFor(identity),
        descriptorRelativePath: owner.descriptorRelativePath,
        descriptorCapture: descriptorCapture.capture,
        bodyRelativePath: bodyPath,
        ...(body.ok ? { bodyCapture: body.capture } : {}),
      }],
    };
  }

  const registrations = formRegistrations(owner.descriptorContent);
  if (!registrations.ok) { return { ok: false, root: owner.descriptorRelativePath, reason: registrations.reason }; }
  const forms: FormRecord[] = [];
  for (const name of registrations.names) {
    const descriptorRelativePath = `${owner.sidecarRelativePath}/Forms/${name}.xml`;
    const descriptorFiles = matchingSidecars(owner, descriptorRelativePath);
    if (descriptorFiles.length !== 1) {
      return { ok: false, root: descriptorRelativePath, reason: `Зарегистрированная Form ${name} не имеет единственного физического nested descriptor; его автоматическое создание не поддерживается.` };
    }
    const descriptorCapture = await captureIndexedSidecar(root, owner, descriptorRelativePath);
    if (!descriptorCapture.ok) { return { ok: false, root: descriptorRelativePath, reason: descriptorCapture.reason }; }
    let parsedIdentity: CfeObjectIdentity;
    try {
      parsedIdentity = parseCfeObjectIdentity(descriptorCapture.capture.content.toString('utf8'), descriptorRelativePath);
    } catch (error) {
      return { ok: false, root: descriptorRelativePath, reason: `Nested Form descriptor ${name} имеет некорректную identity: ${errorMessage(error)}` };
    }
    if (parsedIdentity.type !== 'Form' || parsedIdentity.name !== name) {
      return { ok: false, root: descriptorRelativePath, reason: `Nested descriptor ${descriptorRelativePath} не совпадает с регистрацией Form ${name}.` };
    }
    const capturedFormDescriptor: AdoptedSemanticArtifactCapture = {
      ...descriptorCapture.capture,
      identity: identityFor(parsedIdentity),
    };
    const bodyRelativePath = requiredLinkedDesignerBodyPath('Form', descriptorRelativePath, descriptorCapture.capture.content);
    if (!bodyRelativePath) { return { ok: false, root: descriptorRelativePath, reason: `Не удалось вывести Form.xml для ${descriptorRelativePath}.` }; }
    const body = await captureIndexedSidecar(root, owner, bodyRelativePath, parsedIdentity);
    if (!body.ok && matchingSidecars(owner, bodyRelativePath).length) { return { ok: false, root: bodyRelativePath, reason: body.reason }; }
    forms.push({
      name,
      identity: capturedFormDescriptor.identity,
      descriptorRelativePath,
      descriptorCapture: capturedFormDescriptor,
      bodyRelativePath,
      ...(body.ok ? { bodyCapture: body.capture } : {}),
    });
  }
  return { ok: true, forms };
}

async function captureIndexedSidecar(
  root: ExtensionMetadataIndex,
  owner: ExtensionIndexedObject,
  relativePath: string,
  identity?: CfeObjectIdentity | AdoptedDesignerIdentity,
): Promise<{ readonly ok: true; readonly capture: AdoptedSemanticArtifactCapture } | { readonly ok: false; readonly reason: string }> {
  const matches = matchingSidecars(owner, relativePath);
  if (matches.length === 0) { return { ok: false, reason: `Физический файл отсутствует в захваченном sidecar: ${relativePath}` }; }
  if (matches.length !== 1) { return { ok: false, reason: `В captured sidecar повторяется файл ${relativePath}.` }; }
  const file = matches[0]!;
  const effectiveIdentity = identity ?? owner.identity;
  if (!effectiveIdentity) {
    return { ok: false, reason: `Для captured Form XML отсутствует identity ${relativePath}.` };
  }
  return capturePhysicalFile(root, relativePath, file.hash, effectiveIdentity);
}

function formRegistrations(descriptorContent: Buffer): { readonly ok: true; readonly names: string[] } | { readonly ok: false; readonly reason: string } {
  try {
    const document = parseXmlDocument(descriptorContent.toString('utf8'));
    if (expandedName(document.root) !== `{${MDCLASSES_NAMESPACE}}MetaDataObject`) {
      return { ok: false, reason: 'Корень owner descriptor не является MDClasses/MetaDataObject.' };
    }
    const objects = elementChildren(document.root).filter((element) => namespaceOf(element) === MDCLASSES_NAMESPACE);
    if (objects.length !== 1) { return { ok: false, reason: 'Owner descriptor не содержит единственный MDClasses root object.' }; }
    const childObjects = directInNamespace(objects[0]!, 'ChildObjects', MDCLASSES_NAMESPACE);
    if (childObjects.length === 0) { return { ok: true, names: [] }; }
    if (childObjects.length !== 1) { return { ok: false, reason: 'Owner descriptor содержит повторные ChildObjects; Form-регистрация неоднозначна.' }; }
    const names: string[] = [];
    const seen = new Set<string>();
    for (const child of elementChildren(childObjects[0]!)) {
      if (namespaceOf(child) !== MDCLASSES_NAMESPACE || child.localName !== 'Form') { continue; }
      const name = textContent(child).trim();
      if (!name) { return { ok: false, reason: 'Form-регистрация не содержит имя.' }; }
      const key = normalizeName(name);
      if (seen.has(key)) { return { ok: false, reason: `Form-регистрация ${name} повторяется.` }; }
      seen.add(key);
      names.push(name);
    }
    return { ok: true, names };
  } catch (error) {
    return { ok: false, reason: `Не удалось разобрать nested Form registrations: ${errorMessage(error)}` };
  }
}

function directInNamespace(parent: XmlElement, name: string, namespace: string): XmlElement[] {
  return elementChildren(parent).filter((element) => element.localName === name && namespaceOf(element) === namespace);
}

function namespaceOf(element: XmlElement): string | undefined {
  const prefix = element.name.includes(':') ? element.name.slice(0, element.name.indexOf(':')) : '';
  const declaration = prefix ? `xmlns:${prefix}` : 'xmlns';
  let current: XmlElement | undefined = element;
  while (current) {
    const found = current.attributes.find((attribute) => attribute.name === declaration);
    if (found) { return found.value || undefined; }
    current = current.parent;
  }
  return undefined;
}

function physicalWriteWitnesses(
  artifact: ExtensionAdoptedPreparedArtifact,
  materializedWitnesses: readonly MergeFileWitness[],
  patches: readonly XmlPatchPayload[],
  supplementalWitnesses: readonly MergeFileWitness[],
): { readonly ok: true; readonly witnesses: readonly MergeFileWitness[] } | { readonly ok: false; readonly reason: string } {
  try {
    const authoritative = dedupeWitnesses([...materializedWitnesses, ...artifact.dependencyWitnesses, ...supplementalWitnesses]);
    const authoritativeByKey = new Map(authoritative.map((witness) => [witnessKey(witness), witness]));
    const targetCapture = artifact.recipe.kind === 'adopted-form'
      ? (artifact.recipe.targetWasMissing
        ? artifact.recipe.targetCreation?.targetWitness
        : ('witness' in artifact.recipe.target ? artifact.recipe.target.witness : undefined))
      : artifact.recipe.target.witness;
    if (!targetCapture) { return { ok: false, reason: 'Для adopted-артефакта не удалось определить raw target witness.' }; }
    const rawSnapshotWitnesses = [
      {
        key: witnessKey(targetCapture),
        logicalHash: hash(artifact.recipe.initialLogicalTarget),
        witness: targetCapture,
      },
      {
        key: witnessKey(artifact.recipe.source.witness),
        logicalHash: hash(artifact.recipe.initialLogicalSource),
        witness: artifact.recipe.source.witness,
      },
    ];
    const rawSnapshotByKey = new Map(rawSnapshotWitnesses.map((item) => [item.key, item]));
    const output = new Map(authoritative.map((witness) => [witnessKey(witness), witness]));
    for (const witness of patches.flatMap((patch) => patch.sourceWitnesses ?? [])) {
      const key = witnessKey(witness);
      const snapshot = rawSnapshotByKey.get(key);
      if (snapshot) {
        const rawHash = normalizeHash(snapshot.witness.expectedHash);
        const suppliedHash = normalizeHash(witness.expectedHash);
        if (suppliedHash !== rawHash && suppliedHash !== snapshot.logicalHash) {
          return { ok: false, reason: `Witness ${witness.sourceId}:${witness.relativePath} конфликтует с captured raw adopted snapshot.` };
        }
        output.set(key, snapshot.witness);
        continue;
      }
      const captured = authoritativeByKey.get(key);
      if (captured) {
        if (normalizeHash(captured.expectedHash) !== normalizeHash(witness.expectedHash)) {
          return { ok: false, reason: `Witness зависимости ${witness.sourceId}:${witness.relativePath} конфликтует с захваченным физическим hash.` };
        }
        output.set(key, captured);
        continue;
      }
      if (witness.kind !== 'file' || !/^[\da-f]{64}$/iu.test(witness.expectedHash)) {
        return { ok: false, reason: `Дополнительная зависимость ${witness.sourceId}:${witness.relativePath} не содержит физический SHA-256.` };
      }
      output.set(key, { ...witness, expectedHash: normalizeHash(witness.expectedHash) });
    }
    return { ok: true, witnesses: [...output.values()] };
  } catch (error) {
    return { ok: false, reason: `Не удалось проверить raw witnesses adopted write: ${errorMessage(error)}` };
  }
}

function witnessKey(witness: MergeFileWitness): string {
  return `${witness.sourceId}\0${normalizeRelativePath(witness.relativePath)}\0${witness.kind ?? 'file'}`;
}

function identityFor(identity: CfeObjectIdentity | AdoptedDesignerIdentity): AdoptedDesignerIdentity {
  return {
    ownership: identity.ownership,
    type: identity.type,
    name: identity.name,
    uuid: identity.uuid,
    ...(identity.sourceUuid ? { sourceUuid: identity.sourceUuid } : {}),
  };
}

function mapForms(forms: readonly FormRecord[]): Map<string, FormRecord> {
  const result = new Map<string, FormRecord>();
  for (const form of forms) { result.set(normalizeName(form.name), form); }
  return result;
}

function matchingSidecars(owner: ExtensionIndexedObject, relativePath: string): ExtensionIndexedObject['sidecarFiles'][number][] {
  const wanted = normalizeRelativePath(relativePath);
  return owner.sidecarFiles.filter((file) => normalizeRelativePath(file.relativePath) === wanted);
}

function witnessForObject(root: ExtensionMetadataIndex, object: ExtensionIndexedObject): MergeFileWitness | undefined {
  if (!object.descriptorRelativePath || !object.descriptorHash) { return undefined; }
  return { sourceId: root.sourceId, relativePath: object.descriptorRelativePath, expectedHash: normalizeHash(object.descriptorHash), kind: 'file' };
}

function combineUuidProofs(
  left: { readonly issues: readonly ExtensionAdoptedProjectionIssue[]; readonly witnesses: ReadonlyMap<string, readonly MergeFileWitness[]> },
  right: { readonly issues: readonly ExtensionAdoptedProjectionIssue[]; readonly witnesses: ReadonlyMap<string, readonly MergeFileWitness[]> },
): { readonly issues: readonly ExtensionAdoptedProjectionIssue[]; readonly witnesses: ReadonlyMap<string, readonly MergeFileWitness[]> } {
  const witnesses = new Map<string, readonly MergeFileWitness[]>();
  try {
    for (const proof of [left, right]) {
      for (const [uuid, candidateWitnesses] of proof.witnesses) {
        const key = normalizeUuid(uuid);
        witnesses.set(key, dedupeWitnesses([...(witnesses.get(key) ?? []), ...candidateWitnesses]));
      }
    }
    return { issues: [...left.issues, ...right.issues], witnesses };
  } catch (error) {
    return {
      issues: [...left.issues, ...right.issues, {
        side: 'source', identityKey: 'root=ChildObjects',
        reason: `Proof физически вводимого metadata UUID противоречив: ${errorMessage(error)}`,
      }],
      witnesses: new Map(),
    };
  }
}

function introducedDefinitionUuidWitnesses(
  artifact: ExtensionAdoptedPreparedArtifact,
  materializedContent: Buffer,
): { readonly ok: true; readonly witnesses: readonly MergeFileWitness[] } | { readonly ok: false; readonly reason: string } {
  if (artifact.recipe.kind !== 'adopted-descriptor') { return { ok: true, witnesses: [] }; }
  const introduced = introducedAdoptedDescriptorUuidDefinitions(artifact.recipe.target.content, materializedContent);
  if (!introduced.ok) { return introduced; }
  const targetSourceId = artifact.recipe.target.witness.sourceId;
  const sourceSourceId = artifact.recipe.source.witness.sourceId;
  const witnesses: MergeFileWitness[] = [];
  try {
    for (const uuid of introduced.uuids) {
      const candidateWitnesses = artifact.uuidCandidateWitnesses.get(normalizeUuid(uuid));
      if (!candidateWitnesses?.length) {
        return { ok: false, reason: `Для физически вводимого metadata UUID ${uuid} отсутствует candidate-scoped target registry proof.` };
      }
      const captured = dedupeWitnesses(candidateWitnesses);
      if (!captured.some((witness) => witness.sourceId === targetSourceId
        && normalizeRelativePath(witness.relativePath).toLocaleLowerCase('en-US') === 'configuration.xml')) {
        return { ok: false, reason: `Proof физически вводимого metadata UUID ${uuid} не содержит captured target Configuration.xml.` };
      }
      if (captured.some((witness) => (witness.sourceId !== targetSourceId && witness.sourceId !== sourceSourceId)
        || witness.kind !== 'file' || !/^[\da-f]{64}$/iu.test(normalizeHash(witness.expectedHash)))) {
        return { ok: false, reason: `Proof физически вводимого metadata UUID ${uuid} содержит отсутствующий или некорректный file witness.` };
      }
      witnesses.push(...captured);
    }
    return { ok: true, witnesses: dedupeWitnesses(witnesses) };
  } catch (error) {
    return { ok: false, reason: `Не удалось проверить candidate-scoped UUID proof: ${errorMessage(error)}` };
  }
}

function dedupeWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] {
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

function sameFilePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left).replace(/\\/g, '/');
  const normalizedRight = path.resolve(right).replace(/\\/g, '/');
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

function normalizeRelativePath(value: string): string { return value.replace(/\\/g, '/').replace(/^\.\//u, ''); }
function normalizeName(value: string): string { return value.normalize('NFC').toLocaleLowerCase('en-US'); }
function normalizeUuid(value: string): string { return value.toLowerCase(); }
function normalizeHash(value: string): string { return value.replace(/^sha256:/iu, '').toLowerCase(); }
function hash(content: Buffer): string { return createHash('sha256').update(content).digest('hex'); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
