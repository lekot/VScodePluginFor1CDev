import {
  buildXmlAddress,
  elementChildren,
  parseXmlDocument,
  textContent,
  type XmlElement,
} from '../../xml/xmlDom';
import {
  attributeByLocalName,
  normalizeQNameValue,
  normalizeReferenceValue,
  namespaceUriForName,
  semanticXmlIdentityKey,
  unboundQNamePrefix,
} from './semanticXmlIdentity';
import {
  isMetadataObjectRefItem,
  knownRootPropertyReferencesInXml,
  metadataReferenceFromType,
} from './semanticXmlMetadataReferences';
import { DESCRIPTOR_OBJECT_NAMES, isSupportedOneCXmlNamespace, metadataChildNameScope } from './semanticXmlPolicy';
import { roleRightsDiagnostics } from './semanticXmlRights';
import { dcsDiagnostics } from './semanticXmlDcs';

export type SemanticXmlKind = 'metadataXml' | 'formXml' | 'predefinedXml' | 'roleRightsXml' | 'dcsXml';

export interface SemanticXmlValidationContext {
  baselineSource?: string;
  availableFormReferences?: {
    attributes?: readonly string[];
    commands?: readonly string[];
    elements?: readonly string[];
  };
  availableMetadataReferences?: readonly string[];
  configurationName?: string;
  ownerDescriptorVersions?: { target: string; incoming: string };
}

export interface SemanticXmlDiagnostic {
  code: string;
  message: string;
  pointer?: string;
  blocking: true;
}

export interface SemanticXmlValidationResult {
  valid: boolean;
  diagnostics: readonly SemanticXmlDiagnostic[];
}

/** Validates a complete post-selection XML document before preview or mutation. */
export function validateSemanticXmlMerge(
  source: string,
  kind: SemanticXmlKind,
  context?: SemanticXmlValidationContext
): SemanticXmlValidationResult {
  const diagnostics = collectDiagnostics(source, kind, context);
  if (context?.baselineSource !== undefined) {
    const previousCounts = countReferenceDiagnostics(collectDiagnostics(context.baselineSource, kind, context));
    const newDiagnostics = diagnostics.filter((diagnostic) => {
      if (!REFERENCE_DIAGNOSTIC_CODES.has(diagnostic.code)) {
        return true;
      }
      const key = diagnosticKey(diagnostic);
      const count = previousCounts.get(key) ?? 0;
      if (count <= 0) {
        return true;
      }
      previousCounts.set(key, count - 1);
      return false;
    });
    const versionDiagnostics = formatVersionMismatchDiagnostics(source, context.baselineSource, kind);
    const combined = [...newDiagnostics, ...versionDiagnostics];
    return { valid: combined.length === 0, diagnostics: combined };
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

function formatVersionMismatchDiagnostics(
  source: string,
  baselineSource: string,
  kind: SemanticXmlKind
): SemanticXmlDiagnostic[] {
  try {
    const selectedRoot = parseXmlDocument(source).root;
    const baselineRoot = parseXmlDocument(baselineSource).root;
    const selectedVersion = attributeByLocalName(selectedRoot, 'version');
    const baselineVersion = attributeByLocalName(baselineRoot, 'version');
    if (
      selectedRoot.localName === expectedRootName(kind) &&
      baselineRoot.localName === expectedRootName(kind) &&
      selectedVersion && baselineVersion && selectedVersion !== baselineVersion &&
      isVerifiedNativeVersion(selectedVersion) && isVerifiedNativeVersion(baselineVersion)
    ) {
      return [diagnostic('XML_FORMAT_VERSION_MISMATCH', `Версия формата источника ${selectedVersion} отличается от целевой версии ${baselineVersion}; перенос свойств между форматами не поддерживается.`, selectedRoot)];
    }
  } catch {
    return [];
  }
  return [];
}

function expectedRootName(kind: SemanticXmlKind): string {
  if (kind === 'metadataXml') {return 'MetaDataObject';}
  if (kind === 'formXml') {return 'Form';}
  if (kind === 'predefinedXml') {return 'PredefinedData';}
  return kind === 'roleRightsXml' ? 'Rights' : 'DataCompositionSchema';
}

function collectDiagnostics(
  source: string,
  kind: SemanticXmlKind,
  context?: SemanticXmlValidationContext
): SemanticXmlDiagnostic[] {
  let root: XmlElement;
  try {
    root = parseXmlDocument(source).root;
  } catch (error) {
    return [diagnostic('XML_PARSE_FAILED', `Не удалось проверить XML: ${error instanceof Error ? error.message : String(error)}`)];
  }

  const diagnostics: SemanticXmlDiagnostic[] = [];
  const expectedRoot = expectedRootName(kind);
  if (root.localName !== expectedRoot) {
    diagnostics.push(diagnostic('XML_ROOT_KIND_MISMATCH', `Ожидался корневой элемент ${expectedRoot}, получен ${root.name}.`, root));
    return diagnostics;
  }
  const expectedNamespace = ROOT_NAMESPACE_BY_KIND[kind];
  const rootNamespace = namespaceUriForName(root);
  if ((kind === 'roleRightsXml' || kind === 'dcsXml') ? rootNamespace !== expectedNamespace : Boolean(rootNamespace && rootNamespace !== expectedNamespace)) {
    diagnostics.push(diagnostic('XML_ROOT_NAMESPACE_UNSUPPORTED', `Корневой элемент ${root.name} использует неподдерживаемое пространство имён «${rootNamespace}».`, root));
  }

  const version = attributeByLocalName(root, 'version');
  if (version) {
    const match = /^2\.(\d+)$/u.exec(version);
    const minor = match ? Number(match[1]) : Number.NaN;
    if (!Number.isInteger(minor) || minor < 17 || minor > 21) {
      diagnostics.push(diagnostic('XML_FORMAT_VERSION_UNSUPPORTED', `Формат версии ${version} не входит в проверенный диапазон 2.17–2.21.`, root));
    }
  }

  diagnostics.push(...duplicateIdentityDiagnostics(root, kind));
  if (kind === 'metadataXml') {
    diagnostics.push(...metadataUuidDiagnostics(root, version));
    diagnostics.push(...duplicateMetadataNameDiagnostics(root));
  }
  diagnostics.push(...typeQualifierDiagnostics(root));
  diagnostics.push(...qNameAttributeDiagnostics(root));
  if (kind === 'predefinedXml') {
    diagnostics.push(...predefinedIdentityDiagnostics(root));
    diagnostics.push(...predefinedReferenceDiagnostics(root));
  }
  if (kind === 'formXml') {
    diagnostics.push(...formReferenceDiagnostics(root, context?.availableFormReferences));
    diagnostics.push(...formNumericIdDiagnostics(root, version));
    diagnostics.push(...baseFormShapeDiagnostics(root));
  }
  if (kind === 'metadataXml' || kind === 'formXml') {
    diagnostics.push(...metadataReferenceDiagnostics(
      root,
      context?.availableMetadataReferences,
      kind === 'metadataXml'
    ));
  }
  if (kind === 'metadataXml') {
    diagnostics.push(...knownRootPropertyReferenceDiagnostics(root, context?.availableMetadataReferences));
  }
  if (kind === 'roleRightsXml') {
    diagnostics.push(...roleRightsDiagnostics(root, context));
  }
  if (kind === 'dcsXml') {
    diagnostics.push(...dcsDiagnostics(root, context));
  }
  return diagnostics;
}

function knownRootPropertyReferenceDiagnostics(
  root: XmlElement,
  available: readonly string[] | undefined
): SemanticXmlDiagnostic[] {
  const scan = knownRootPropertyReferencesInXml(root);
  const diagnostics: SemanticXmlDiagnostic[] = scan.errors.map((item) =>
    diagnostic('XML_ROOT_PROPERTY_REFERENCE_FORMAT', item.message, root)
  );
  if (scan.references.length === 0) {
    return diagnostics;
  }
  if (available === undefined) {
    diagnostics.push(diagnostic('XML_ROOT_PROPERTY_REFERENCE_CONTEXT_REQUIRED', 'Для проверки ссылки свойства корневого объекта требуется инвентарь целевой конфигурации.', root));
    return diagnostics;
  }
  const known = new Set(available.map(normalizeReferenceValue));
  for (const reference of scan.references) {
    if (!known.has(normalizeReferenceValue(reference.qualifiedName))) {
      diagnostics.push(diagnostic('XML_ROOT_PROPERTY_REFERENCE', `Ссылка «${reference.qualifiedName}» в свойстве корневого объекта отсутствует в целевой конфигурации.`, root));
    }
  }
  return diagnostics;
}

function metadataUuidDiagnostics(root: XmlElement, version: string | undefined): SemanticXmlDiagnostic[] {
  if (!isVerifiedNativeVersion(version)) {
    return [];
  }
  const diagnostics: SemanticXmlDiagnostic[] = [];
  walk(root, (element) => {
    const uuid = attributeByLocalName(element, 'uuid');
    if (!uuid || !DESCRIPTOR_OBJECT_NAMES.has(element.localName)) {
      return;
    }
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(uuid)) {
      diagnostics.push(diagnostic('XML_METADATA_INVALID_UUID', `UUID объекта метаданных «${uuid}» имеет неверный формат.`, element));
    }
  });
  return diagnostics;
}

function duplicateMetadataNameDiagnostics(root: XmlElement): SemanticXmlDiagnostic[] {
  const diagnostics: SemanticXmlDiagnostic[] = [];
  walk(root, (parent) => {
    if (parent.localName !== 'ChildObjects') {
      return;
    }
    const names = new Set<string>();
    for (const child of elementChildren(parent)) {
      if (!DESCRIPTOR_OBJECT_NAMES.has(child.localName)) {
        continue;
      }
      const properties = elementChildren(child).find((candidate) => candidate.localName === 'Properties');
      const name = properties ? directText(properties, 'Name') : undefined;
      if (!name) {
        continue;
      }
      const key = `${metadataChildNameScope(child.localName)}:${normalizeReferenceValue(name)}`;
      if (names.has(key)) {
        diagnostics.push(diagnostic('XML_METADATA_DUPLICATE_NAME', `Имя объекта метаданных «${name}» повторяется в разделе ${parent.name}.`, child));
      } else {
        names.add(key);
      }
    }
  });
  return diagnostics;
}

function formNumericIdDiagnostics(root: XmlElement, version: string | undefined): SemanticXmlDiagnostic[] {
  if (!isVerifiedNativeVersion(version)) {
    return [];
  }
  const diagnostics: SemanticXmlDiagnostic[] = [];
  walk(root, (element) => {
    const id = attributeByLocalName(element, 'id');
    if (!id || !isFormItem(element) || /^-?\d+$/u.test(id)) {
      return;
    }
    diagnostics.push(diagnostic('XML_FORM_INVALID_ID', `Идентификатор элемента формы «${id}» должен быть целым числом.`, element));
  });
  return diagnostics;
}

function baseFormShapeDiagnostics(root: XmlElement): SemanticXmlDiagnostic[] {
  const bases = elementChildren(root).filter((child) => child.localName === 'BaseForm');
  if (bases.length === 0) {
    return [];
  }
  if (bases.length !== 1) {
    return [diagnostic('XML_FORM_BASEFORM_SHAPE', 'Заимствованная форма должна содержать ровно один прямой BaseForm.', bases[1] ?? root)];
  }
  const base = bases[0]!;
  const direct = elementChildren(root);
  const diagnostics: SemanticXmlDiagnostic[] = [];
  if (direct[direct.length - 1] !== base) {
    diagnostics.push(diagnostic('XML_FORM_BASEFORM_SHAPE', 'BaseForm должен быть последним прямым элементом формы.', base));
  }
  const formVersion = attributeByLocalName(root, 'version');
  const baseVersion = attributeByLocalName(base, 'version');
  if (!formVersion || baseVersion !== formVersion) {
    diagnostics.push(diagnostic('XML_FORM_BASEFORM_SHAPE', 'Версия BaseForm должна совпадать с версией формы.', base));
  }
  const forbidden = elementChildren(base).find((child) => ['Events', 'Commands', 'Parameters', 'CommandInterface'].includes(child.localName));
  if (forbidden) {
    diagnostics.push(diagnostic('XML_FORM_BASEFORM_SHAPE', `BaseForm не может содержать прямой раздел ${forbidden.localName}.`, forbidden));
  }
  return diagnostics;
}

function isVerifiedNativeVersion(version: string | undefined): boolean {
  const match = version && /^2\.(\d+)$/u.exec(version);
  const minor = match ? Number(match[1]) : Number.NaN;
  return Number.isInteger(minor) && minor >= 17 && minor <= 21;
}

function duplicateIdentityDiagnostics(root: XmlElement, kind: SemanticXmlKind): SemanticXmlDiagnostic[] {
  const diagnostics: SemanticXmlDiagnostic[] = [];
  walk(root, (parent) => {
    const seen = new Set<string>();
    for (const child of elementChildren(parent)) {
      const identity = semanticXmlIdentityKey(child, parent, kind);
      if (!identity) {
        continue;
      }
      const key = `${child.localName}:${identity}`;
      if (seen.has(key)) {
        diagnostics.push(diagnostic(duplicateCode(kind), `Неоднозначная повторяющаяся идентичность ${identity} в разделе ${parent.name}.`, child));
      } else {
        seen.add(key);
      }
    }
  });

  const globalIds = new Map<string, XmlElement>();
  walk(root, (element) => {
    const id = kind === 'predefinedXml' ? attributeByLocalName(element, 'id') : attributeByLocalName(element, 'uuid');
    if (!id || (kind === 'predefinedXml' && element.localName !== 'Item')) {
      return;
    }
    const key = normalizeReferenceValue(id);
    if (globalIds.has(key)) {
      diagnostics.push(diagnostic(duplicateCode(kind), `Идентификатор «${id}» используется более одного раза.`, element));
    } else {
      globalIds.set(key, element);
    }
  });

  if (kind === 'formXml') {
    const seenIds = new Map<string, XmlElement>();
    walk(root, (element) => {
      const id = attributeByLocalName(element, 'id');
      const name = attributeByLocalName(element, 'name');
      if (!id || !name || !isFormItem(element)) {
        return;
      }
      const key = `${formItemScope(element)}:${normalizeReferenceValue(id)}`;
      if (seenIds.has(key)) {
        diagnostics.push(diagnostic('XML_FORM_DUPLICATE_ID', `Идентификатор элемента формы «${id}» повторяется в группе ${formItemScope(element)}.`, element));
      } else {
        seenIds.set(key, element);
      }
    });
  }
  return diagnostics;
}

function duplicateCode(kind: SemanticXmlKind): string {
  if (kind === 'formXml') {return 'XML_FORM_DUPLICATE_ID';}
  if (kind === 'predefinedXml') {return 'XML_PREDEFINED_DUPLICATE_ID';}
  if (kind === 'roleRightsXml') {return 'XML_RIGHTS_DUPLICATE_IDENTITY';}
  if (kind === 'dcsXml') {return 'XML_DCS_DUPLICATE_IDENTITY';}
  return 'XML_METADATA_DUPLICATE_ID';
}

function predefinedIdentityDiagnostics(root: XmlElement): SemanticXmlDiagnostic[] {
  const diagnostics: SemanticXmlDiagnostic[] = [];
  const versioned = Boolean(attributeByLocalName(root, 'version'));
  const seenNames = new Map<string, XmlElement>();
  for (const item of descendants(root).filter((element) => element.localName === 'Item')) {
    const id = attributeByLocalName(item, 'id');
    if (!id) {
      diagnostics.push(diagnostic('XML_PREDEFINED_MISSING_ID', 'У предопределённого элемента отсутствует UUID в атрибуте id; безопасное сопоставление невозможно.', item));
    } else if (versioned && !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(id)) {
      diagnostics.push(diagnostic('XML_PREDEFINED_INVALID_UUID', `Идентификатор предопределённого элемента «${id}» не является UUID.`, item));
    }
    const name = directText(item, 'Name');
    if (!name) {
      diagnostics.push(diagnostic('XML_PREDEFINED_MISSING_NAME', 'У предопределённого элемента отсутствует обязательное имя.', item));
    } else {
      const key = normalizeReferenceValue(name);
      if (seenNames.has(key)) {
        diagnostics.push(diagnostic('XML_PREDEFINED_DUPLICATE_NAME', `Имя предопределённого элемента «${name}» повторяется в дереве.`, item));
      } else {
        seenNames.set(key, item);
      }
    }
  }
  return diagnostics;
}

function predefinedReferenceDiagnostics(root: XmlElement): SemanticXmlDiagnostic[] {
  const itemIds = new Set(
    descendants(root)
      .filter((element) => element.localName === 'Item')
      .map((item) => attributeByLocalName(item, 'id'))
      .filter((value): value is string => Boolean(value))
      .map(normalizeReferenceValue)
  );
  const diagnostics: SemanticXmlDiagnostic[] = [];
  walk(root, (element) => {
    if (!['Parent', 'ParentID', 'ParentId', 'FolderID', 'FolderId'].includes(element.localName)) {
      return;
    }
    const reference = textContent(element).trim();
    if (reference && !itemIds.has(normalizeReferenceValue(reference))) {
      diagnostics.push(diagnostic('XML_PREDEFINED_REFERENCE', `Ссылка предопределённого элемента «${reference}» указывает на отсутствующий UUID.`, element));
    }
  });
  return diagnostics;
}

function typeQualifierDiagnostics(root: XmlElement): SemanticXmlDiagnostic[] {
  const diagnostics: SemanticXmlDiagnostic[] = [];
  walk(root, (element) => {
    if (element.localName !== 'Type' || !isOneCNamespace(element)) {
      return;
    }
    const children = elementChildren(element).filter(isOneCNamespace);
    const typeElements = children.filter((child) => child.localName === 'Type');
    const types = typeElements
      .filter((child) => child.localName === 'Type')
      .map((child) => normalizeQNameValue(textContent(child), child));
    for (const typeElement of typeElements) {
      const prefix = unboundQNamePrefix(textContent(typeElement), typeElement);
      if (prefix) {
        diagnostics.push(diagnostic('XML_UNBOUND_QNAME_PREFIX', `Префикс QName «${prefix}» в значении типа не объявлен.`, typeElement));
      }
    }
    const qualifiers: Array<{ name: string; primitives: readonly string[] }> = [
      { name: 'StringQualifiers', primitives: ['string'] },
      { name: 'NumberQualifiers', primitives: ['decimal', 'integer', 'int', 'long', 'double', 'float', 'nonNegativeInteger', 'positiveInteger'] },
      { name: 'DateQualifiers', primitives: ['date', 'time', 'dateTime'] },
    ];
    for (const qualifier of qualifiers) {
      const node = children.find((child) => child.localName === qualifier.name);
      const primitiveNames = qualifier.primitives.map((name) => `{${XML_SCHEMA_NAMESPACE}}${name}`);
      if (node && (types.length === 0 || !types.some((type) => primitiveNames.includes(type)))) {
        diagnostics.push(diagnostic('XML_TYPE_QUALIFIER_MISMATCH', `Квалификатор ${qualifier.name} не соответствует ни одному выбранному типу.`, node));
      }
      if (node) {
        diagnostics.push(...qualifierBoundDiagnostics(node));
      }
    }
  });
  return diagnostics;
}

function qNameAttributeDiagnostics(root: XmlElement): SemanticXmlDiagnostic[] {
  const diagnostics: SemanticXmlDiagnostic[] = [];
  walk(root, (element) => {
    for (const attribute of element.attributes) {
      if (attribute.localName.toLowerCase() !== 'type' || namespaceUriForName(element, attribute.name, true) !== XML_SCHEMA_INSTANCE_NAMESPACE) {
        continue;
      }
      const prefix = unboundQNamePrefix(attribute.value, element);
      if (prefix) {
        diagnostics.push(diagnostic('XML_UNBOUND_QNAME_PREFIX', `Префикс QName «${prefix}» в атрибуте xsi:type не объявлен.`, element));
      }
    }
  });
  return diagnostics;
}

function formReferenceDiagnostics(
  root: XmlElement,
  available?: SemanticXmlValidationContext['availableFormReferences']
): SemanticXmlDiagnostic[] {
  const diagnostics: SemanticXmlDiagnostic[] = [];
  const attributes = new Set([
    ...formNamedElements(root, 'Attributes', 'Attribute'),
    ...formNamedElements(root, 'Parameters', 'Parameter'),
    ...(available?.attributes ?? []),
  ].map(normalizeReferenceValue));
  const commands = new Set([
    ...formNamedElements(root, 'Commands', 'Command'),
    ...(available?.commands ?? []),
  ].map(normalizeReferenceValue));
  const elements = new Set([
    ...descendants(root).filter(isFormItem).flatMap((element) => [
      attributeByLocalName(element, 'name'),
      attributeByLocalName(element, 'id'),
    ].filter((value): value is string => Boolean(value))),
    ...(available?.elements ?? []),
  ].map(normalizeReferenceValue));

  walk(root, (element) => {
    if (!isOneCNamespace(element)) {
      return;
    }
    if (element.localName === 'DataPath') {
      const value = textContent(element).trim();
      const target = value.split('.')[0]?.trim() ?? '';
      if (target && !attributes.has(normalizeReferenceValue(target))) {
        diagnostics.push(diagnostic('XML_FORM_ATTRIBUTE_REFERENCE', `Путь данных «${value}» ссылается на отсутствующий реквизит или параметр «${target}».`, element));
      }
    } else if (element.localName === 'CommandName') {
      const value = textContent(element).trim();
      if (!value || value === '0' || value.startsWith('Form.StandardCommand.')) {
        return;
      }
      const command = value.startsWith('Form.Command.') ? value.slice('Form.Command.'.length) : value;
      if (!commands.has(normalizeReferenceValue(command)) && !commands.has(normalizeReferenceValue(value))) {
        diagnostics.push(diagnostic('XML_FORM_COMMAND_REFERENCE', `Команда формы «${value}» не найдена в списке команд.`, element));
      }
    } else if (element.localName === 'ElementRef' || element.localName === 'ElementName') {
      const value = textContent(element).trim();
      if (value && !elements.has(normalizeReferenceValue(value))) {
        diagnostics.push(diagnostic('XML_FORM_ELEMENT_REFERENCE', `Ссылка на элемент формы «${value}» не найдена.`, element));
      }
    }
  });
  return diagnostics;
}

function metadataReferenceDiagnostics(
  root: XmlElement,
  available: readonly string[] | undefined,
  includeSubsystemContent: boolean
): SemanticXmlDiagnostic[] {
  const known = new Set((available ?? []).map(normalizeReferenceValue));
  const hasInventory = available !== undefined;
  const diagnostics: SemanticXmlDiagnostic[] = [];
  walk(root, (element) => {
    const metadataReference = metadataReferenceFromType(element);
    if (!metadataReference) {
      return;
    }
    if (metadataReference.unsupported) {
      diagnostics.push(diagnostic('XML_TYPE_REFERENCE_KIND_UNSUPPORTED', `Тип метаданных «${textContent(element).trim()}» использует непроверенный формат ссылки.`, element));
    } else if (!hasInventory) {
      diagnostics.push(diagnostic('XML_TYPE_REFERENCE_CONTEXT_REQUIRED', 'Для проверки ссылки типа требуется инвентарь целевой конфигурации.', element));
    } else if (metadataReference.qualifiedName && !known.has(normalizeReferenceValue(metadataReference.qualifiedName))) {
      diagnostics.push(diagnostic('XML_TYPE_REFERENCE', `Ссылка типа «${metadataReference.qualifiedName}» отсутствует в целевой конфигурации.`, element));
    }
  });
  if (!includeSubsystemContent) {
    return diagnostics;
  }
  walk(root, (subsystem) => {
    if (subsystem.localName !== 'Subsystem' || !isOneCNamespace(subsystem)) {
      return;
    }
    const properties = elementChildren(subsystem).find((child) => child.localName === 'Properties' && isOneCNamespace(child));
    const content = properties && elementChildren(properties).find((child) => child.localName === 'Content' && isOneCNamespace(child));
    for (const item of content ? elementChildren(content).filter(isMetadataObjectRefItem) : []) {
      const reference = textContent(item).trim();
      if (reference && !hasInventory) {
        diagnostics.push(diagnostic('XML_CONTENT_REFERENCE_CONTEXT_REQUIRED', 'Для проверки состава подсистемы требуется инвентарь целевой конфигурации.', item));
      } else if (reference && !known.has(normalizeReferenceValue(reference))) {
        diagnostics.push(diagnostic('XML_CONTENT_REFERENCE', `Ссылка подсистемы «${reference}» отсутствует в целевой конфигурации.`, item));
      }
    }
  });
  return diagnostics;
}

function formNamedElements(root: XmlElement, containerName: string, itemName: string): string[] {
  return descendants(root)
    .filter((element) => isOneCNamespace(element) && element.localName === itemName && element.parent?.localName === containerName)
    .map((element) => attributeByLocalName(element, 'name'))
    .filter((value): value is string => Boolean(value));
}

function isFormItem(element: XmlElement): boolean {
  return Boolean(attributeByLocalName(element, 'id') && attributeByLocalName(element, 'name'));
}

function formItemScope(element: XmlElement): string {
  let current: XmlElement | undefined = element.parent;
  let inBaseForm = false;
  let scope = 'Form';
  while (current) {
    if (current.localName === 'BaseForm') {
      inBaseForm = true;
    }
    if (scope === 'Form' && ['ChildItems', 'Attributes', 'Commands', 'Parameters'].includes(current.localName)) {
      scope = current.localName;
    }
    current = current.parent;
  }
  return (inBaseForm ? 'BaseForm/' : '') + scope;
}

function directText(element: XmlElement, name: string): string | undefined {
  const child = elementChildren(element).find((candidate) => candidate.localName === name);
  const value = child ? textContent(child).trim() : '';
  return value || undefined;
}

function walk(element: XmlElement, visit: (element: XmlElement) => void): void {
  visit(element);
  for (const child of elementChildren(element)) {
    walk(child, visit);
  }
}

function descendants(root: XmlElement): XmlElement[] {
  const result: XmlElement[] = [];
  walk(root, (element) => result.push(element));
  return result;
}

function diagnostic(code: string, message: string, element?: XmlElement): SemanticXmlDiagnostic {
  return {
    code,
    message,
    pointer: element ? buildXmlAddress('semantic-validation.xml', element).pointer : undefined,
    blocking: true,
  };
}

function diagnosticKey(item: SemanticXmlDiagnostic): string {
  return `${item.code}\u0000${item.message}\u0000${item.pointer ?? ''}`;
}

const XML_SCHEMA_NAMESPACE = 'http://www.w3.org/2001/XMLSchema';
const XML_SCHEMA_INSTANCE_NAMESPACE = 'http://www.w3.org/2001/XMLSchema-instance';
const ROOT_NAMESPACE_BY_KIND: Record<SemanticXmlKind, string> = {
  metadataXml: 'http://v8.1c.ru/8.3/MDClasses',
  formXml: 'http://v8.1c.ru/8.3/xcf/logform',
  predefinedXml: 'http://v8.1c.ru/8.3/xcf/predef',
  roleRightsXml: 'http://v8.1c.ru/8.2/roles',
  dcsXml: 'http://v8.1c.ru/8.1/data-composition-system/schema',
};
const REFERENCE_DIAGNOSTIC_CODES = new Set([
  'XML_FORM_ATTRIBUTE_REFERENCE', 'XML_FORM_COMMAND_REFERENCE', 'XML_FORM_ELEMENT_REFERENCE',
  'XML_CONTENT_REFERENCE', 'XML_TYPE_REFERENCE', 'XML_CONTENT_REFERENCE_CONTEXT_REQUIRED',
  'XML_TYPE_REFERENCE_CONTEXT_REQUIRED',
]);

function isOneCNamespace(element: XmlElement): boolean {
  return isSupportedOneCXmlNamespace(namespaceUriForName(element));
}

function qualifierBoundDiagnostics(node: XmlElement): SemanticXmlDiagnostic[] {
  const fields = elementChildren(node);
  const diagnostics: SemanticXmlDiagnostic[] = [];
  for (const name of ['Length', 'Digits', 'FractionDigits']) {
    const values = fields.filter((field) => field.localName === name);
    if (values.length > 1) {
      diagnostics.push(diagnostic('XML_TYPE_QUALIFIER_BOUNDS', `Поле ${name} повторяется в квалификаторе ${node.localName}.`, values[1]));
    }
  }

  const numeric = (name: string): number | undefined => {
    const field = fields.find((candidate) => candidate.localName === name);
    if (!field) {
      return undefined;
    }
    const value = textContent(field).trim();
    return /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  };
  if (node.localName === 'StringQualifiers') {
    const length = numeric('Length');
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) {
      diagnostics.push(diagnostic('XML_TYPE_QUALIFIER_BOUNDS', 'Длина строки должна быть неотрицательным целым числом; 0 означает неограниченную длину.', node));
    }
  }
  if (node.localName === 'NumberQualifiers') {
    const digits = numeric('Digits');
    const fractionDigits = numeric('FractionDigits');
    if (digits !== undefined && (!Number.isSafeInteger(digits) || digits < 1 || digits > 38)) {
      diagnostics.push(diagnostic('XML_TYPE_QUALIFIER_BOUNDS', 'Количество разрядов должно быть целым числом от 1 до 38.', node));
    }
    if (fractionDigits !== undefined && (!Number.isSafeInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 38)) {
      diagnostics.push(diagnostic('XML_TYPE_QUALIFIER_BOUNDS', 'Количество дробных разрядов должно быть целым числом от 0 до 38.', node));
    }
    if (digits !== undefined && fractionDigits !== undefined && Number.isSafeInteger(digits) && Number.isSafeInteger(fractionDigits) && fractionDigits > digits) {
      diagnostics.push(diagnostic('XML_TYPE_QUALIFIER_BOUNDS', 'Количество дробных разрядов не может превышать общее количество разрядов.', node));
    }
  }
  return diagnostics;
}

function countReferenceDiagnostics(diagnostics: readonly SemanticXmlDiagnostic[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of diagnostics) {
    if (REFERENCE_DIAGNOSTIC_CODES.has(item.code)) {
      const key = diagnosticKey(item);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}
