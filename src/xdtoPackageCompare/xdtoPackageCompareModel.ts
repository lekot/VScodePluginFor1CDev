import * as path from 'path';
import { parseXdtoPackage } from '../parsers/xdtoPackageParser';
import type { CompareTreeNode, CompareTreeStats, CompareTreeStatus } from '../compareMerge/compareTreeTypes';
import type { XdtoImport, XdtoPackageModel, XdtoProperty, XdtoTypeDefinition } from '../types/xdtoPackage';
import { stripUtf8Bom } from '../xdtoPackageEditor/xdtoPackageFiles';
import { convertXsdTo1cPackage } from '../xdtoPackageEditor/xdtoXsdConverter';

const PROPERTY_FIELD_LABELS = [
  ['type', 'Тип'],
  ['ref', 'Ссылка'],
  ['lowerBound', 'Нижняя граница'],
  ['upperBound', 'Верхняя граница'],
  ['minOccurs', 'Минимальное количество'],
  ['maxOccurs', 'Максимальное количество'],
  ['nillable', 'Возможно пустое'],
  ['fixed', 'Фиксированное'],
  ['defaultValue', 'По умолчанию'],
  ['form', 'Форма'],
  ['localName', 'Локальное имя'],
  ['namespaceURI', 'URI пространства имен'],
  ['qualified', 'Квалифицированное'],
  ['use', 'Использование'],
] as const;

type PropertyField = typeof PROPERTY_FIELD_LABELS[number][0];
type TypeSection = 'valueTypes' | 'objectTypes';
type PropertySection = 'properties' | 'attributes';

export interface XdtoPackageCompareTree {
  root: CompareTreeNode;
  stats: CompareTreeStats;
}

function isXsdSource(fileName: string, source: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  const trimmed = stripUtf8Bom(source).slice(0, 400);
  return ext === '.xsd' || /<([A-Za-z0-9_-]+:)?schema\b/.test(trimmed)
    && trimmed.includes('http://www.w3.org/2001/XMLSchema');
}

function parseWithoutBlockingErrors(source: string): XdtoPackageModel {
  const model = parseXdtoPackage(stripUtf8Bom(source));
  const error = model.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
  if (error) {
    throw new Error(error.message);
  }
  return model;
}

export function parseXdtoComparableSource(
  fileName: string,
  source: string,
  fallbackNamespace = ''
): XdtoPackageModel {
  const normalizedSource = isXsdSource(fileName, source)
    ? convertXsdTo1cPackage(source, fallbackNamespace)
    : source;
  return parseWithoutBlockingErrors(normalizedSource);
}

export function buildXdtoPackageCompareTree(
  left: XdtoPackageModel,
  right: XdtoPackageModel
): XdtoPackageCompareTree {
  const children: CompareTreeNode[] = [
    compareScalarNode('root:targetNamespace', 'Пространство имен', 'packageField', left.targetNamespace, right.targetNamespace),
    compareImports(left.imports, right.imports),
    compareTypes('valueTypes', 'Типы значений', left.valueTypes, right.valueTypes),
    compareObjectTypes(left.objectTypes, right.objectTypes),
    compareRootProperties(left.rootProperties, right.rootProperties),
  ];
  const root = branchNode('package', 'XDTO-пакет', 'package', children);
  const stats = collectStats(root);
  return { root, stats };
}

export function applyXdtoPackageMerge(
  left: XdtoPackageModel,
  right: XdtoPackageModel,
  selectedIds: readonly string[]
): XdtoPackageModel {
  const selected = new Set(selectedIds);
  const next = cloneModel(left);

  if (selected.has('root:targetNamespace')) {
    next.targetNamespace = right.targetNamespace;
  }

  applyImportsMerge(next, right, selected);
  applyTypeMerge(next.valueTypes, right.valueTypes, 'valueTypes', selected);
  applyTypeMerge(next.objectTypes, right.objectTypes, 'objectTypes', selected);
  applyRootPropertiesMerge(next, right, selected);
  return next;
}

function cloneModel(model: XdtoPackageModel): XdtoPackageModel {
  return JSON.parse(JSON.stringify(model)) as XdtoPackageModel;
}

function cloneType(item: XdtoTypeDefinition): XdtoTypeDefinition {
  return JSON.parse(JSON.stringify(item)) as XdtoTypeDefinition;
}

function cloneProperty(item: XdtoProperty): XdtoProperty {
  return JSON.parse(JSON.stringify(item)) as XdtoProperty;
}

function cloneImport(item: XdtoImport): XdtoImport {
  return JSON.parse(JSON.stringify(item)) as XdtoImport;
}

function valueText(value: string | undefined): string {
  return value ?? '';
}

function statusForValues(left: string | undefined, right: string | undefined): CompareTreeStatus {
  const hasLeft = valueText(left) !== '';
  const hasRight = valueText(right) !== '';
  if (hasLeft && !hasRight) {
    return 'leftOnly';
  }
  if (!hasLeft && hasRight) {
    return 'rightOnly';
  }
  return valueText(left) === valueText(right) ? 'equal' : 'changed';
}

function compareScalarNode(
  id: string,
  label: string,
  kind: string,
  left: string | undefined,
  right: string | undefined
): CompareTreeNode {
  const status = statusForValues(left, right);
  return {
    id,
    label,
    kind,
    status,
    leftValue: valueText(left),
    rightValue: valueText(right),
    mergeable: status === 'changed' || status === 'rightOnly',
    children: [],
  };
}

function branchNode(id: string, label: string, kind: string, children: CompareTreeNode[]): CompareTreeNode {
  return {
    id,
    label,
    kind,
    status: summarizeChildren(children),
    children,
  };
}

function summarizeChildren(children: readonly CompareTreeNode[]): CompareTreeStatus {
  if (children.some((child) => child.status === 'changed' || child.status === 'leftOnly' || child.status === 'rightOnly')) {
    return 'changed';
  }
  return 'equal';
}

function compareImports(left: readonly XdtoImport[], right: readonly XdtoImport[]): CompareTreeNode {
  const keys = unionKeys(left.map(importKey), right.map(importKey));
  return branchNode('imports', 'Директивы импорта', 'importsGroup', keys.map((key) => {
    const leftItem = left.find((item) => importKey(item) === key);
    const rightItem = right.find((item) => importKey(item) === key);
    const label = rightItem?.namespace || rightItem?.schemaLocation || leftItem?.namespace || leftItem?.schemaLocation || 'Импорт';
    return collectionNode(`imports:${key}`, label, 'import', leftItem, rightItem, importSummary);
  }));
}

function compareTypes(
  section: TypeSection,
  label: string,
  left: readonly XdtoTypeDefinition[],
  right: readonly XdtoTypeDefinition[]
): CompareTreeNode {
  const keys = unionKeys(left.map((type) => type.name), right.map((type) => type.name));
  return branchNode(section, label, `${section}Group`, keys.map((name) => {
    const leftType = left.find((type) => type.name === name);
    const rightType = right.find((type) => type.name === name);
    if (!leftType || !rightType) {
      return collectionNode(`${section}:${name}`, name, section.slice(0, -1), leftType, rightType, typeSummary);
    }
    return branchNode(`${section}:${name}`, name, section.slice(0, -1), [
      compareScalarNode(`${section}:${name}:baseType`, 'Базовый тип', 'typeField', leftType.baseType, rightType.baseType),
    ]);
  }));
}

function compareObjectTypes(
  left: readonly XdtoTypeDefinition[],
  right: readonly XdtoTypeDefinition[]
): CompareTreeNode {
  const keys = unionKeys(left.map((type) => type.name), right.map((type) => type.name));
  return branchNode('objectTypes', 'Типы объектов', 'objectTypesGroup', keys.map((name) => {
    const leftType = left.find((type) => type.name === name);
    const rightType = right.find((type) => type.name === name);
    if (!leftType || !rightType) {
      return collectionNode(`objectTypes:${name}`, name, 'objectType', leftType, rightType, typeSummary);
    }
    return branchNode(`objectTypes:${name}`, name, 'objectType', [
      compareScalarNode(`objectTypes:${name}:baseType`, 'Базовый тип', 'typeField', leftType.baseType, rightType.baseType),
      compareProperties(`objectTypes:${name}:attributes`, 'Атрибуты', 'attributes', leftType.attributes, rightType.attributes),
      compareProperties(`objectTypes:${name}:properties`, 'Свойства', 'properties', leftType.properties, rightType.properties),
    ]);
  }));
}

function compareRootProperties(left: readonly XdtoProperty[], right: readonly XdtoProperty[]): CompareTreeNode {
  return compareProperties('rootProperties', 'Корневые свойства', 'rootProperties', left, right);
}

function compareProperties(
  id: string,
  label: string,
  section: PropertySection | 'rootProperties',
  left: readonly XdtoProperty[],
  right: readonly XdtoProperty[]
): CompareTreeNode {
  const keys = unionKeys(left.map((property) => property.name), right.map((property) => property.name));
  return branchNode(id, label, `${section}Group`, keys.map((name) => {
    const leftProperty = left.find((property) => property.name === name);
    const rightProperty = right.find((property) => property.name === name);
    if (!leftProperty || !rightProperty) {
      return collectionNode(`${id}:${name}`, name, 'property', leftProperty, rightProperty, propertySummary);
    }
    return branchNode(`${id}:${name}`, name, 'property', PROPERTY_FIELD_LABELS.map(([field, fieldLabel]) =>
      compareScalarNode(
        `${id}:${name}:${field}`,
        fieldLabel,
        'propertyField',
        propertyFieldValue(leftProperty, field),
        propertyFieldValue(rightProperty, field)
      )
    ));
  }));
}

function collectionNode<T>(
  id: string,
  label: string,
  kind: string,
  left: T | undefined,
  right: T | undefined,
  summary: (value: T) => string
): CompareTreeNode {
  const status: CompareTreeStatus = left && right ? 'equal' : left ? 'leftOnly' : 'rightOnly';
  return {
    id,
    label,
    kind,
    status,
    leftValue: left ? summary(left) : '',
    rightValue: right ? summary(right) : '',
    mergeable: Boolean(right && status !== 'equal'),
    children: [],
  };
}

function propertyFieldValue(property: XdtoProperty, field: PropertyField): string | undefined {
  return property[field];
}

function propertySummary(property: XdtoProperty): string {
  return property.type || property.ref || '';
}

function typeSummary(type: XdtoTypeDefinition): string {
  return type.baseType || `${type.attributes.length} атр., ${type.properties.length} св.`;
}

function importSummary(item: XdtoImport): string {
  return [item.namespace, item.schemaLocation].filter(Boolean).join(' ');
}

function importKey(item: XdtoImport): string {
  return encodeURIComponent(`${item.namespace ?? ''}|${item.schemaLocation ?? ''}`);
}

function unionKeys(left: readonly string[], right: readonly string[]): string[] {
  return Array.from(new Set([...left, ...right].filter((key) => key !== ''))).sort((a, b) => a.localeCompare(b));
}

function collectStats(root: CompareTreeNode): CompareTreeStats {
  const stats: CompareTreeStats = { total: 0, different: 0, mergeable: 0 };
  visit(root, (node) => {
    if (node.id !== root.id) {
      stats.total += 1;
    }
    if ((node.children.length === 0 || node.status === 'rightOnly' || node.status === 'leftOnly') && node.status !== 'equal') {
      stats.different += 1;
    }
    if (node.mergeable) {
      stats.mergeable += 1;
    }
  });
  return stats;
}

function visit(node: CompareTreeNode, callback: (node: CompareTreeNode) => void): void {
  callback(node);
  for (const child of node.children) {
    visit(child, callback);
  }
}

function applyImportsMerge(next: XdtoPackageModel, right: XdtoPackageModel, selected: ReadonlySet<string>): void {
  for (const rightImport of right.imports) {
    const id = `imports:${importKey(rightImport)}`;
    if (!selected.has(id) || next.imports.some((item) => importKey(item) === importKey(rightImport))) {
      continue;
    }
    next.imports.push(cloneImport(rightImport));
  }
}

function applyTypeMerge(
  target: XdtoTypeDefinition[],
  source: readonly XdtoTypeDefinition[],
  section: TypeSection,
  selected: ReadonlySet<string>
): void {
  for (const rightType of source) {
    const typeId = `${section}:${rightType.name}`;
    const targetIndex = target.findIndex((type) => type.name === rightType.name);
    if (selected.has(typeId)) {
      replaceOrPush(target, targetIndex, cloneType(rightType));
      continue;
    }
    if (targetIndex < 0) {
      continue;
    }
    const targetType = target[targetIndex];
    if (selected.has(`${typeId}:baseType`)) {
      targetType.baseType = rightType.baseType;
    }
    if (section === 'objectTypes') {
      applyPropertyMerge(targetType.attributes, rightType.attributes, `${typeId}:attributes`, selected);
      applyPropertyMerge(targetType.properties, rightType.properties, `${typeId}:properties`, selected);
    }
  }
}

function applyRootPropertiesMerge(
  next: XdtoPackageModel,
  right: XdtoPackageModel,
  selected: ReadonlySet<string>
): void {
  applyPropertyMerge(next.rootProperties, right.rootProperties, 'rootProperties', selected);
}

function applyPropertyMerge(
  target: XdtoProperty[],
  source: readonly XdtoProperty[],
  parentId: string,
  selected: ReadonlySet<string>
): void {
  for (const rightProperty of source) {
    const propertyId = `${parentId}:${rightProperty.name}`;
    const targetIndex = target.findIndex((property) => property.name === rightProperty.name);
    if (selected.has(propertyId)) {
      replaceOrPush(target, targetIndex, cloneProperty(rightProperty));
      continue;
    }
    if (targetIndex < 0) {
      continue;
    }
    const targetProperty = target[targetIndex];
    for (const [field] of PROPERTY_FIELD_LABELS) {
      if (selected.has(`${propertyId}:${field}`)) {
        targetProperty[field] = rightProperty[field];
      }
    }
  }
}

function replaceOrPush<T>(items: T[], index: number, value: T): void {
  if (index >= 0) {
    items.splice(index, 1, value);
  } else {
    items.push(value);
  }
}
