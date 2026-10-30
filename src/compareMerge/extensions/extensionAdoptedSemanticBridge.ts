import { createHash } from 'crypto';

import { MISSING_TARGET_HASH, type MergeFileWitness } from '../merge/mergePreview';
import type { CfeFormFormatVersion } from '../../extensionSupport/cfeProject/formTypes';
import {
  cloneXmlElement,
  directChildren,
  ensureBaseFormLast,
  parseCfeFormXml,
  sanitizeBorrowedBasePart,
  serializeCfeFormXml,
  setTextContent,
  stripBaseFormMutations,
  createXmlElement,
  createXmlText,
  localName,
} from '../../extensionSupport/cfeProject/formXml';
import {
  type AdoptedDesignerChildUuidRequirement,
  collectAdoptedDesignerChildUuidRequirements,
  materializeAdoptedDesignerTarget,
  projectAdoptedDesignerPair,
  type AdoptedDesignerDirection,
  type AdoptedDesignerIdentity,
  type AdoptedDesignerMaterializationResult,
  type AdoptedDesignerProjectionIssue,
  type AdoptedDesignerProjectionInput,
} from './adoptedDesignerProjection';
import type { AdoptedDesignerTypeIdReferenceDescriptor } from './adoptedDesignerTypeId';
import {
  materializeAdoptedDesignerFormTarget,
  projectAdoptedDesignerFormPair,
  type AdoptedDesignerFormProjectionInput,
} from './adoptedDesignerFormProjection';

export interface AdoptedSemanticArtifactCapture {
  readonly content: Buffer;
  readonly witness: MergeFileWitness;
  readonly identity: AdoptedDesignerIdentity;
}

export interface AdoptedSyntheticFormTarget {
  readonly content: Buffer;
  readonly identity: AdoptedDesignerIdentity;
}

export interface AdoptedMissingFormTarget {
  /** Host allocated once and retained in the compare snapshot. */
  readonly identity: AdoptedDesignerIdentity;
  /** Relative destination of the not-yet-created CFE Form.xml. */
  readonly relativePath: string;
  /** Host proof that this exact physical destination is absent at preview time. */
  readonly targetWitness: MergeFileWitness;
  /** Captured target owner/registration files needed to create this linked artifact safely. */
  readonly registrationWitnesses: readonly MergeFileWitness[];
}

export interface AdoptedDescriptorArtifactRecipe {
  readonly kind: 'adopted-descriptor';
  readonly direction: AdoptedDesignerDirection;
  readonly target: AdoptedSemanticArtifactCapture;
  readonly source: AdoptedSemanticArtifactCapture;
  readonly base: AdoptedSemanticArtifactCapture;
  readonly formatVersion: string;
  readonly adoptedChildUuidByAnchor?: ReadonlyMap<string, string>;
  readonly typeIdReferenceDescriptors: readonly AdoptedDesignerTypeIdReferenceDescriptor[];
  readonly initialLogicalTarget: Buffer;
  readonly initialLogicalSource: Buffer;
  readonly issues: readonly AdoptedDesignerProjectionIssue[];
  readonly requiredWitnesses: readonly MergeFileWitness[];
}

export interface AdoptedFormArtifactRecipe {
  readonly kind: 'adopted-form';
  readonly direction: AdoptedDesignerDirection;
  /** Physical capture for an existing target, or the deterministic borrowed shell for a new one. */
  readonly target: AdoptedSemanticArtifactCapture | AdoptedSyntheticFormTarget;
  readonly targetWasMissing: boolean;
  readonly targetCreation?: AdoptedMissingFormTarget;
  readonly source: AdoptedSemanticArtifactCapture;
  readonly baseForm: AdoptedSemanticArtifactCapture;
  readonly formatVersion: string;
  readonly initialLogicalTarget: Buffer;
  readonly initialLogicalSource: Buffer;
  readonly issues: readonly AdoptedDesignerProjectionIssue[];
  readonly requiredWitnesses: readonly MergeFileWitness[];
}

export type AdoptedSemanticArtifactRecipe = AdoptedDescriptorArtifactRecipe | AdoptedFormArtifactRecipe;

export interface AdoptedDescriptorProjectionInput {
  readonly direction: AdoptedDesignerDirection;
  readonly target: AdoptedSemanticArtifactCapture;
  readonly source: AdoptedSemanticArtifactCapture;
  readonly base: AdoptedSemanticArtifactCapture;
  readonly formatVersion: string;
  readonly adoptedChildUuidByAnchor?: ReadonlyMap<string, string>;
  readonly typeIdReferenceDescriptors?: readonly AdoptedDesignerTypeIdReferenceDescriptor[];
}

export interface AdoptedFormProjectionInput {
  readonly direction: AdoptedDesignerDirection;
  /** Omit only for a CF→CFE linked form not yet present in the target extension. */
  readonly target?: AdoptedSemanticArtifactCapture;
  readonly missingTarget?: AdoptedMissingFormTarget;
  readonly source: AdoptedSemanticArtifactCapture;
  readonly baseForm: AdoptedSemanticArtifactCapture;
  readonly formatVersion: string;
}

export type AdoptedArtifactProjectionResult =
  | {
    readonly ok: true;
    readonly targetXml: Buffer;
    readonly sourceXml: Buffer;
    readonly recipe: AdoptedSemanticArtifactRecipe;
    readonly issues: readonly AdoptedDesignerProjectionIssue[];
    readonly requiredWitnesses: readonly MergeFileWitness[];
  }
  | { readonly ok: false; readonly reason: string };

export type AdoptedChildUuidRequirementsResult =
  | { readonly ok: true; readonly requirements: readonly AdoptedDesignerChildUuidRequirement[] }
  | { readonly ok: false; readonly reason: string };

export type AdoptedArtifactMaterializationResult =
  | {
    readonly ok: true;
    readonly content: Buffer;
    readonly issues: readonly AdoptedDesignerProjectionIssue[];
    readonly requiredWitnesses: readonly MergeFileWitness[];
    readonly targetCreation?: AdoptedMissingFormTarget;
  }
  | { readonly ok: false; readonly reason: string };

const EXCLUDED_BASE_PARTS = new Set(['Events', 'Attributes', 'Commands', 'Parameters', 'CommandInterface', 'BaseForm']);
const EXCLUDED_BASE_ATTRIBUTE_PROPERTIES = new Set(['ReportResult', 'DetailsData', 'VariantAppearance', 'GroupList']);

/** Projects only a captured CF↔CFE descriptor pair that already passed host ownership/base proof. */
export function projectExtensionAdoptedDescriptor(input: AdoptedDescriptorProjectionInput): AdoptedArtifactProjectionResult {
  try {
    verifyCapture(input.target, 'target descriptor');
    verifyCapture(input.source, 'source descriptor');
    verifyCapture(input.base, 'proven base descriptor');
    assertDescriptorDirections(input.direction, input.target.identity, input.source.identity, input.base.identity);
    const helperInput = descriptorHelperInput(input);
    const projected = projectAdoptedDesignerPair(helperInput);
    if (!projected.ok) { return projected; }
    const recipe: AdoptedDescriptorArtifactRecipe = {
      kind: 'adopted-descriptor',
      direction: input.direction,
      target: cloneCapture(input.target),
      source: cloneCapture(input.source),
      base: cloneCapture(input.base),
      formatVersion: input.formatVersion,
      ...(input.adoptedChildUuidByAnchor ? { adoptedChildUuidByAnchor: new Map(input.adoptedChildUuidByAnchor) } : {}),
      typeIdReferenceDescriptors: cloneTypeIdDescriptors(input.typeIdReferenceDescriptors ?? []),
      initialLogicalTarget: Buffer.from(projected.targetXml),
      initialLogicalSource: Buffer.from(projected.sourceXml),
      issues: [...projected.issues],
      requiredWitnesses: dedupeWitnesses([
        input.target.witness,
        input.source.witness,
        input.base.witness,
        ...projected.usedDescriptorWitnesses,
      ]),
    };
    return {
      ok: true,
      targetXml: Buffer.from(projected.targetXml),
      sourceXml: Buffer.from(projected.sourceXml),
      recipe,
      issues: [...projected.issues],
      requiredWitnesses: recipe.requiredWitnesses,
    };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** Allocates nothing: the host stores returned keys and UUIDs in the compare snapshot. */
export function collectExtensionAdoptedChildUuidRequirements(input: AdoptedDescriptorProjectionInput): AdoptedChildUuidRequirementsResult {
  try {
    verifyCapture(input.target, 'target descriptor');
    verifyCapture(input.source, 'source descriptor');
    verifyCapture(input.base, 'proven base descriptor');
    assertDescriptorDirections(input.direction, input.target.identity, input.source.identity, input.base.identity);
    return collectAdoptedDesignerChildUuidRequirements(descriptorHelperInput(input));
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** Projects a captured borrowed Form.xml pair; a missing target is synthesized from captured base bytes. */
export function projectExtensionAdoptedForm(input: AdoptedFormProjectionInput): AdoptedArtifactProjectionResult {
  try {
    verifyCapture(input.source, 'source Form.xml');
    verifyCapture(input.baseForm, 'proven base Form.xml');
    const targetWasMissing = input.target === undefined;
    let target: AdoptedSemanticArtifactCapture | AdoptedSyntheticFormTarget;
    let targetCreation: AdoptedMissingFormTarget | undefined;
    if (input.target) {
      verifyCapture(input.target, 'target Form.xml');
      target = cloneCapture(input.target);
    } else {
      if (input.direction !== 'cf-to-adopted' || !input.missingTarget) {
        throw new Error('Для отсутствующей целевой Form.xml требуется явный рецепт CF→CFE с данными регистрации.');
      }
      assertMissingFormIdentity(input.missingTarget.identity, input.baseForm.identity);
      if (!isSafeRelativePath(input.missingTarget.relativePath)) { throw new Error('Для новой целевой Form.xml указан небезопасный относительный путь.'); }
      assertMissingTargetWitness(input.missingTarget.targetWitness, input.missingTarget.relativePath);
      if (input.missingTarget.registrationWitnesses.length === 0) {
        throw new Error('Для новой целевой Form.xml требуется хотя бы один захваченный witness регистрации.');
      }
      for (const witness of input.missingTarget.registrationWitnesses) { assertWitnessShape(witness, 'регистрация целевой Form'); }
      if (!input.missingTarget.registrationWitnesses.some((witness) => witness.sourceId === input.missingTarget!.targetWitness.sourceId)) {
        throw new Error('Witness отсутствующей Form.xml и witnesses регистрации должны относиться к одному target source.');
      }
      const shell = synthesizeBorrowedFormXml(input.baseForm.content, input.formatVersion);
      target = { content: shell, identity: { ...input.missingTarget.identity } };
      targetCreation = cloneMissingFormTarget(input.missingTarget);
    }
    assertFormDirections(input.direction, target.identity, input.source.identity, input.baseForm.identity);
    const helperInput = formHelperInput(input, target);
    const projected = projectAdoptedDesignerFormPair(helperInput);
    if (!projected.ok) { return projected; }
    const requiredWitnesses = dedupeWitnesses([
      targetWasMissing ? targetCreation!.targetWitness : (target as AdoptedSemanticArtifactCapture).witness,
      input.source.witness,
      input.baseForm.witness,
      ...(targetCreation?.registrationWitnesses ?? []),
    ]);
    const recipe: AdoptedFormArtifactRecipe = {
      kind: 'adopted-form',
      direction: input.direction,
      target: cloneTarget(target),
      targetWasMissing,
      ...(targetCreation ? { targetCreation } : {}),
      source: cloneCapture(input.source),
      baseForm: cloneCapture(input.baseForm),
      formatVersion: input.formatVersion,
      initialLogicalTarget: Buffer.from(projected.targetXml),
      initialLogicalSource: Buffer.from(projected.sourceXml),
      issues: [...projected.issues],
      requiredWitnesses,
    };
    return {
      ok: true,
      targetXml: Buffer.from(projected.targetXml),
      sourceXml: Buffer.from(projected.sourceXml),
      recipe,
      issues: [...projected.issues],
      requiredWitnesses,
    };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** Rechecks the recipe snapshots, then encodes the selected logical target into its captured ownership shape. */
export function materializeExtensionAdoptedArtifact(
  recipe: AdoptedSemanticArtifactRecipe,
  mergedLogicalTarget: Buffer,
): AdoptedArtifactMaterializationResult {
  try {
    verifyCapture(recipe.source, 'source artifact');
    if (recipe.kind === 'adopted-descriptor') {
      verifyCapture(recipe.target, 'target descriptor');
      verifyCapture(recipe.base, 'proven base descriptor');
      const projection = projectAdoptedDesignerPair(descriptorHelperInput(recipe));
      if (!projection.ok) { return projection; }
      if (!sameProjectedPair(recipe, projection.targetXml, projection.sourceXml)) { return { ok: false, reason: 'Рецепт adopted descriptor изменился после projection сравнения.' }; }
      const result = materializeAdoptedDesignerTarget({ ...descriptorHelperInput(recipe), mergedLogicalTarget });
      return materializedResult(result, dedupeWitnesses([...recipe.requiredWitnesses, ...resultWitnesses(result)]));
    }

    verifyCapture(recipe.baseForm, 'proven base Form.xml');
    if (recipe.targetWasMissing) {
      if (!recipe.targetCreation || 'witness' in recipe.target
        || !sameBytes(recipe.target.content, synthesizeBorrowedFormXml(recipe.baseForm.content, recipe.formatVersion))) {
        return { ok: false, reason: 'Синтетическая заимствованная целевая Form.xml изменилась после projection сравнения.' };
      }
    } else {
      if (!('witness' in recipe.target)) { return { ok: false, reason: 'Для захваченной целевой Form.xml отсутствует witness.' }; }
      verifyCapture(recipe.target, 'target Form.xml');
    }
    const projection = projectAdoptedDesignerFormPair(formHelperInput(recipe, recipe.target));
    if (!projection.ok) { return projection; }
    if (!sameProjectedPair(recipe, projection.targetXml, projection.sourceXml)) { return { ok: false, reason: 'Рецепт adopted Form.xml изменился после projection сравнения.' }; }
    const result = materializeAdoptedDesignerFormTarget({ ...formHelperInput(recipe, recipe.target), mergedLogicalTarget });
    const requiredWitnesses = dedupeWitnesses([
      ...recipe.requiredWitnesses,
    ]);
    if (!result.ok) { return result; }
    return {
      ok: true,
      content: result.content,
      issues: result.issues,
      requiredWitnesses,
      ...(recipe.targetCreation ? { targetCreation: recipe.targetCreation } : {}),
    };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

function descriptorHelperInput(input: AdoptedDescriptorArtifactRecipe | AdoptedDescriptorProjectionInput): AdoptedDesignerProjectionInput {
  return {
    direction: input.direction,
    targetXml: input.target.content,
    sourceXml: input.source.content,
    baseXml: input.base.content,
    targetIdentity: input.target.identity,
    sourceIdentity: input.source.identity,
    baseIdentity: input.base.identity,
    formatVersion: input.formatVersion,
    ...(input.adoptedChildUuidByAnchor ? { adoptedChildUuidByAnchor: input.adoptedChildUuidByAnchor } : {}),
    ...(input.typeIdReferenceDescriptors ? { typeIdReferenceDescriptors: input.typeIdReferenceDescriptors } : {}),
  };
}

function formHelperInput(input: AdoptedFormProjectionInput | AdoptedFormArtifactRecipe, target: AdoptedSemanticArtifactCapture | AdoptedSyntheticFormTarget): AdoptedDesignerFormProjectionInput {
  return {
    direction: input.direction,
    targetXml: target.content,
    sourceXml: input.source.content,
    baseXml: input.baseForm.content,
    targetIdentity: target.identity,
    sourceIdentity: input.source.identity,
    baseIdentity: input.baseForm.identity,
    baseFormSourceId: input.baseForm.witness.sourceId,
    baseFormRelativePath: input.baseForm.witness.relativePath,
    baseFormHash: input.baseForm.witness.expectedHash,
    formatVersion: input.formatVersion,
  };
}

function assertDescriptorDirections(
  direction: AdoptedDesignerDirection,
  target: AdoptedDesignerIdentity,
  source: AdoptedDesignerIdentity,
  base: AdoptedDesignerIdentity,
): void {
  const adopted = direction === 'cf-to-adopted' ? target : source;
  const own = direction === 'cf-to-adopted' ? source : target;
  if (adopted.ownership !== 'adopted' || own.ownership !== 'own' || base.ownership !== 'own'
    || adopted.type !== own.type || own.type !== base.type || adopted.name !== own.name || own.name !== base.name
    || !same(adopted.sourceUuid, base.uuid) || !same(own.uuid, base.uuid)) {
    throw new Error('Bridge descriptor требует точные identity CF↔CFE поверх одной подтверждённой host базовой версии.');
  }
}

function assertFormDirections(
  direction: AdoptedDesignerDirection,
  target: AdoptedDesignerIdentity,
  source: AdoptedDesignerIdentity,
  base: AdoptedDesignerIdentity,
): void {
  const adopted = direction === 'cf-to-adopted' ? target : source;
  const own = direction === 'cf-to-adopted' ? source : target;
  if (!isFormMetadataKind(base.type) || target.type !== base.type || source.type !== base.type
    || adopted.ownership !== 'adopted' || own.ownership !== 'own' || base.ownership !== 'own'
    || adopted.name !== base.name || own.name !== base.name
    || !same(adopted.sourceUuid, base.uuid) || !same(own.uuid, base.uuid)) {
    throw new Error('Bridge Form.xml требует точные identity target/source поверх одной захваченной базовой Form.xml.');
  }
}

function assertMissingFormIdentity(target: AdoptedDesignerIdentity, base: AdoptedDesignerIdentity): void {
  if (!isFormMetadataKind(base.type) || target.ownership !== 'adopted' || target.type !== base.type || target.name !== base.name
    || !same(target.sourceUuid, base.uuid) || !isUuid(target.uuid) || same(target.uuid, base.uuid)) {
    throw new Error('Для новой заимствованной Form требуется выделенный host локальный UUID и точный anchor базовой Form.');
  }
}

function synthesizeBorrowedFormXml(baseFormBytes: Buffer, formatVersion: string): Buffer {
  const formVersion = cfeFormatVersion(formatVersion);
  const source = parseCfeFormXml(baseFormBytes.toString('utf8')).root;
  if (source.attributes.version !== formatVersion) { throw new Error('Версия захваченной базовой Form.xml отличается от версии projection CFE.'); }
  const partChildren = [] as ReturnType<typeof cloneXmlElement>[];
  for (const child of directChildren(source)) {
    const name = localName(child.name);
    if (EXCLUDED_BASE_PARTS.has(name) || EXCLUDED_BASE_ATTRIBUTE_PROPERTIES.has(name)) { continue; }
    if (name === 'AutoCommandBar') {
      const cleaned = cloneXmlElement(child);
      cleaned.attributes.name ||= 'ФормаКоманднаяПанель';
      cleaned.attributes.id = '-1';
      cleaned.children = cleaned.children.filter((candidate) => candidate.kind !== 'element'
        || !['ChildItems', 'CommandSet'].includes(localName(candidate.name)));
      const autofill = directChildren(cleaned, 'Autofill')[0];
      if (autofill) { setTextContent(autofill, 'false'); }
      else { cleaned.children.push(createXmlElement('Autofill', {}, [createXmlText('false')])); }
      partChildren.push(cleaned);
      continue;
    }
    const copied = cloneXmlElement(child);
    if (name === 'ChildItems') { sanitizeBorrowedBasePart(copied, new Set<string>()); }
    partChildren.push(copied);
  }
  if (!partChildren.some((child) => localName(child.name) === 'AutoCommandBar')) {
    partChildren.push(createXmlElement('AutoCommandBar', { name: 'ФормаКоманднаяПанель', id: '-1' }, [
      createXmlElement('Autofill', {}, [createXmlText('false')]),
    ]));
  }
  if (!partChildren.some((child) => localName(child.name) === 'Attributes')) { partChildren.push(createXmlElement('Attributes')); }
  const borrowedBase = createXmlElement('BaseForm', { version: formVersion }, partChildren.map(cloneXmlElement));
  stripBaseFormMutations(borrowedBase);
  const result = cloneXmlElement(source);
  result.attributes.version = formatVersion;
  result.children = [...partChildren, borrowedBase];
  ensureBaseFormLast(result, formVersion);
  return Buffer.from(serializeCfeFormXml({ root: result }), 'utf8');
}

function verifyCapture(capture: AdoptedSemanticArtifactCapture, label: string): void {
  assertWitnessShape(capture.witness, label);
  const expected = normalizeHash(capture.witness.expectedHash);
  const actual = createHash('sha256').update(capture.content).digest('hex');
  if (expected !== actual) { throw new Error(`Байты ${label} не совпадают с захваченным SHA-256 witness.`); }
}

function assertWitnessShape(witness: MergeFileWitness, label: string): void {
  if (witness.kind !== undefined && witness.kind !== 'file') { throw new Error(`Witness ${label} должен описывать файл.`); }
  if (!witness.sourceId.trim() || !isSafeRelativePath(witness.relativePath)
    || !/^(?:sha256:)?[\da-f]{64}$/iu.test(witness.expectedHash)) {
    throw new Error(`Witness ${label} требует sourceId, безопасный относительный путь и SHA-256.`);
  }
}

function assertMissingTargetWitness(witness: MergeFileWitness, destination: string): void {
  if (witness.kind !== 'file' || witness.relativePath !== destination || witness.expectedHash !== MISSING_TARGET_HASH
    || !witness.sourceId.trim() || !isSafeRelativePath(witness.relativePath)) {
    throw new Error('Witness отсутствующей целевой Form.xml должен подтверждать отсутствие файла по точному безопасному destination path.');
  }
}

function cloneCapture(capture: AdoptedSemanticArtifactCapture): AdoptedSemanticArtifactCapture {
  return { content: Buffer.from(capture.content), witness: { ...capture.witness }, identity: { ...capture.identity } };
}

function cloneTarget(target: AdoptedSemanticArtifactCapture | AdoptedSyntheticFormTarget): AdoptedSemanticArtifactCapture | AdoptedSyntheticFormTarget {
  return 'witness' in target
    ? cloneCapture(target)
    : { content: Buffer.from(target.content), identity: { ...target.identity } };
}

function cloneTypeIdDescriptors(descriptors: readonly AdoptedDesignerTypeIdReferenceDescriptor[]): AdoptedDesignerTypeIdReferenceDescriptor[] {
  return descriptors.map((descriptor) => ({
    ...descriptor,
    descriptorXml: Buffer.from(descriptor.descriptorXml),
    identity: { ...descriptor.identity },
  }));
}

function cloneMissingFormTarget(value: AdoptedMissingFormTarget): AdoptedMissingFormTarget {
  return {
    ...value,
    identity: { ...value.identity },
    targetWitness: { ...value.targetWitness },
    registrationWitnesses: value.registrationWitnesses.map((witness) => ({ ...witness })),
  };
}

function resultWitnesses(result: AdoptedDesignerMaterializationResult): readonly MergeFileWitness[] {
  return result.ok ? result.usedDescriptorWitnesses : [];
}

function materializedResult(
  result: AdoptedDesignerMaterializationResult,
  requiredWitnesses: readonly MergeFileWitness[],
): AdoptedArtifactMaterializationResult {
  if (!result.ok) { return result; }
  return { ok: true, content: result.content, issues: result.issues, requiredWitnesses };
}

function sameProjectedPair(
  recipe: AdoptedDescriptorArtifactRecipe | AdoptedFormArtifactRecipe,
  target: Buffer,
  source: Buffer,
): boolean {
  return sameBytes(recipe.initialLogicalTarget, target) && sameBytes(recipe.initialLogicalSource, source);
}

function sameBytes(left: Buffer, right: Buffer): boolean { return left.equals(right); }

function dedupeWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] {
  const unique = new Map<string, MergeFileWitness>();
  for (const witness of witnesses) {
    unique.set(`${witness.sourceId}\0${witness.relativePath}\0${normalizeHash(witness.expectedHash)}\0${witness.kind ?? 'file'}`, { ...witness });
  }
  return [...unique.values()];
}

function normalizeHash(value: string): string { return value.replace(/^sha256:/iu, '').toLowerCase(); }
function same(left: string | undefined, right: string | undefined): boolean { return Boolean(left && right && left.toLowerCase() === right.toLowerCase()); }
function isFormMetadataKind(type: string): boolean { return type === 'Form' || type === 'CommonForm'; }
function isUuid(value: string): boolean { return /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(value); }
function isSafeRelativePath(value: string): boolean {
  const normalized = value.replace(/\\/gu, '/');
  return Boolean(normalized) && !normalized.startsWith('/') && !/^[a-z]:/iu.test(normalized)
    && !normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}
function cfeFormatVersion(value: string): CfeFormFormatVersion {
  if (!['2.17', '2.18', '2.19', '2.20', '2.21'].includes(value)) {
    throw new Error(`Неподдерживаемая версия Form.xml ${value}.`);
  }
  return value as CfeFormFormatVersion;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
