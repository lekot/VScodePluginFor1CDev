import { createHash } from 'crypto';

import { namespaceUriForName } from '../adapters/semanticXml/semanticXmlIdentity';
import { MISSING_TARGET_HASH, type MergeFileWitness } from '../merge/mergePreview';
import { elementChildren, parseXmlDocument, serializeXmlDocument, textContent, type XmlElement } from '../xml/xmlDom';
import { requiredLinkedDesignerBodyPath } from '../linkedDesignerPackageRules';
import { materializeExtensionAdoptedArtifact } from './extensionAdoptedSemanticBridge';
import {
  projectCapturedAdoptedTemplateBundle,
  type CapturedAdoptedTemplatePhysicalSide,
  type CapturedAdoptedTemplateRecipe,
} from './extensionAdoptedTemplateCapture';

const MD_CLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const READABLE_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/readable';

export type CapturedAdoptedTemplateBundle = CapturedAdoptedTemplateRecipe;

export type CapturedAdoptedTemplateMaterializationResult =
  | {
    readonly ok: true;
    readonly changed: boolean;
    readonly descriptorContent?: Buffer;
    readonly bodyWrite?: {
      readonly relativePath: string;
      readonly content: Buffer;
      readonly expectedTargetHash: string;
    };
    readonly deletePath?: string;
    readonly requiredWitnesses: readonly MergeFileWitness[];
    readonly bodyEffect: boolean;
  }
  | { readonly ok: false; readonly reason: string };

/** Revalidates raw snapshots and encodes one selected logical descriptor/body bundle. */
export function materializeCapturedAdoptedTemplateBundle(input: {
  readonly recipe: CapturedAdoptedTemplateRecipe;
  /** Already merged once by the semantic materializer; this function never reapplies XML patches. */
  readonly mergedLogicalTarget: Buffer;
  readonly candidateWitnesses?: readonly MergeFileWitness[];
}): CapturedAdoptedTemplateMaterializationResult {
  try {
    const recipe = input.recipe;
    verifyRecipe(recipe);
    if (!Buffer.isBuffer(input.mergedLogicalTarget)) { throw new Error('Итоговый дескриптор Template должен быть Buffer.'); }
    const mergedType = readTemplateType(input.mergedLogicalTarget, recipe.metadataType, recipe.formatVersion);
    if (recipe.sourceTemplateType !== recipe.targetTemplateType && mergedType !== recipe.sourceTemplateType) {
      throw new Error('В выбранном изменении Template должен присутствовать точный входящий TemplateType.');
    }
    const bodyEffect = recipe.targetTemplateType !== recipe.sourceTemplateType
      || hash(recipe.targetLogicalBody) !== hash(recipe.sourceLogicalBody);

    const candidateWitnesses = normalizeCandidateWitnesses(recipe, input.candidateWitnesses ?? []);
    const requiredWitnesses = dedupeWitnesses([...recipe.requiredWitnesses, ...candidateWitnesses]);
    const physicalDescriptor = materializeExtensionAdoptedArtifact(recipe.descriptorRecipe, input.mergedLogicalTarget);
    if (!physicalDescriptor.ok) { throw new Error('Не удалось безопасно преобразовать выбранный дескриптор Template.'); }

    let descriptorContent = Buffer.from(physicalDescriptor.content);
    if (bodyEffect && recipe.direction !== 'adopted-to-cf') {
      const augmented = encodeTemplateExtendedState(descriptorContent, recipe.metadataType, recipe.formatVersion,
        recipe.targetTemplateType !== mergedType);
      if ('reason' in augmented) { throw new Error(augmented.reason); }
      descriptorContent = Buffer.from(augmented.content);
    }

    const destinationPath = bodyPath(recipe.targetDescriptor.witness.relativePath, input.mergedLogicalTarget, recipe.metadataType);
    if (bodyEffect && normalizePath(destinationPath) !== normalizePath(recipe.sourceBodyRelativePath)) {
      throw new Error('Путь целевого Template body не совпадает с захваченным путём входящего body.');
    }
    const destination = recipe.targetDestinationBody;
    if (normalizePath(destinationPath) !== normalizePath(sidePath(destination))) {
      throw new Error('Захваченный путь целевого Template body изменился после projection.');
    }

    let bodyWrite: {
      readonly relativePath: string;
      readonly content: Buffer;
      readonly expectedTargetHash: string;
    } | undefined;
    let deletePath: string | undefined;
    if (bodyEffect) {
      const sourceBytes = Buffer.from(recipe.sourceLogicalBody);
      const existingDestinationBytes = destination.kind === 'file' ? destination.capture.content : undefined;
      if (!existingDestinationBytes || !existingDestinationBytes.equals(sourceBytes)) {
        bodyWrite = {
          relativePath: destinationPath,
          content: sourceBytes,
          expectedTargetHash: sideHash(destination),
        };
      }
      if (recipe.targetBody.kind === 'file'
          && normalizePath(recipe.targetBodyRelativePath) !== normalizePath(destinationPath)) {
        deletePath = recipe.targetBodyRelativePath;
      }
    }

    if (descriptorContent.equals(recipe.targetDescriptor.content)) { descriptorContent = Buffer.from(recipe.targetDescriptor.content); }
    const descriptorChanged = !descriptorContent.equals(recipe.targetDescriptor.content);
    const changed = descriptorChanged || bodyWrite !== undefined || deletePath !== undefined;
    return {
      ok: true,
      changed,
      ...(descriptorChanged ? { descriptorContent: Buffer.from(descriptorContent) } : {}),
      ...(bodyWrite ? { bodyWrite: { ...bodyWrite, content: Buffer.from(bodyWrite.content) } } : {}),
      ...(deletePath ? { deletePath } : {}),
      requiredWitnesses,
      bodyEffect,
    };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

function verifyRecipe(recipe: CapturedAdoptedTemplateRecipe): void {
  const projected = projectCapturedAdoptedTemplateBundle({
    direction: recipe.direction,
    formatVersion: recipe.formatVersion,
    metadataType: recipe.metadataType,
    targetDescriptor: recipe.targetDescriptor,
    sourceDescriptor: recipe.sourceDescriptor,
    targetBaseDescriptor: recipe.targetBaseDescriptor,
    sourceBaseDescriptor: recipe.sourceBaseDescriptor,
    targetBody: recipe.targetBody,
    sourceBody: recipe.sourceBody,
    targetDestinationBody: recipe.targetDestinationBody,
    targetBaseBody: recipe.targetBaseBody,
    sourceBaseBody: recipe.sourceBaseBody,
    ...(recipe.ownerProof ? { ownerProof: recipe.ownerProof } : {}),
    configurationWitnesses: recipe.configurationWitnesses,
    additionalBaseWitnesses: recipe.additionalBaseWitnesses,
  });
  if (!projected.ok) { throw new Error(projected.reason); }
  const expectedDescriptorRecipe = projected.recipe.descriptorRecipe;
  const actualDescriptorRecipe = recipe.descriptorRecipe;
  if (!projected.targetXml.equals(recipe.descriptorRecipe.initialLogicalTarget)
      || !projected.sourceXml.equals(recipe.descriptorRecipe.initialLogicalSource)
      || actualDescriptorRecipe.kind !== expectedDescriptorRecipe.kind
      || actualDescriptorRecipe.direction !== expectedDescriptorRecipe.direction
      || actualDescriptorRecipe.formatVersion !== expectedDescriptorRecipe.formatVersion
      || !sameCapture(recipe.descriptorRecipe.target, recipe.targetDescriptor)
      || !sameCapture(recipe.descriptorRecipe.source, recipe.sourceDescriptor)
      || !sameCapture(recipe.descriptorRecipe.base, recipe.targetBaseDescriptor)
      || !sameWitnessList(actualDescriptorRecipe.requiredWitnesses, expectedDescriptorRecipe.requiredWitnesses)
      || !sameProjectionIssues(actualDescriptorRecipe.issues, expectedDescriptorRecipe.issues)
      || !sameUuidMap(actualDescriptorRecipe.adoptedChildUuidByAnchor, expectedDescriptorRecipe.adoptedChildUuidByAnchor)
      || !sameOwnFormRegistrations(actualDescriptorRecipe.ownFormRegistrations, expectedDescriptorRecipe.ownFormRegistrations)
      || !sameTypeIdReferenceDescriptors(actualDescriptorRecipe.typeIdReferenceDescriptors, expectedDescriptorRecipe.typeIdReferenceDescriptors)
      || !sameWitnessList(projected.recipe.requiredWitnesses, recipe.requiredWitnesses)
      || recipe.targetTemplateType !== projected.recipe.targetTemplateType
      || recipe.sourceTemplateType !== projected.recipe.sourceTemplateType
      || normalizePath(recipe.targetBodyRelativePath) !== normalizePath(projected.recipe.targetBodyRelativePath)
      || normalizePath(recipe.sourceBodyRelativePath) !== normalizePath(projected.recipe.sourceBodyRelativePath)
      || !recipe.targetLogicalBody.equals(projected.recipe.targetLogicalBody)
      || !recipe.sourceLogicalBody.equals(projected.recipe.sourceLogicalBody)) {
    throw new Error('Захваченный adopted Template recipe изменился после projection.');
  }
}

function sameUuidMap(left: ReadonlyMap<string, string> | undefined, right: ReadonlyMap<string, string> | undefined): boolean {
  const a = [...(left ?? new Map<string, string>())].sort(([keyA], [keyB]) => keyA.localeCompare(keyB));
  const b = [...(right ?? new Map<string, string>())].sort(([keyA], [keyB]) => keyA.localeCompare(keyB));
  return a.length === b.length && a.every(([key, value], index) => key === b[index]![0] && value === b[index]![1]);
}

function sameOwnFormRegistrations(
  left: { readonly target: readonly string[]; readonly source: readonly string[] } | undefined,
  right: { readonly target: readonly string[]; readonly source: readonly string[] } | undefined,
): boolean {
  if (left === undefined || right === undefined) { return left === right; }
  return sameStringList(left.target, right.target) && sameStringList(left.source, right.source);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameTypeIdReferenceDescriptors(
  left: CapturedAdoptedTemplateRecipe['descriptorRecipe']['typeIdReferenceDescriptors'],
  right: CapturedAdoptedTemplateRecipe['descriptorRecipe']['typeIdReferenceDescriptors'],
): boolean {
  return left.length === right.length && left.every((descriptor, index) => {
    const other = right[index];
    return Boolean(other) && descriptor.descriptorXml.equals(other!.descriptorXml)
      && descriptor.provenance === other!.provenance && descriptor.sourceId === other!.sourceId
      && descriptor.relativePath === other!.relativePath && sameHash(descriptor.expectedHash, other!.expectedHash)
      && sameIdentity(descriptor.identity, other!.identity);
  });
}

function sameProjectionIssues(
  left: CapturedAdoptedTemplateRecipe['descriptorRecipe']['issues'],
  right: CapturedAdoptedTemplateRecipe['descriptorRecipe']['issues'],
): boolean {
  const signature = (items: typeof left) => items.map((item) => [item.side, item.identityKey, item.propertyName ?? '', item.reason,
    item.orderOnly ? '1' : '0', item.orderScopePointer ?? '', item.orderElementKind ?? ''].join('\0')).sort().join('\n');
  return signature(left) === signature(right);
}

function sameIdentity(
  left: { readonly ownership: string; readonly type: string; readonly name: string; readonly uuid: string; readonly sourceUuid?: string },
  right: { readonly ownership: string; readonly type: string; readonly name: string; readonly uuid: string; readonly sourceUuid?: string },
): boolean {
  return left.ownership === right.ownership && left.type === right.type && left.name === right.name
    && left.uuid.toLowerCase() === right.uuid.toLowerCase()
    && (left.sourceUuid?.toLowerCase() ?? '') === (right.sourceUuid?.toLowerCase() ?? '');
}

function normalizeCandidateWitnesses(
  recipe: CapturedAdoptedTemplateRecipe,
  witnesses: readonly MergeFileWitness[],
): MergeFileWitness[] {
  const logicalSides = [
    { capture: recipe.targetDescriptor, logical: recipe.descriptorRecipe.initialLogicalTarget },
    { capture: recipe.sourceDescriptor, logical: recipe.descriptorRecipe.initialLogicalSource },
  ];
  const normalized = witnesses.map((witness) => {
    assertWitnessShape(witness);
    const matching = logicalSides.filter((side) => side.capture.witness.sourceId === witness.sourceId
      && normalizePath(side.capture.witness.relativePath) === normalizePath(witness.relativePath));
    if (matching.length === 0) { return { ...witness, kind: witness.kind ?? 'file' }; }
    const exactLogical = matching.filter((side) => (witness.kind ?? 'file') === 'file' && hash(side.logical) === normalizeHash(witness.expectedHash));
    if (exactLogical.length === 1) { return { ...exactLogical[0]!.capture.witness }; }
    const exactPhysical = matching.filter((side) => sameHash(side.capture.witness.expectedHash, witness.expectedHash)
      && (side.capture.witness.kind ?? 'file') === (witness.kind ?? 'file'));
    if (exactPhysical.length === 1) { return { ...exactPhysical[0]!.capture.witness }; }
    throw new Error(`Witness Template candidate ${witness.sourceId}:${witness.relativePath} не совпадает точно с логическим или физическим захватом дескриптора.`);
  });
  return dedupeWitnesses(normalized);
}

function encodeTemplateExtendedState(
  content: Buffer,
  metadataType: 'Template' | 'CommonTemplate',
  formatVersion: string,
  removeTemplateTypeNotify: boolean,
): { readonly content: Buffer } | { readonly reason: string } {
  try {
    const document = parseXmlDocument(content.toString('utf8'));
    if (document.root.localName !== 'MetaDataObject' || namespaceUriForName(document.root) !== MD_CLASSES_NAMESPACE
        || document.root.attributes.filter((attribute) => attribute.name === 'version').length !== 1
        || document.root.attributes.find((attribute) => attribute.name === 'version')?.value !== formatVersion) {
      return { reason: 'Нельзя добавить Template=Extended: пространство имён корня или версия дескриптора изменились.' };
    }
    const objects = elementChildren(document.root).filter((element) => element.localName === metadataType
      && namespaceUriForName(element) === MD_CLASSES_NAMESPACE);
    if (objects.length !== 1) { return { reason: 'Нельзя добавить Template=Extended: дескриптор метаданных неоднозначен.' }; }
    const object = objects[0]!;
    const internalInfoMatches = elementChildren(object).filter((element) => element.localName === 'InternalInfo');
    const internalInfos = internalInfoMatches.filter((element) => namespaceUriForName(element) === MD_CLASSES_NAMESPACE);
    const properties = elementChildren(object).filter((element) => element.localName === 'Properties'
      && namespaceUriForName(element) === MD_CLASSES_NAMESPACE);
    if (internalInfos.length > 1 || properties.length !== 1) {
      return { reason: 'Нельзя добавить Template=Extended: InternalInfo или Properties неоднозначны.' };
    }
    let internalInfo = internalInfos[0];
    if (internalInfo) {
      const states = readablePropertyStates(internalInfo);
      if ('reason' in states) { return states; }
      const templateStates = states.items.filter((state) => state.property === 'Template');
      if (templateStates.length > 1 || templateStates.some((state) => state.value !== 'Extended')) {
        return { reason: 'У Template PropertyState неизвестное или повторяющееся значение.' };
      }
      let removedTemplateTypeNotify = false;
      if (removeTemplateTypeNotify) {
        const typeStates = states.items.filter((state) => state.property === 'TemplateType');
        if (typeStates.length > 1 || typeStates.some((state) => state.value !== 'Notify')) {
          return { reason: 'TemplateType PropertyState не является единственным выбранным уведомлением generic encoder.' };
        }
        const selected = typeStates[0];
        if (selected) {
          internalInfo.children = internalInfo.children.filter((child) => child !== selected.element);
          removedTemplateTypeNotify = true;
        }
      }
      if (templateStates.length === 1) {
        return { content: removedTemplateTypeNotify ? Buffer.from(serializeXmlDocument(document), 'utf8') : Buffer.from(content) };
      }
    } else {
      internalInfo = makeElement('InternalInfo', object);
      const propertiesIndex = object.children.indexOf(properties[0]!);
      object.children.splice(propertiesIndex, 0, internalInfo);
    }
    const state = makeTemplatePropertyState(object);
    internalInfo.children.push(state);
    state.parent = internalInfo;
    const propertyIndex = object.children.indexOf(properties[0]!);
    const internalIndex = object.children.indexOf(internalInfo);
    if (internalIndex > propertyIndex) {
      object.children.splice(internalIndex, 1);
      object.children.splice(propertyIndex, 0, internalInfo);
    }
    return { content: Buffer.from(serializeXmlDocument(document), 'utf8') };
  } catch (error) {
    return { reason: `Не удалось безопасно добавить Template=Extended: ${errorMessage(error)}` };
  }
}

function readablePropertyStates(internalInfo: XmlElement):
  | { readonly items: readonly { readonly element: XmlElement; readonly property: string; readonly value: string }[] }
  | { readonly reason: string } {
  const states = elementChildren(internalInfo).filter((element) => element.localName === 'PropertyState'
    && namespaceUriForName(element) === READABLE_NAMESPACE);
  const items: Array<{ element: XmlElement; property: string; value: string }> = [];
  for (const state of states) {
    const properties = elementChildren(state).filter((element) => element.localName === 'Property'
      && namespaceUriForName(element) === READABLE_NAMESPACE);
    const values = elementChildren(state).filter((element) => element.localName === 'State'
      && namespaceUriForName(element) === READABLE_NAMESPACE);
    if (properties.length !== 1 || values.length !== 1) { return { reason: 'Readable Template PropertyState имеет некорректную структуру.' }; }
    items.push({ element: state, property: textContent(properties[0]!).trim(), value: textContent(values[0]!).trim() });
  }
  return { items };
}

function makeTemplatePropertyState(context: XmlElement): XmlElement {
  const prefix = uniqueReadablePrefix(context);
  const state = makeElement(`${prefix}:PropertyState`, context);
  if (!hasNamespaceBinding(context, prefix, READABLE_NAMESPACE)) {
    state.attributes.push({ name: `xmlns:${prefix}`, localName: prefix, value: READABLE_NAMESPACE, quote: '"' });
  }
  const property = makeElement(`${prefix}:Property`, state);
  const value = makeElement(`${prefix}:State`, state);
  property.children.push({ kind: 'text', text: 'Template' });
  value.children.push({ kind: 'text', text: 'Extended' });
  property.parent = state;
  value.parent = state;
  state.children.push(property, value);
  return state;
}

function uniqueReadablePrefix(context: XmlElement): string {
  const bindings = new Map<string, string>();
  let current: XmlElement | undefined = context;
  while (current) {
    for (const attribute of current.attributes) {
      if (!attribute.name.startsWith('xmlns:')) { continue; }
      const prefix = attribute.name.slice('xmlns:'.length);
      if (!bindings.has(prefix)) { bindings.set(prefix, attribute.value); }
    }
    current = current.parent;
  }
  const existing = [...bindings].find(([, uri]) => uri === READABLE_NAMESPACE)?.[0];
  if (existing) { return existing; }
  let prefix = 'xr';
  let suffix = 1;
  while (bindings.has(prefix)) { prefix = `xrTemplate${suffix++}`; }
  return prefix;
}

function hasNamespaceBinding(context: XmlElement, prefix: string, uri: string): boolean {
  let current: XmlElement | undefined = context;
  while (current) {
    const declaration = current.attributes.find((attribute) => attribute.name === `xmlns:${prefix}`);
    if (declaration) { return declaration.value === uri; }
    current = current.parent;
  }
  return false;
}

function makeElement(name: string, parent: XmlElement): XmlElement {
  return { kind: 'element', name, localName: name.slice(name.lastIndexOf(':') + 1), attributes: [], children: [], parent };
}

function readTemplateType(content: Buffer, metadataType: 'Template' | 'CommonTemplate', formatVersion: string): string {
  const root = parseXmlDocument(content.toString('utf8')).root;
  if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MD_CLASSES_NAMESPACE
      || root.attributes.find((attribute) => attribute.name === 'version')?.value !== formatVersion) {
    throw new Error('В итоговом дескрипторе Template некорректны корень MDClasses или версия формата.');
  }
  const objects = elementChildren(root).filter((element) => element.localName === metadataType
    && namespaceUriForName(element) === MD_CLASSES_NAMESPACE);
  const properties = objects.length === 1 ? elementChildren(objects[0]!).filter((element) => element.localName === 'Properties'
    && namespaceUriForName(element) === MD_CLASSES_NAMESPACE) : [];
  const types = properties.length === 1 ? elementChildren(properties[0]!).filter((element) => element.localName === 'TemplateType'
    && namespaceUriForName(element) === MD_CLASSES_NAMESPACE) : [];
  if (types.length !== 1) { throw new Error('В итоговом логическом дескрипторе TemplateType отсутствует или неоднозначен.'); }
  return textContent(types[0]!).trim();
}

function bodyPath(descriptorPath: string, descriptor: Buffer, metadataType: 'Template' | 'CommonTemplate'): string {
  const result = requiredLinkedDesignerBodyPath('Template', descriptorPath, descriptor);
  if (!result) { throw new Error(`Для ${metadataType} не найден зарегистрированный путь однофайлового Template body.`); }
  return result.replace(/\\/gu, '/');
}

function dedupeWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] {
  const byKey = new Map<string, MergeFileWitness>();
  for (const witness of witnesses) {
    assertWitnessShape(witness);
    const kind = witness.kind ?? 'file';
    const key = `${witness.sourceId}\0${normalizePath(witness.relativePath)}\0${kind}`;
    const existing = byKey.get(key);
    if (existing && !sameHash(existing.expectedHash, witness.expectedHash)) {
      throw new Error(`Raw Template witnesses конфликтуют: ${witness.sourceId}:${witness.relativePath}.`);
    }
    if (!existing) { byKey.set(key, { ...witness, kind }); }
  }
  return [...byKey.values()];
}

function assertWitnessShape(witness: MergeFileWitness): void {
  if (!witness || !witness.sourceId.trim() || !witness.relativePath.trim()
      || (witness.expectedHash !== MISSING_TARGET_HASH && !/^(?:sha256:)?[\da-f]{64}$/iu.test(witness.expectedHash))) {
    throw new Error('Некорректный raw Template witness.');
  }
  const kind = witness.kind ?? 'file';
  if (kind !== 'file' && kind !== 'directory') { throw new Error('Тип Template witness не поддерживается.'); }
  if (witness.expectedHash === MISSING_TARGET_HASH && kind !== 'file') { throw new Error('Witness отсутствующего Template должен описывать файл.'); }
}

function sameCapture(left: { readonly content: Buffer; readonly identity: { readonly ownership: string; readonly type: string; readonly name: string; readonly uuid: string; readonly sourceUuid?: string }; readonly witness: MergeFileWitness },
  right: { readonly content: Buffer; readonly identity: { readonly ownership: string; readonly type: string; readonly name: string; readonly uuid: string; readonly sourceUuid?: string }; readonly witness: MergeFileWitness }): boolean {
  return left.content.equals(right.content) && left.identity.ownership === right.identity.ownership
    && left.identity.type === right.identity.type && left.identity.name === right.identity.name
    && left.identity.uuid.toLowerCase() === right.identity.uuid.toLowerCase()
    && (left.identity.sourceUuid?.toLowerCase() ?? '') === (right.identity.sourceUuid?.toLowerCase() ?? '')
    && sameHash(left.witness.expectedHash, right.witness.expectedHash)
    && normalizePath(left.witness.relativePath) === normalizePath(right.witness.relativePath)
    && left.witness.sourceId === right.witness.sourceId;
}

function sameWitnessList(left: readonly MergeFileWitness[], right: readonly MergeFileWitness[]): boolean {
  const signature = (witnesses: readonly MergeFileWitness[]) => witnesses.map((witness) =>
    `${witness.sourceId}\0${normalizePath(witness.relativePath)}\0${normalizeHash(witness.expectedHash)}\0${witness.kind ?? 'file'}`).sort().join('\n');
  return signature(left) === signature(right);
}

function sidePath(side: CapturedAdoptedTemplatePhysicalSide): string {
  return side.kind === 'file' ? side.capture.witness.relativePath : side.witness.relativePath;
}
function sideHash(side: CapturedAdoptedTemplatePhysicalSide): string { return side.kind === 'file' ? side.capture.witness.expectedHash : side.witness.expectedHash; }
function hash(content: Buffer): string { return createHash('sha256').update(content).digest('hex'); }
function sameHash(left: string, right: string): boolean { return normalizeHash(left) === normalizeHash(right); }
function normalizeHash(value: string): string { return value.replace(/^sha256:/iu, '').toLowerCase(); }
function normalizePath(value: string): string {
  const normalized = value.replace(/\\/gu, '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /[А-Яа-яЁё]/u.test(message) ? message : 'Данные Template некорректны или не удалось разобрать XML.';
}
