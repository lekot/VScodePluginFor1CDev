import { createHash } from 'crypto';

import { namespaceUriForName } from '../adapters/semanticXml/semanticXmlIdentity';
import { MISSING_TARGET_HASH, type MergeFileWitness } from '../merge/mergePreview';
import { elementChildren, parseXmlDocument, textContent } from '../xml/xmlDom';
import { requiredLinkedDesignerBodyPath } from '../linkedDesignerPackageRules';
import { SUPPORTED_EXTENSION_FORMATS } from './extensionMetadataIndex';
import type { AdoptedDesignerDirection, AdoptedDesignerIdentity } from './adoptedDesignerProjection';
import {
  projectExtensionAdoptedDescriptor,
  type AdoptedSemanticArtifactCapture,
  type AdoptedDescriptorArtifactRecipe,
} from './extensionAdoptedSemanticBridge';

const MD_CLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const SINGLE_FILE_TEMPLATE_TYPES = new Set([
  'TextDocument', 'BinaryData', 'SpreadsheetDocument', 'DataCompositionSchema', 'ActiveDocument',
]);
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export type CapturedAdoptedTemplatePhysicalSide =
  | { readonly kind: 'file'; readonly capture: AdoptedSemanticArtifactCapture }
  | { readonly kind: 'missing'; readonly witness: MergeFileWitness };

export interface CapturedAdoptedTemplateOwnerProof {
  readonly target: AdoptedSemanticArtifactCapture;
  readonly source: AdoptedSemanticArtifactCapture;
  readonly targetBase: AdoptedSemanticArtifactCapture;
  readonly sourceBase: AdoptedSemanticArtifactCapture;
}

export interface CapturedAdoptedTemplateProjectionInput {
  readonly direction: AdoptedDesignerDirection;
  readonly formatVersion: string;
  readonly metadataType: 'Template' | 'CommonTemplate';
  readonly targetDescriptor: AdoptedSemanticArtifactCapture;
  readonly sourceDescriptor: AdoptedSemanticArtifactCapture;
  readonly targetBaseDescriptor: AdoptedSemanticArtifactCapture;
  readonly sourceBaseDescriptor: AdoptedSemanticArtifactCapture;
  readonly targetBody: CapturedAdoptedTemplatePhysicalSide;
  readonly sourceBody: CapturedAdoptedTemplatePhysicalSide;
  /** Physical target state at the destination derived from the selected source TemplateType. */
  readonly targetDestinationBody: CapturedAdoptedTemplatePhysicalSide;
  readonly targetBaseBody: AdoptedSemanticArtifactCapture;
  readonly sourceBaseBody: AdoptedSemanticArtifactCapture;
  readonly ownerProof?: CapturedAdoptedTemplateOwnerProof;
  readonly configurationWitnesses: readonly MergeFileWitness[];
  readonly additionalBaseWitnesses?: readonly MergeFileWitness[];
}

/** Immutable raw captures and the exact adopted descriptor projection used by a selected body bundle. */
export interface CapturedAdoptedTemplateRecipe {
  readonly kind: 'adopted-template-bundle';
  readonly direction: AdoptedDesignerDirection;
  readonly formatVersion: string;
  readonly metadataType: 'Template' | 'CommonTemplate';
  readonly descriptorRecipe: AdoptedDescriptorArtifactRecipe;
  readonly targetDescriptor: AdoptedSemanticArtifactCapture;
  readonly sourceDescriptor: AdoptedSemanticArtifactCapture;
  readonly targetBaseDescriptor: AdoptedSemanticArtifactCapture;
  readonly sourceBaseDescriptor: AdoptedSemanticArtifactCapture;
  readonly targetBody: CapturedAdoptedTemplatePhysicalSide;
  readonly sourceBody: CapturedAdoptedTemplatePhysicalSide;
  readonly targetBaseBody: AdoptedSemanticArtifactCapture;
  readonly sourceBaseBody: AdoptedSemanticArtifactCapture;
  readonly targetTemplateType: string;
  readonly sourceTemplateType: string;
  readonly targetBodyRelativePath: string;
  readonly sourceBodyRelativePath: string;
  readonly targetDestinationBody: CapturedAdoptedTemplatePhysicalSide;
  readonly targetLogicalBody: Buffer;
  readonly sourceLogicalBody: Buffer;
  readonly configurationWitnesses: readonly MergeFileWitness[];
  readonly additionalBaseWitnesses: readonly MergeFileWitness[];
  readonly ownerProof?: CapturedAdoptedTemplateOwnerProof;
  readonly requiredWitnesses: readonly MergeFileWitness[];
}

export type CapturedAdoptedTemplateProjectionResult =
  | {
    readonly ok: true;
    readonly targetXml: Buffer;
    readonly sourceXml: Buffer;
    readonly recipe: CapturedAdoptedTemplateRecipe;
    readonly requiredWitnesses: readonly MergeFileWitness[];
  }
  | { readonly ok: false; readonly reason: string };

/** Validates exact owner/base/body captures, then snapshots an ownership-normalized descriptor pair. */
export function projectCapturedAdoptedTemplateBundle(
  input: CapturedAdoptedTemplateProjectionInput,
): CapturedAdoptedTemplateProjectionResult {
  try {
    verifyInput(input);
    const descriptorProjection = projectExtensionAdoptedDescriptor({
      direction: input.direction,
      target: input.targetDescriptor,
      source: input.sourceDescriptor,
      base: input.targetBaseDescriptor,
      formatVersion: input.formatVersion,
    });
    if (!descriptorProjection.ok || descriptorProjection.recipe.kind !== 'adopted-descriptor') {
      throw new Error(descriptorProjection.ok ? 'Для набора Template не удалось получить рецепт захваченного дескриптора.' : descriptorProjection.reason);
    }

    const targetTemplateType = requireTemplateType(descriptorProjection.targetXml, input.metadataType);
    const sourceTemplateType = requireTemplateType(descriptorProjection.sourceXml, input.metadataType);
    const baseTemplateType = requireTemplateType(input.targetBaseDescriptor.content, input.metadataType);
    if (input.targetBody.kind === 'missing' && targetTemplateType !== baseTemplateType) {
      throw new Error('Отсутствующий Template body цели наследует базовые байты только при совпадении эффективного TemplateType с собственным базовым типом.');
    }
    if (input.sourceBody.kind === 'missing' && sourceTemplateType !== baseTemplateType) {
      throw new Error('Отсутствующий Template body источника наследует базовые байты только при совпадении эффективного TemplateType с собственным базовым типом.');
    }
    const targetBodyRelativePath = requiredBodyPath(input.targetDescriptor.witness.relativePath, descriptorProjection.targetXml, input.metadataType);
    const sourceBodyRelativePath = requiredBodyPath(input.sourceDescriptor.witness.relativePath, descriptorProjection.sourceXml, input.metadataType);
    const targetBaseBodyPath = requiredBodyPath(input.targetBaseDescriptor.witness.relativePath, input.targetBaseDescriptor.content, input.metadataType);
    const sourceBaseBodyPath = requiredBodyPath(input.sourceBaseDescriptor.witness.relativePath, input.sourceBaseDescriptor.content, input.metadataType);
    if (targetBodyRelativePath !== sidePath(input.targetBody) || sourceBodyRelativePath !== sidePath(input.sourceBody)
        || targetBaseBodyPath !== input.targetBaseBody.witness.relativePath
        || sourceBaseBodyPath !== input.sourceBaseBody.witness.relativePath) {
      throw new Error('Путь захвата Template body не совпадает с эффективным TemplateType и путём дескриптора.');
    }

    const targetDestinationBodyRelativePath = requiredBodyPath(input.targetDescriptor.witness.relativePath, descriptorProjection.sourceXml, input.metadataType);
  const targetDestinationBody = cloneSide(input.targetDestinationBody);
  if (targetDestinationBodyRelativePath !== sidePath(targetDestinationBody)) {
    throw new Error('Захват целевого пути назначения Template body не совпадает с путём выбранного TemplateType источника.');
  }
  if (targetDestinationBody.kind === 'file'
      && !sameIdentity(targetDestinationBody.capture.identity, input.targetDescriptor.identity)) {
    throw new Error('Identity целевого Template body не совпадает с дескриптором Template цели.');
  }
  if (targetDestinationBody.kind === 'file'
      && targetDestinationBody.capture.witness.sourceId !== input.targetDescriptor.witness.sourceId) {
    throw new Error('Witness целевого Template body относится к другому захваченному источнику.');
  }
    if (targetDestinationBody.kind === 'file') { verifyCapture(targetDestinationBody.capture, 'целевой Template body назначения'); }
    else { verifyMissingWitness(targetDestinationBody.witness, input.targetDescriptor.witness.sourceId, targetDestinationBodyRelativePath); }
  if (normalizePath(targetBodyRelativePath) === normalizePath(targetDestinationBodyRelativePath)
      && !sameSideWitness(input.targetBody, targetDestinationBody)) {
    throw new Error('Старый и целевой захваты Template с одним путём расходятся в физическом состоянии цели.');
  }

    const targetLogicalBody = logicalBody(input.targetBody, input.targetBaseBody);
    const sourceLogicalBody = logicalBody(input.sourceBody, input.sourceBaseBody);
    const witnesses = dedupeWitnesses([
      descriptorProjection.recipe.requiredWitnesses,
      [input.targetBaseDescriptor.witness, input.sourceBaseDescriptor.witness,
        input.targetBaseBody.witness, input.sourceBaseBody.witness,
        sideWitness(input.targetBody), sideWitness(input.sourceBody), sideWitness(targetDestinationBody)],
      input.configurationWitnesses,
      input.additionalBaseWitnesses ?? [],
      ownerWitnesses(input.ownerProof),
    ].flat());

    const recipe: CapturedAdoptedTemplateRecipe = {
      kind: 'adopted-template-bundle',
      direction: input.direction,
      formatVersion: input.formatVersion,
      metadataType: input.metadataType,
      descriptorRecipe: descriptorProjection.recipe,
      targetDescriptor: cloneCapture(input.targetDescriptor),
      sourceDescriptor: cloneCapture(input.sourceDescriptor),
      targetBaseDescriptor: cloneCapture(input.targetBaseDescriptor),
      sourceBaseDescriptor: cloneCapture(input.sourceBaseDescriptor),
      targetBody: cloneSide(input.targetBody),
      sourceBody: cloneSide(input.sourceBody),
      targetBaseBody: cloneCapture(input.targetBaseBody),
      sourceBaseBody: cloneCapture(input.sourceBaseBody),
      targetTemplateType,
      sourceTemplateType,
      targetBodyRelativePath,
      sourceBodyRelativePath,
      targetDestinationBody: cloneSide(targetDestinationBody),
      targetLogicalBody: Buffer.from(targetLogicalBody),
      sourceLogicalBody: Buffer.from(sourceLogicalBody),
      configurationWitnesses: cloneWitnesses(input.configurationWitnesses),
      additionalBaseWitnesses: cloneWitnesses(input.additionalBaseWitnesses ?? []),
      ...(input.ownerProof ? { ownerProof: cloneOwnerProof(input.ownerProof) } : {}),
      requiredWitnesses: cloneWitnesses(witnesses),
    };
    return {
      ok: true,
      targetXml: Buffer.from(descriptorProjection.targetXml),
      sourceXml: Buffer.from(descriptorProjection.sourceXml),
      recipe,
      requiredWitnesses: cloneWitnesses(witnesses),
    };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

function verifyInput(input: CapturedAdoptedTemplateProjectionInput): void {
  if (!SUPPORTED_EXTENSION_FORMATS.has(input.formatVersion)) { throw new Error(`Неподдерживаемая версия дескриптора Template: ${input.formatVersion}.`); }
  if (input.metadataType !== 'Template' && input.metadataType !== 'CommonTemplate') { throw new Error('Этот тип метаданных Template не поддерживается.'); }
  verifyCapture(input.targetDescriptor, 'дескриптор Template цели');
  verifyCapture(input.sourceDescriptor, 'дескриптор Template источника');
  verifyCapture(input.targetBaseDescriptor, 'дескриптор Template базовой конфигурации цели');
  verifyCapture(input.sourceBaseDescriptor, 'дескриптор Template базовой конфигурации источника');
  verifyCapture(input.targetBaseBody, 'Template body базовой конфигурации цели');
  verifyCapture(input.sourceBaseBody, 'Template body базовой конфигурации источника');
  verifyBasePair(input.targetBaseDescriptor, input.sourceBaseDescriptor, 'дескриптора Template');
  verifyBasePair(input.targetBaseBody, input.sourceBaseBody, 'Template body');
  if (!sameIdentity(input.targetBaseDescriptor.identity, input.targetBaseBody.identity)) {
    throw new Error('Identity Template body не совпадает с захваченным базовым дескриптором.');
  }
  if (input.targetBaseDescriptor.witness.sourceId !== input.targetBaseBody.witness.sourceId
      || input.sourceBaseDescriptor.witness.sourceId !== input.sourceBaseBody.witness.sourceId) {
    throw new Error('Witness базового Template body относится к другому корню базовой конфигурации.');
  }
  validateDescriptorIdentity(input.targetDescriptor, input.metadataType, input.formatVersion);
  validateDescriptorIdentity(input.sourceDescriptor, input.metadataType, input.formatVersion);
  validateDescriptorIdentity(input.targetBaseDescriptor, input.metadataType, input.formatVersion);
  validateDescriptorIdentity(input.sourceBaseDescriptor, input.metadataType, input.formatVersion);
  for (const [side, capture] of [['target', input.targetDescriptor], ['source', input.sourceDescriptor]] as const) {
    const body = side === 'target' ? input.targetBody : input.sourceBody;
    if (!sameIdentity(capture.identity, body.kind === 'file' ? body.capture.identity : capture.identity)) {
      throw new Error(`Identity Template body стороны «${side}» не совпадает с identity дескриптора.`);
    }
    if (body.kind === 'file' && body.capture.witness.sourceId !== capture.witness.sourceId) {
      throw new Error(`Witness Template body стороны «${side}» относится к другому захваченному источнику.`);
    }
    const isAdopted = capture.identity.ownership === 'adopted';
    if (body.kind === 'missing' && !isAdopted) {
      throw new Error(`Отсутствующее Template body разрешено только для adopted ${side} capture.`);
    }
    if (body.kind === 'file') { verifyCapture(body.capture, `Template body стороны «${side}»`); }
    else { verifyMissingWitness(body.witness, capture.witness.sourceId, body.witness.relativePath); }
  }
  if (!sameIdentity(input.targetBaseDescriptor.identity, input.targetBaseBody.identity)
      || input.targetBaseBody.identity.ownership !== 'own') {
    throw new Error('Базовый Template body должен иметь физический own capture с точной identity.');
  }
  validateBaseBodyPath(input.targetBaseDescriptor, input.targetBaseBody, input.metadataType);
  validateBaseBodyPath(input.sourceBaseDescriptor, input.sourceBaseBody, input.metadataType);
  assertSameDescriptorPath(input.targetDescriptor, input.sourceDescriptor, input.targetBaseDescriptor, input.sourceBaseDescriptor);

  if (input.metadataType === 'CommonTemplate') {
    if (input.ownerProof) { throw new Error('Корневой CommonTemplate не должен получать proof вложенного владельца.'); }
    for (const capture of [input.targetDescriptor, input.sourceDescriptor, input.targetBaseDescriptor]) {
      const pieces = capture.witness.relativePath.replace(/\\/gu, '/').split('/');
      if (pieces.length !== 2 || pieces[0] !== 'CommonTemplates' || pieces[1] !== `${capture.identity.name}.xml`) {
        throw new Error('Дескриптор CommonTemplate должен находиться по точному корневому пути CommonTemplates.');
      }
    }
  } else {
    if (!input.ownerProof) { throw new Error('Для вложенного Template нужны точные captures регистрации владельца на target, source и обеих базовых сторонах.'); }
    validateOwnerProof(input.ownerProof, input.metadataType, input.formatVersion, input.targetDescriptor, input.sourceDescriptor, input.targetBaseDescriptor);
    if (input.ownerProof.target.witness.sourceId !== input.targetDescriptor.witness.sourceId
        || input.ownerProof.source.witness.sourceId !== input.sourceDescriptor.witness.sourceId
        || input.ownerProof.targetBase.witness.sourceId !== input.targetBaseDescriptor.witness.sourceId
        || input.ownerProof.sourceBase.witness.sourceId !== input.sourceBaseDescriptor.witness.sourceId) {
      throw new Error('Захваты владельца и вложенного Template относятся к разным корням.');
    }
  }

  for (const witness of [...input.configurationWitnesses, ...(input.additionalBaseWitnesses ?? [])]) { assertWitnessShape(witness); }
}

function validateOwnerProof(
  proof: CapturedAdoptedTemplateOwnerProof,
  metadataType: 'Template' | 'CommonTemplate',
  formatVersion: string,
  targetTemplate: AdoptedSemanticArtifactCapture,
  sourceTemplate: AdoptedSemanticArtifactCapture,
  baseTemplate: AdoptedSemanticArtifactCapture,
): void {
  for (const capture of [proof.target, proof.source, proof.targetBase, proof.sourceBase]) { verifyCapture(capture, 'дескриптор владельца Template'); }
  verifyBasePair(proof.targetBase, proof.sourceBase, 'дескриптора владельца Template');
  if (!sameIdentity(proof.targetBase.identity, proof.sourceBase.identity)
      || proof.targetBase.identity.ownership !== 'own') {
    throw new Error('Identity базового владельца Template противоречива.');
  }
  const ownerDirection = templateDirection(proof.target.identity, proof.source.identity);
  const templateExpectedDirection = templateDirection(targetTemplate.identity, sourceTemplate.identity);
  if (ownerDirection !== templateExpectedDirection) {
    throw new Error('Направление ownership владельца и вложенного Template не совпадает.');
  }
  const ownerProjection = projectExtensionAdoptedDescriptor({
    direction: ownerDirection,
    target: proof.target,
    source: proof.source,
    base: proof.targetBase,
    formatVersion,
  });
  if (!ownerProjection.ok) { throw new Error(`Проверка дескриптора владельца Template не прошла: ${ownerProjection.reason}`); }
  if (!sameIdentity(proof.target.identity, ownerProjection.recipe.target.identity)
      || !sameIdentity(proof.source.identity, ownerProjection.recipe.source.identity)) {
    throw new Error('Identity владельца Template изменилась при проверке projection.');
  }
  for (const registration of [proof.target, proof.source, proof.targetBase]) {
    validateNestedRegistration(registration, metadataType, targetTemplate.identity.name);
  }
  const expectedPaths = [
    [targetTemplate, proof.target], [sourceTemplate, proof.source], [baseTemplate, proof.targetBase],
  ] as const;
  for (const [template, owner] of expectedPaths) {
    const expected = `${owner.witness.relativePath.replace(/\\/gu, '/').replace(/\.xml$/iu, '')}/Templates/${template.identity.name}.xml`;
    if (normalizePath(template.witness.relativePath) !== normalizePath(expected)) {
      throw new Error(`Путь вложенного Template не совпадает с точным путём регистрации у владельца: ${template.witness.relativePath}.`);
    }
  }
}

function templateDirection(target: AdoptedDesignerIdentity, source: AdoptedDesignerIdentity): AdoptedDesignerDirection {
  if (target.ownership === 'own' && source.ownership === 'adopted') { return 'adopted-to-cf'; }
  if (target.ownership === 'adopted' && source.ownership === 'own') { return 'cf-to-adopted'; }
  if (target.ownership === 'adopted' && source.ownership === 'adopted') { return 'adopted-to-adopted'; }
  throw new Error('Дескрипторы владельца вложенного Template должны включать adopted сторону.');
}

function validateNestedRegistration(
  owner: AdoptedSemanticArtifactCapture,
  metadataType: 'Template' | 'CommonTemplate',
  nestedName: string,
): void {
  const root = parseXmlDocument(owner.content.toString('utf8')).root;
  if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MD_CLASSES_NAMESPACE) {
    throw new Error('У дескриптора владельца вложенного Template чужое пространство имён MDClasses.');
  }
  const owners = elementChildren(root).filter((element) => element.localName === owner.identity.type
    && namespaceUriForName(element) === MD_CLASSES_NAMESPACE);
  if (owners.length !== 1) { throw new Error('Identity владельца вложенного Template неоднозначна.'); }
  const childObjects = elementChildren(owners[0]!).filter((element) => element.localName === 'ChildObjects'
    && namespaceUriForName(element) === MD_CLASSES_NAMESPACE);
  if (childObjects.length !== 1) { throw new Error('У владельца вложенного Template должен быть ровно один раздел ChildObjects в MDClasses.'); }
  const registrations = elementChildren(childObjects[0]!).filter((element) => element.localName === metadataType
    && namespaceUriForName(element) === MD_CLASSES_NAMESPACE);
  const matches = registrations.filter((element) => textContent(element).trim() === nestedName);
  if (matches.length !== 1) {
    throw new Error('Для вложенного Template нужна ровно одна регистрация с точным именем.');
  }
}

function validateDescriptorIdentity(
  capture: AdoptedSemanticArtifactCapture,
  metadataType: 'Template' | 'CommonTemplate',
  formatVersion: string,
): void {
  const root = parseXmlDocument(capture.content.toString('utf8')).root;
  if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MD_CLASSES_NAMESPACE
      || root.attributes.filter((attribute) => attribute.name === 'version').length !== 1
      || root.attributes.find((attribute) => attribute.name === 'version')?.value !== formatVersion) {
    throw new Error('Пространство имён или версия дескриптора Template не совпадает с захваченным форматом.');
  }
  const metadata = elementChildren(root).filter((element) => element.localName === metadataType
    && namespaceUriForName(element) === MD_CLASSES_NAMESPACE);
  if (metadata.length !== 1 || metadata[0]!.attributes.find((attribute) => attribute.name === 'uuid')?.value.toLowerCase()
      !== capture.identity.uuid.toLowerCase()) {
    throw new Error('Identity дескриптора Template не совпадает с ожидаемым объектом MDClasses.');
  }
  const props = elementChildren(metadata[0]!).filter((element) => element.localName === 'Properties'
    && namespaceUriForName(element) === MD_CLASSES_NAMESPACE);
  const names = props.length === 1 ? elementChildren(props[0]!).filter((element) => element.localName === 'Name'
    && namespaceUriForName(element) === MD_CLASSES_NAMESPACE) : [];
  if (names.length !== 1 || textContent(names[0]!).trim() !== capture.identity.name) {
    throw new Error('Имя в дескрипторе Template не совпадает с захваченной identity.');
  }
}

function requireTemplateType(content: Buffer, metadataType: 'Template' | 'CommonTemplate'): string {
  const root = parseXmlDocument(content.toString('utf8')).root;
  const objects = elementChildren(root).filter((element) => element.localName === metadataType
    && namespaceUriForName(element) === MD_CLASSES_NAMESPACE);
  if (objects.length !== 1) { throw new Error('Identity спроецированного Template неоднозначна.'); }
  const props = elementChildren(objects[0]!).filter((element) => element.localName === 'Properties'
    && namespaceUriForName(element) === MD_CLASSES_NAMESPACE);
  if (props.length !== 1) { throw new Error('Раздел Properties спроецированного Template неоднозначен.'); }
  const types = elementChildren(props[0]!).filter((element) => element.localName === 'TemplateType'
    && namespaceUriForName(element) === MD_CLASSES_NAMESPACE);
  if (types.length !== 1) { throw new Error('После проекции базы TemplateType должен быть указан ровно один раз.'); }
  const value = textContent(types[0]!).trim();
  if (!SINGLE_FILE_TEMPLATE_TYPES.has(value)) {
    throw new Error(value === 'HTMLDocument'
      ? 'Для HTMLDocument объединение остаётся только для чтения, пока не определён формат его физического body.'
      : `TemplateType «${value || '(пусто)'}» не входит в реестр поддерживаемых однофайловых файлов тела.`);
  }
  return value;
}

function requiredBodyPath(
  descriptorPath: string,
  content: Buffer,
  metadataType: 'Template' | 'CommonTemplate',
): string {
  const path = requiredLinkedDesignerBodyPath('Template', descriptorPath, content);
  if (!path) { throw new Error(`Для ${metadataType} не найден обязательный single-file Template body path.`); }
  return normalizeSlashes(path);
}

function validateBaseBodyPath(
  descriptor: AdoptedSemanticArtifactCapture,
  body: AdoptedSemanticArtifactCapture,
  metadataType: 'Template' | 'CommonTemplate',
): void {
  const path = requiredBodyPath(descriptor.witness.relativePath, descriptor.content, metadataType);
  if (normalizePath(path) !== normalizePath(body.witness.relativePath)) {
    throw new Error('Путь захваченного базового Template body не соответствует типу его дескриптора.');
  }
}

function logicalBody(
  side: CapturedAdoptedTemplatePhysicalSide,
  base: AdoptedSemanticArtifactCapture,
): Buffer {
  return Buffer.from(side.kind === 'file' ? side.capture.content : base.content);
}

function verifyBasePair(
  targetBase: AdoptedSemanticArtifactCapture,
  sourceBase: AdoptedSemanticArtifactCapture,
  label: string,
): void {
  if (!sameIdentity(targetBase.identity, sourceBase.identity)
      || !sameBytes(targetBase.content, sourceBase.content)
      || normalizePath(targetBase.witness.relativePath) !== normalizePath(sourceBase.witness.relativePath)) {
    throw new Error(`Захваты общего базового ${label} на отдельных сторонах не совпадают точно.`);
  }
}

function assertSameDescriptorPath(...captures: readonly AdoptedSemanticArtifactCapture[]): void {
  const first = normalizePath(captures[0]!.witness.relativePath);
  if (captures.some((capture) => normalizePath(capture.witness.relativePath) !== first)) {
    throw new Error('Дескрипторы Template цели, источника и базы должны иметь один логический относительный путь.');
  }
}

function verifyCapture(capture: AdoptedSemanticArtifactCapture, label: string): void {
  if (!Buffer.isBuffer(capture.content)) { throw new Error(`Байты захвата «${label}» должны быть Buffer.`); }
  assertWitnessShape(capture.witness);
  if (capture.witness.kind !== undefined && capture.witness.kind !== 'file') { throw new Error(`Witness захвата «${label}» должен описывать файл.`); }
  if (!isUuid(capture.identity.uuid) || capture.identity.uuid.toLowerCase() === ZERO_UUID) { throw new Error(`В захвате «${label}» указан некорректный UUID.`); }
  if (!capture.identity.name.trim() || !capture.identity.type.trim()) { throw new Error(`В identity захвата «${label}» нужны тип и имя.`); }
  if (hash(capture.content) !== normalizeHash(capture.witness.expectedHash)) { throw new Error(`Байты захвата «${label}» не совпадают с SHA-256 witness.`); }
}

function verifyMissingWitness(witness: MergeFileWitness, expectedSourceId: string, expectedPath: string): void {
  assertWitnessShape(witness);
  if (witness.kind !== 'file' || witness.expectedHash !== MISSING_TARGET_HASH
      || witness.sourceId !== expectedSourceId || normalizePath(witness.relativePath) !== normalizePath(expectedPath)) {
    throw new Error('Witness отсутствующего Template body должен подтверждать точный физический путь захваченной стороны.');
  }
}

function assertWitnessShape(witness: MergeFileWitness): void {
  if (!witness || typeof witness.sourceId !== 'string' || !witness.sourceId.trim()
      || typeof witness.relativePath !== 'string' || !safeRelativePath(witness.relativePath)
      || typeof witness.expectedHash !== 'string'
      || (witness.expectedHash !== MISSING_TARGET_HASH && !/^(?:sha256:)?[\da-f]{64}$/iu.test(witness.expectedHash))) {
    throw new Error('Witness Template должен содержать sourceId, безопасный относительный путь и SHA-256 либо hash отсутствия.');
  }
}

function ownerWitnesses(proof?: CapturedAdoptedTemplateOwnerProof): MergeFileWitness[] {
  return proof ? [proof.target.witness, proof.source.witness, proof.targetBase.witness, proof.sourceBase.witness] : [];
}

function sidePath(side: CapturedAdoptedTemplatePhysicalSide): string {
  return side.kind === 'file' ? side.capture.witness.relativePath : side.witness.relativePath;
}

function sideWitness(side: CapturedAdoptedTemplatePhysicalSide): MergeFileWitness {
  return { ...(side.kind === 'file' ? side.capture.witness : side.witness), kind: 'file' };
}

function sameSideWitness(left: CapturedAdoptedTemplatePhysicalSide, right: CapturedAdoptedTemplatePhysicalSide): boolean {
  const a = sideWitness(left);
  const b = sideWitness(right);
  return a.sourceId === b.sourceId && normalizePath(a.relativePath) === normalizePath(b.relativePath)
    && a.expectedHash === b.expectedHash && (a.kind ?? 'file') === (b.kind ?? 'file');
}

function cloneSide(side: CapturedAdoptedTemplatePhysicalSide): CapturedAdoptedTemplatePhysicalSide {
  return side.kind === 'file'
    ? { kind: 'file', capture: cloneCapture(side.capture) }
    : { kind: 'missing', witness: { ...side.witness } };
}

function cloneCapture(capture: AdoptedSemanticArtifactCapture): AdoptedSemanticArtifactCapture {
  return { content: Buffer.from(capture.content), witness: { ...capture.witness }, identity: { ...capture.identity } };
}

function cloneOwnerProof(proof: CapturedAdoptedTemplateOwnerProof): CapturedAdoptedTemplateOwnerProof {
  return { target: cloneCapture(proof.target), source: cloneCapture(proof.source), targetBase: cloneCapture(proof.targetBase), sourceBase: cloneCapture(proof.sourceBase) };
}

function cloneWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] { return witnesses.map((witness) => ({ ...witness })); }

function dedupeWitnesses(witnessGroups: readonly MergeFileWitness[]): MergeFileWitness[] {
  const byKey = new Map<string, MergeFileWitness>();
  for (const witness of witnessGroups) {
    assertWitnessShape(witness);
    const kind = witness.kind ?? 'file';
    const key = `${witness.sourceId}\0${normalizePath(witness.relativePath)}\0${kind}`;
    const existing = byKey.get(key);
    if (existing && normalizeHash(existing.expectedHash) !== normalizeHash(witness.expectedHash)) {
      throw new Error(`Захваченные Template witnesses конфликтуют: ${witness.sourceId}:${witness.relativePath}.`);
    }
    if (!existing) { byKey.set(key, { ...witness, kind }); }
  }
  return [...byKey.values()];
}

function sameIdentity(left: AdoptedDesignerIdentity, right: AdoptedDesignerIdentity): boolean {
  return left.ownership === right.ownership && left.type === right.type && left.name === right.name
    && left.uuid.toLowerCase() === right.uuid.toLowerCase()
    && (left.sourceUuid?.toLowerCase() ?? '') === (right.sourceUuid?.toLowerCase() ?? '');
}

function normalizePath(value: string): string {
  const normalized = normalizeSlashes(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function normalizeSlashes(value: string): string { return value.replace(/\\/gu, '/'); }

function safeRelativePath(value: string): boolean {
  const normalized = normalizeSlashes(value);
  return Boolean(normalized) && !normalized.startsWith('/') && !/^[a-z]:/iu.test(normalized)
    && !normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function hash(content: Buffer): string { return createHash('sha256').update(content).digest('hex'); }
function normalizeHash(value: string): string { return value.replace(/^sha256:/iu, '').toLowerCase(); }
function sameBytes(left: Buffer, right: Buffer): boolean { return left.equals(right); }
function isUuid(value: string): boolean { return /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
