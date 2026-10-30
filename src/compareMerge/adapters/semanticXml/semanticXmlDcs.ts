import { buildXmlAddress, elementChildren, textContent, type XmlElement } from '../../xml/xmlDom';
import { normalizeReferenceValue, namespaceUriForName } from './semanticXmlIdentity';
import { metadataReferenceFromType } from './semanticXmlMetadataReferences';
import type { SemanticXmlDiagnostic, SemanticXmlValidationContext } from './semanticXmlValidator';

export const DCS_SCHEMA_NAMESPACE = 'http://v8.1c.ru/8.1/data-composition-system/schema';
export const DCS_SETTINGS_NAMESPACE = 'http://v8.1c.ru/8.1/data-composition-system/settings';
const XML_SCHEMA_INSTANCE_NAMESPACE = 'http://www.w3.org/2001/XMLSchema-instance';

export function dcsDiagnostics(
  root: XmlElement,
  context?: SemanticXmlValidationContext,
): SemanticXmlDiagnostic[] {
  const diagnostics: SemanticXmlDiagnostic[] = [];
  diagnostics.push(...ownerVersionDiagnostics(context?.ownerDescriptorVersions, root));

  const dataSources = direct(root, 'dataSource');
  const rootDataSets = direct(root, 'dataSet');
  const templates = direct(root, 'template');
  if (dataSources.length === 0) {diagnostics.push(diagnostic('XML_DCS_REQUIRED_MEMBER_MISSING', 'В схеме должен быть хотя бы один dataSource.', root));}
  if (rootDataSets.length === 0) {diagnostics.push(diagnostic('XML_DCS_REQUIRED_MEMBER_MISSING', 'В схеме должен быть хотя бы один dataSet.', root));}
  if (direct(root, 'settingsVariant').length === 0) {diagnostics.push(diagnostic('XML_DCS_REQUIRED_MEMBER_MISSING', 'В схеме должен быть хотя бы один settingsVariant.', root));}

  for (const source of dataSources) {
    requiredText(source, 'name', diagnostics);
    const sourceType = requiredText(source, 'dataSourceType', diagnostics);
    if (sourceType && sourceType !== 'Local' && sourceType !== 'External') {
      diagnostics.push(diagnostic('XML_DCS_DATA_SOURCE_TYPE_UNSUPPORTED', `Тип источника данных «${sourceType}» не входит в поддерживаемые Local/External.`, firstDirect(source, 'dataSourceType')));
    }
  }
  const allDataSets = collectDataSets(rootDataSets);
  for (const dataSet of allDataSets) {
    requiredText(dataSet, 'name', diagnostics);
    const dataSetType = dataSetTypeName(dataSet);
    if (!dataSetType) {
      diagnostics.push(diagnostic('XML_DCS_DATASET_TYPE_MISSING', 'У набора данных отсутствует xsi:type.', dataSet));
    } else if (dataSetType === 'DataSetQuery') {
      requiredText(dataSet, 'dataSource', diagnostics);
      requiredText(dataSet, 'query', diagnostics, true);
    } else if (dataSetType === 'DataSetObject') {
      requiredText(dataSet, 'dataSource', diagnostics);
      requiredText(dataSet, 'objectName', diagnostics);
    } else if (dataSetType === 'DataSetUnion') {
      if (direct(dataSet, 'item').length === 0) {
        diagnostics.push(diagnostic('XML_DCS_UNION_EMPTY', 'Объединение наборов данных должно содержать хотя бы один item.', dataSet));
      }
    } else {
      diagnostics.push(diagnostic('XML_DCS_DATASET_TYPE_UNSUPPORTED', `Тип набора данных «${dataSetType}» не поддерживается.`, dataSet));
    }
    for (const field of direct(dataSet, 'field')) {
      requiredText(field, 'dataPath', diagnostics);
    }
  }
  for (const parameter of direct(root, 'parameter')) {requiredText(parameter, 'name', diagnostics);}
  for (const template of templates) {requiredText(template, 'name', diagnostics);}
  for (const variant of direct(root, 'settingsVariant')) {
    requiredText(variant, 'name', diagnostics, false, DCS_SETTINGS_NAMESPACE);
  }
  for (const link of direct(root, 'dataSetLink')) {
    for (const name of ['sourceDataSet', 'destinationDataSet', 'sourceExpression', 'destinationExpression']) {
      requiredText(link, name, diagnostics);
    }
    optionalUniqueText(link, 'parameter', diagnostics);
  }
  for (const field of direct(root, 'calculatedField')) {
    requiredText(field, 'dataPath', diagnostics);
    requiredText(field, 'expression', diagnostics, true);
  }
  for (const field of direct(root, 'totalField')) {
    requiredText(field, 'dataPath', diagnostics);
    requiredText(field, 'expression', diagnostics, true);
  }
  for (const binding of direct(root, 'groupTemplate')) {
    requiredText(binding, 'groupField', diagnostics);
    requiredText(binding, 'templateType', diagnostics);
    requiredText(binding, 'template', diagnostics);
  }
  for (const binding of direct(root, 'groupHeaderTemplate')) {
    requiredText(binding, 'groupName', diagnostics);
    requiredText(binding, 'templateType', diagnostics);
    requiredText(binding, 'template', diagnostics);
  }

  diagnostics.push(...directReferenceDiagnostics(root, dataSources, allDataSets, rootDataSets, templates));
  diagnostics.push(...dcsMetadataReferenceDiagnostics(root, context?.availableMetadataReferences));
  return diagnostics;
}

function ownerVersionDiagnostics(
  versions: SemanticXmlValidationContext['ownerDescriptorVersions'],
  root: XmlElement,
): SemanticXmlDiagnostic[] {
  if (!versions) {
    return [diagnostic('XML_DCS_OWNER_VERSION_CONTEXT_REQUIRED', 'Для проверки DCS нужны подтверждённые версии дескрипторов владельца с обеих сторон.', root)];
  }
  const diagnostics: SemanticXmlDiagnostic[] = [];
  for (const [side, value] of [['целевого', versions.target], ['исходного', versions.incoming]] as const) {
    const match = /^2\.(\d+)$/u.exec(value);
    const minor = match ? Number(match[1]) : Number.NaN;
    if (!Number.isInteger(minor) || minor < 17 || minor > 21) {
      diagnostics.push(diagnostic('XML_DCS_OWNER_VERSION_UNSUPPORTED', `Версия ${side} дескриптора «${value}» не входит в проверенный диапазон 2.17–2.21.`, root));
    }
  }
  return diagnostics;
}

function collectDataSets(rootDataSets: readonly XmlElement[]): XmlElement[] {
  const result: XmlElement[] = [];
  const visit = (dataSet: XmlElement) => {
    result.push(dataSet);
    if (dataSetTypeName(dataSet) === 'DataSetUnion') {
      for (const item of direct(dataSet, 'item')) {visit(item);}
    }
  };
  rootDataSets.forEach(visit);
  return result;
}

function directReferenceDiagnostics(
  root: XmlElement,
  dataSources: readonly XmlElement[],
  dataSets: readonly XmlElement[],
  rootDataSets: readonly XmlElement[],
  templates: readonly XmlElement[],
): SemanticXmlDiagnostic[] {
  const diagnostics: SemanticXmlDiagnostic[] = [];
  const sourceNames = nameSet(dataSources);
  const dataSetNames = new Set(rootDataSets.map(requiredName).filter((name): name is string => Boolean(name)).map(normalizeReferenceValue));
  const templateNames = nameSet(templates);
  for (const dataSet of dataSets) {
    for (const sourceReference of direct(dataSet, 'dataSource')) {
      const reference = textContent(sourceReference).trim();
      if (reference && !sourceNames.has(normalizeReferenceValue(reference))) {
        diagnostics.push(diagnostic('XML_TYPE_REFERENCE', `Набор данных ссылается на отсутствующий источник данных «${reference}».`, sourceReference));
      }
    }
  }
  for (const link of direct(root, 'dataSetLink')) {
    for (const member of ['sourceDataSet', 'destinationDataSet']) {
      const reference = singleText(link, member);
      if (reference && !dataSetNames.has(normalizeReferenceValue(reference))) {
        diagnostics.push(diagnostic('XML_TYPE_REFERENCE', `Связь наборов данных ссылается на отсутствующий набор «${reference}».`, firstDirect(link, member)));
      }
    }
  }
  for (const binding of [...direct(root, 'groupTemplate'), ...direct(root, 'groupHeaderTemplate')]) {
    const reference = singleText(binding, 'template');
    if (reference && !templateNames.has(normalizeReferenceValue(reference))) {
      diagnostics.push(diagnostic('XML_TYPE_REFERENCE', `Привязка ссылается на отсутствующий шаблон «${reference}».`, firstDirect(binding, 'template')));
    }
  }
  return diagnostics;
}

function dcsMetadataReferenceDiagnostics(root: XmlElement, available?: readonly string[]): SemanticXmlDiagnostic[] {
  if (available === undefined) {return [];}
  const known = new Set(available.map(normalizeReferenceValue));
  const diagnostics: SemanticXmlDiagnostic[] = [];
  walk(root, (element) => {
    const reference = metadataReferenceFromType(element);
    if (!reference) {return;}
    if (reference.unsupported) {
      diagnostics.push(diagnostic('XML_TYPE_REFERENCE_KIND_UNSUPPORTED', `Тип данных «${textContent(element).trim()}» использует неподдерживаемую ссылку на метаданные.`, element));
    } else if (reference.qualifiedName && !known.has(normalizeReferenceValue(reference.qualifiedName))) {
      diagnostics.push(diagnostic('XML_TYPE_REFERENCE', `Тип данных ссылается на отсутствующий объект «${reference.qualifiedName}».`, element));
    }
  });
  return diagnostics;
}

export function dcsMetadataReferences(root: XmlElement): string[] {
  const references = new Set<string>();
  walk(root, (element) => {
    const reference = metadataReferenceFromType(element);
    if (reference?.qualifiedName) {
      references.add(reference.qualifiedName);
    }
  });
  return [...references];
}

function requiredText(
  element: XmlElement,
  name: string,
  diagnostics: SemanticXmlDiagnostic[],
  allowEmpty = false,
  namespace = DCS_SCHEMA_NAMESPACE,
): string | undefined {
  const matches = direct(element, name, namespace);
  if (matches.length !== 1) {
    diagnostics.push(diagnostic(matches.length > 1 ? 'XML_DCS_DUPLICATE_FIELD' : 'XML_DCS_REQUIRED_FIELD_MISSING',
      matches.length > 1 ? `Поле «${name}» повторяется в ${element.name}.` : `В ${element.name} отсутствует обязательное поле «${name}».`, matches[1] ?? element));
    return undefined;
  }
  const value = textContent(matches[0]!).trim();
  if (!allowEmpty && !value) {
    diagnostics.push(diagnostic('XML_DCS_REQUIRED_FIELD_MISSING', `Поле «${name}» в ${element.name} не должно быть пустым.`, matches[0]));
    return undefined;
  }
  return value;
}

function optionalUniqueText(element: XmlElement, name: string, diagnostics: SemanticXmlDiagnostic[]): void {
  if (direct(element, name).length > 1) {
    diagnostics.push(diagnostic('XML_DCS_DUPLICATE_FIELD', `Поле «${name}» повторяется в ${element.name}.`, firstDirect(element, name)));
  }
}

function direct(element: XmlElement, name: string, namespace = DCS_SCHEMA_NAMESPACE): XmlElement[] {
  return elementChildren(element).filter((child) => child.localName === name && namespaceUriForName(child) === namespace);
}

function firstDirect(element: XmlElement, name: string): XmlElement | undefined {
  return direct(element, name)[0];
}

function singleText(element: XmlElement, name: string): string | undefined {
  const match = direct(element, name);
  return match.length === 1 ? textContent(match[0]!).trim() || undefined : undefined;
}

function requiredName(element: XmlElement): string | undefined {
  return singleText(element, 'name');
}

function nameSet(elements: readonly XmlElement[]): Set<string> {
  return new Set(elements.map(requiredName).filter((name): name is string => Boolean(name)).map(normalizeReferenceValue));
}

function dataSetTypeName(element: XmlElement): string | undefined {
  const typeAttributes = element.attributes.filter((attribute) =>
    attribute.localName === 'type' && attributeNamespace(element, attribute.name) === XML_SCHEMA_INSTANCE_NAMESPACE
  );
  if (typeAttributes.length !== 1) {
    return undefined;
  }
  const qName = typeAttributes[0]!.value.trim();
  if (!qName || qName !== typeAttributes[0]!.value.trim() || qName.split(':').length > 2) {
    return undefined;
  }
  const separator = qName.indexOf(':');
  const prefix = separator < 0 ? '' : qName.slice(0, separator);
  const localName = separator < 0 ? qName : qName.slice(separator + 1);
  if (!/^[\p{L}_][\p{L}\p{N}_.-]*$/u.test(localName) || (separator >= 0 && !/^[\p{L}_][\p{L}\p{N}_.-]*$/u.test(prefix))) {
    return undefined;
  }
  return namespaceForQName(element, prefix) === DCS_SCHEMA_NAMESPACE ? localName : undefined;
}

function attributeNamespace(element: XmlElement, qualifiedName: string): string | undefined {
  const separator = qualifiedName.indexOf(':');
  if (separator < 0) {
    return '';
  }
  return namespaceForQName(element, qualifiedName.slice(0, separator));
}

function namespaceForQName(element: XmlElement, prefix: string): string | undefined {
  if (prefix === 'xml') {
    return 'http://www.w3.org/XML/1998/namespace';
  }
  let current: XmlElement | undefined = element;
  while (current) {
    const declaration = current.attributes.find((attribute) => attribute.name === (prefix ? `xmlns:${prefix}` : 'xmlns'));
    if (declaration) {
      return declaration.value || undefined;
    }
    current = current.parent;
  }
  return undefined;
}

function walk(element: XmlElement, visit: (element: XmlElement) => void): void {
  visit(element);
  for (const child of elementChildren(element)) {walk(child, visit);}
}

function diagnostic(code: string, message: string, element?: XmlElement): SemanticXmlDiagnostic {
  return {
    code,
    message,
    pointer: element ? buildXmlAddress('Template.xml', element).pointer : undefined,
    blocking: true,
  };
}
