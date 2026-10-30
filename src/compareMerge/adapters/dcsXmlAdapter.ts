import * as path from 'path';

import type { AdapterCompareInput, AdapterCompareResult, MergeAdapter } from './mergeAdapter';
import type { XmlElementKindInput } from './semanticXml/semanticXmlAdapter';
import { buildXmlAdapterResult } from './semanticXml/semanticXmlAdapter';
import { namespaceUriForName } from './semanticXml/semanticXmlIdentity';
import { DCS_SCHEMA_NAMESPACE } from './semanticXml/semanticXmlDcs';
import type { XmlElement } from '../xml/xmlDom';

const DCS_CORE_NAMESPACE = 'http://v8.1c.ru/8.1/data/core';
const DCS_SETTINGS_NAMESPACE = 'http://v8.1c.ru/8.1/data-composition-system/settings';
const DCS_AREA_NAMESPACE = 'http://v8.1c.ru/8.1/data-composition-system/area-template';
const SCHEMA_STRUCTURES = new Set([
  'DataCompositionSchema', 'dataSource', 'dataSet', 'item', 'field', 'parameter', 'template', 'dataSetLink',
  'calculatedField', 'totalField', 'groupTemplate', 'groupHeaderTemplate', 'settingsVariant',
]);
const SCHEMA_VALUE_STRUCTURES = new Set(['title', 'valueType', 'value', 'useRestriction', 'role']);
const CORE_VALUE_STRUCTURES = new Set([
  'Type', 'StringQualifiers', 'NumberQualifiers', 'DateQualifiers', 'LocalStringType', 'item', 'lang', 'content',
  'SettingsParameterValue', 'ChoiceParameterLinks', 'value', 'parameter',
]);
const AREA_TEMPLATE_STRUCTURES = new Set([
  'template', 'parameter', 'item', 'tableCell', 'value', 'fieldExpression', 'field', 'expression',
]);
const DATASET_TYPES = new Set(['DataSetQuery', 'DataSetObject', 'DataSetUnion']);

export const dcsXmlAdapter: MergeAdapter = {
  kind: 'dcsXml',
  async compare(input: AdapterCompareInput): Promise<AdapterCompareResult> {
    const container = input.match.left?.containerPath ?? input.match.right?.containerPath ?? '';
    const filePath = path.join(container, 'Ext', 'Template.xml');
    return buildXmlAdapterResult(input, {
      adapterKind: 'dcsXml',
      rootLabel: 'Схема компоновки данных',
      rootKind: 'dcsXml',
      nodeIdPrefix: 'dcsXml',
      targetFilePath: input.artifactPaths?.left ?? filePath,
      sourceFilePath: input.artifactPaths?.right ?? (input.match.right ? path.join(input.match.right.containerPath, 'Ext', 'Template.xml') : undefined),
      semanticKind: 'dcsXml',
      elementKind: ({ element }) => {
        const name = localName(element.name);
        return name === 'dataSet' || name === 'item' ? 'dcsDataSet' : name === 'field' ? 'dcsField' : 'xmlElement';
      },
      knownComplexElement: isKnownDcsComplex,
    });
  },
};

function isKnownDcsComplex({ element, parent }: XmlElementKindInput): boolean {
  const name = localName(element.name);
  const namespace = namespaceUriForName(element.dom);
  const parentName = localName(parent?.name ?? '');
  if (namespace === DCS_SCHEMA_NAMESPACE && SCHEMA_STRUCTURES.has(name)) {
    if (name === 'DataCompositionSchema') {return parent === undefined;}
    if (['dataSource', 'dataSet', 'parameter', 'template', 'dataSetLink', 'calculatedField', 'totalField', 'groupTemplate', 'groupHeaderTemplate', 'settingsVariant'].includes(name)) {
      return parentName === 'DataCompositionSchema';
    }
    if (name === 'item') {
      return (parentName === 'dataSet' || parentName === 'item') && dataSetType(parent?.dom) === 'DataSetUnion';
    }
    if (name === 'field') {
      return (parentName === 'dataSet' && localName(parent?.parent?.name ?? '') === 'DataCompositionSchema') ||
        (parentName === 'item' && DATASET_TYPES.has(dataSetType(parent?.dom) ?? ''));
    }
  }
  if (namespace === DCS_SCHEMA_NAMESPACE && SCHEMA_VALUE_STRUCTURES.has(name)) {
    return ['dataSet', 'item', 'parameter', 'calculatedField', 'field'].includes(parentName);
  }
  if (namespace === DCS_CORE_NAMESPACE && CORE_VALUE_STRUCTURES.has(name)) {
    return true;
  }
  if (namespace === DCS_AREA_NAMESPACE && AREA_TEMPLATE_STRUCTURES.has(name)) {
    return true;
  }
  if (namespace === DCS_SETTINGS_NAMESPACE && ['settings', 'selection', 'filter', 'order', 'group', 'item'].includes(name)) {
    // Settings variants remain atomic/read-only until their repeated item grammar has stable selectors.
    return false;
  }
  return false;
}

function dataSetType(element: XmlElement | undefined): string | undefined {
  if (!element) {return undefined;}
  const xsi = 'http://www.w3.org/2001/XMLSchema-instance';
  const attributes = element.attributes.filter((attribute) => attribute.localName === 'type' &&
    namespaceUriForName(element, attribute.name, true) === xsi);
  if (attributes.length !== 1) {return undefined;}
  const value = attributes[0]!.value.trim();
  const separator = value.indexOf(':');
  const prefix = separator < 0 ? '' : value.slice(0, separator);
  const typeName = separator < 0 ? value : value.slice(separator + 1);
  if (!/^[\p{L}_][\p{L}\p{N}_.-]*$/u.test(typeName) || (separator >= 0 && !/^[\p{L}_][\p{L}\p{N}_.-]*$/u.test(prefix))) {return undefined;}
  const typeNamespace = namespaceUriForName(element, prefix, false);
  return typeNamespace === DCS_SCHEMA_NAMESPACE && DATASET_TYPES.has(typeName) ? typeName : undefined;
}

function localName(name: string): string {
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
}
