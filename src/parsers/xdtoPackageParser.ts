import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type {
  XdtoDiagnostic,
  XdtoImport,
  XdtoFacet,
  XdtoPackageModel,
  XdtoProperty,
  XdtoRawNode,
  XdtoTypeDefinition,
  XdtoUnknownNode,
} from '../types/xdtoPackage';
import { localName } from './xmlNavHelpers';

const XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  ignoreDeclaration: false,
  removeNSPrefix: false,
};

const parser = new XMLParser(XML_OPTIONS);

const ROOT_KNOWN_CHILDREN = new Set([
  'annotation',
  'complexType',
  'element',
  'import',
  'include',
  'objectType',
  'property',
  'simpleType',
  'valueType',
]);

const VALUE_TYPE_KNOWN_CHILDREN = new Set([
  'annotation',
  'enumeration',
  'restriction',
  'pattern',
  'union',
  'list',
]);

const OBJECT_TYPE_KNOWN_CHILDREN = new Set([
  'all',
  'annotation',
  'attribute',
  'choice',
  'complexContent',
  'element',
  'extension',
  'property',
  'sequence',
  'simpleContent',
]);

const PROPERTY_KNOWN_CHILDREN = new Set([
  'annotation',
  'complexType',
  'simpleType',
]);

const VALUE_TYPE_ATTRIBUTE_FACETS = [
  'length',
  'minLength',
  'maxLength',
  'pattern',
  'enumeration',
  'maxInclusive',
  'maxExclusive',
  'minInclusive',
  'minExclusive',
  'totalDigits',
  'fractionDigits',
  'whiteSpace',
] as const;

const FACET_CHILDREN = new Set<string>(VALUE_TYPE_ATTRIBUTE_FACETS);

function emptyModel(diagnostics: XdtoDiagnostic[] = []): XdtoPackageModel {
  return {
    imports: [],
    valueTypes: [],
    objectTypes: [],
    rootProperties: [],
    diagnostics,
    unknownNodes: [],
  };
}

function isRecord(value: unknown): value is XdtoRawNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function getAttribute(node: XdtoRawNode, attributeName: string): string | undefined {
  const direct = node[`@_${attributeName}`];
  if (typeof direct === 'string') {
    return direct;
  }

  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith('@_')) {
      continue;
    }
    const rawName = key.slice(2);
    if (localName(rawName) === attributeName && typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

function childEntries(node: XdtoRawNode): Array<[string, unknown]> {
  return Object.entries(node).filter(([key]) => !key.startsWith('@_') && !key.startsWith('#'));
}

function childrenByLocalName(node: XdtoRawNode, name: string): unknown[] {
  const result: unknown[] = [];
  for (const [key, value] of childEntries(node)) {
    if (localName(key) === name) {
      result.push(...asArray(value));
    }
  }
  return result;
}

function firstRecordChild(node: XdtoRawNode, name: string): XdtoRawNode | undefined {
  return childrenByLocalName(node, name).find(isRecord);
}

function collectUnknownNodes(node: XdtoRawNode, knownLocalNames: ReadonlySet<string>): XdtoUnknownNode[] {
  const result: XdtoUnknownNode[] = [];
  for (const [name, value] of childEntries(node)) {
    const nodeLocalName = localName(name);
    if (knownLocalNames.has(nodeLocalName)) {
      continue;
    }
    for (const raw of asArray(value)) {
      result.push({ name, localName: nodeLocalName, raw });
    }
  }
  return result;
}

function parseImport(raw: unknown): XdtoImport | null {
  if (!isRecord(raw)) {
    return null;
  }
  return {
    namespace: getAttribute(raw, 'namespace'),
    schemaLocation: getAttribute(raw, 'schemaLocation'),
    raw,
  };
}

function parseProperty(raw: unknown): XdtoProperty | null {
  if (!isRecord(raw)) {
    return null;
  }

  const name = getAttribute(raw, 'name');
  if (!name) {
    return null;
  }

  return {
    name,
    type: getAttribute(raw, 'type'),
    ref: getAttribute(raw, 'ref'),
    namespaceURI: getAttribute(raw, 'namespaceURI'),
    localName: getAttribute(raw, 'localName'),
    qualified: getAttribute(raw, 'qualified'),
    nillable: getAttribute(raw, 'nillable'),
    fixed: getAttribute(raw, 'fixed'),
    defaultValue: getAttribute(raw, 'default'),
    minOccurs: getAttribute(raw, 'minOccurs'),
    maxOccurs: getAttribute(raw, 'maxOccurs'),
    lowerBound: getAttribute(raw, 'lowerBound'),
    upperBound: getAttribute(raw, 'upperBound'),
    form: getAttribute(raw, 'form'),
    use: getAttribute(raw, 'use'),
    raw,
    unknownNodes: collectUnknownNodes(raw, PROPERTY_KNOWN_CHILDREN),
  };
}

function isAttributeProperty(property: XdtoProperty): boolean {
  return property.form?.toLowerCase() === 'attribute';
}

function collectMemberContainers(node: XdtoRawNode): XdtoRawNode[] {
  const containers: XdtoRawNode[] = [node];
  const complexContent = firstRecordChild(node, 'complexContent');
  const simpleContent = firstRecordChild(node, 'simpleContent');
  for (const content of [complexContent, simpleContent]) {
    if (!content) {
      continue;
    }
    const extension = firstRecordChild(content, 'extension');
    const restriction = firstRecordChild(content, 'restriction');
    for (const derived of [extension, restriction]) {
      if (derived) {
        containers.push(derived);
      }
    }
  }
  return containers;
}

function collectProperties(node: XdtoRawNode): XdtoProperty[] {
  const rawProperties: unknown[] = [];

  for (const container of collectMemberContainers(node)) {
    rawProperties.push(...childrenByLocalName(container, 'property'));
    rawProperties.push(...childrenByLocalName(container, 'element'));

    for (const groupName of ['sequence', 'choice', 'all']) {
      for (const group of childrenByLocalName(container, groupName)) {
        if (isRecord(group)) {
          rawProperties.push(...childrenByLocalName(group, 'element'));
          rawProperties.push(...childrenByLocalName(group, 'property'));
        }
      }
    }
  }

  return rawProperties
    .map(parseProperty)
    .filter((property): property is XdtoProperty => property !== null && !isAttributeProperty(property));
}

function collectAttributes(node: XdtoRawNode): XdtoProperty[] {
  const rawAttributeNodes: unknown[] = [];
  const rawAttributeProperties: unknown[] = [];
  for (const container of collectMemberContainers(node)) {
    rawAttributeNodes.push(...childrenByLocalName(container, 'attribute'));
    rawAttributeProperties.push(...childrenByLocalName(container, 'property'));
  }

  const attributes = rawAttributeNodes
    .map(parseProperty)
    .filter((attribute): attribute is XdtoProperty => attribute !== null);
  const propertiesAsAttributes = rawAttributeProperties
    .map(parseProperty)
    .filter((attribute): attribute is XdtoProperty => attribute !== null && isAttributeProperty(attribute));
  return [...attributes, ...propertiesAsAttributes];
}

function parseBaseType(node: XdtoRawNode): string | undefined {
  const directBase = getAttribute(node, 'base');
  if (directBase) {
    return directBase;
  }

  const restriction = firstRecordChild(node, 'restriction');
  if (restriction) {
    return getAttribute(restriction, 'base');
  }

  const complexContent = firstRecordChild(node, 'complexContent');
  const simpleContent = firstRecordChild(node, 'simpleContent');
  const content = complexContent ?? simpleContent;
  if (!content) {
    return undefined;
  }

  const extension = firstRecordChild(content, 'extension');
  return extension ? getAttribute(extension, 'base') : undefined;
}

function parseFacetNode(name: string, raw: unknown): XdtoFacet | null {
  if (!isRecord(raw)) {
    return typeof raw === 'string' ? { name, value: raw, raw: { '#text': raw } } : null;
  }
  const value = getAttribute(raw, 'value');
  const text = typeof raw['#text'] === 'string' ? raw['#text'] : undefined;
  const facetValue = value ?? text;
  return facetValue === undefined ? null : { name, value: facetValue, raw };
}

function collectValueFacets(node: XdtoRawNode): XdtoFacet[] {
  const result: XdtoFacet[] = [];

  for (const facetName of VALUE_TYPE_ATTRIBUTE_FACETS) {
    const value = getAttribute(node, facetName);
    if (value !== undefined) {
      result.push({ name: facetName, value, raw: { [`@_${facetName}`]: value } });
    }
  }

  const containers = [node];
  const restriction = firstRecordChild(node, 'restriction');
  if (restriction) {
    containers.push(restriction);
  }

  for (const container of containers) {
    for (const [key, value] of childEntries(container)) {
      const facetName = localName(key);
      if (!FACET_CHILDREN.has(facetName)) {
        continue;
      }
      result.push(
        ...asArray(value)
          .map((raw) => parseFacetNode(facetName, raw))
          .filter((facet): facet is XdtoFacet => facet !== null)
      );
    }
  }

  return result;
}

function parseTypeDefinition(
  raw: unknown,
  knownChildren: ReadonlySet<string>,
  includeMembers: boolean
): XdtoTypeDefinition | null {
  if (!isRecord(raw)) {
    return null;
  }

  const name = getAttribute(raw, 'name');
  if (!name) {
    return null;
  }

  return {
    name,
    baseType: parseBaseType(raw),
    variety: getAttribute(raw, 'variety'),
    facets: collectValueFacets(raw),
    properties: includeMembers ? collectProperties(raw) : [],
    attributes: includeMembers ? collectAttributes(raw) : [],
    raw,
    unknownNodes: collectUnknownNodes(raw, knownChildren),
  };
}

function findRoot(parsed: XdtoRawNode): { name: string; root: XdtoRawNode } | null {
  for (const [name, value] of Object.entries(parsed)) {
    if (name === '?xml' || name.startsWith('#')) {
      continue;
    }
    if (isRecord(value)) {
      return { name, root: value };
    }
  }
  return null;
}

function resolvePackageRoot(rootInfo: { name: string; root: XdtoRawNode }): { name: string; root: XdtoRawNode } {
  if (localName(rootInfo.name) !== 'Model') {
    return rootInfo;
  }

  const packageRoot = firstRecordChild(rootInfo.root, 'package');
  return packageRoot ? { name: 'package', root: packageRoot } : rootInfo;
}

function parseValidXml(xmlText: string): XdtoPackageModel {
  const parsed = parser.parse(xmlText) as XdtoRawNode;
  const rootInfo = findRoot(parsed);
  if (!rootInfo) {
    return emptyModel([
      {
        severity: 'error',
        code: 'EMPTY_XML',
        message: 'XML does not contain a root element.',
      },
    ]);
  }

  const packageRootInfo = resolvePackageRoot(rootInfo);
  const root = packageRootInfo.root;
  const valueTypeNodes = [
    ...childrenByLocalName(root, 'simpleType'),
    ...childrenByLocalName(root, 'valueType'),
  ];
  const objectTypeNodes = [
    ...childrenByLocalName(root, 'complexType'),
    ...childrenByLocalName(root, 'objectType'),
  ];
  const rootPropertyNodes = [
    ...childrenByLocalName(root, 'element'),
    ...childrenByLocalName(root, 'property'),
  ];

  return {
    targetNamespace: getAttribute(root, 'targetNamespace'),
    imports: childrenByLocalName(root, 'import')
      .map(parseImport)
      .filter((item): item is XdtoImport => item !== null),
    valueTypes: valueTypeNodes
      .map((node) => parseTypeDefinition(node, VALUE_TYPE_KNOWN_CHILDREN, false))
      .filter((item): item is XdtoTypeDefinition => item !== null),
    objectTypes: objectTypeNodes
      .map((node) => parseTypeDefinition(node, OBJECT_TYPE_KNOWN_CHILDREN, true))
      .filter((item): item is XdtoTypeDefinition => item !== null),
    rootProperties: rootPropertyNodes
      .map(parseProperty)
      .filter((item): item is XdtoProperty => item !== null),
    diagnostics: [],
    rawRoot: root,
    unknownNodes: collectUnknownNodes(root, ROOT_KNOWN_CHILDREN),
  };
}

export function parseXdtoPackage(xmlText: string): XdtoPackageModel {
  if (xmlText.trim() === '') {
    return emptyModel([
      {
        severity: 'error',
        code: 'EMPTY_XML',
        message: 'XML text is empty.',
      },
    ]);
  }

  const validation = XMLValidator.validate(xmlText);
  if (validation !== true) {
    return emptyModel([
      {
        severity: 'error',
        code: 'MALFORMED_XML',
        message: validation.err.msg,
      },
    ]);
  }

  try {
    return parseValidXml(xmlText);
  } catch (error) {
    return emptyModel([
      {
        severity: 'error',
        code: 'MALFORMED_XML',
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }
}
