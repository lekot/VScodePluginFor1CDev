import { XMLWriter } from '../utils/XMLWriter';

type GeneratedTypeSpec = {
  /** e.g. "CatalogObject", "InformationRegisterRecord" */
  namePrefix: string;
  /** e.g. "Object", "RecordSet", "ValueKey" */
  category: string;
};

function indentOf(s: string): { lineIndent: string; childIndent: string } {
  // Prefer to keep whatever indentation caller uses (tabs/spaces),
  // but for nested lines we always add one tab (Designer XML from 1C uses tabs).
  return { lineIndent: s, childIndent: `${s}\t` };
}

function makeGeneratedType(spec: GeneratedTypeSpec, objectName: string, indent: string): string {
  const typeId = XMLWriter.generateSimpleUuid();
  const valueId = XMLWriter.generateSimpleUuid();
  return (
    `${indent}<xr:GeneratedType name="${spec.namePrefix}.${objectName}" category="${spec.category}">\n` +
    `${indent}\t<xr:TypeId>${typeId}</xr:TypeId>\n` +
    `${indent}\t<xr:ValueId>${valueId}</xr:ValueId>\n` +
    `${indent}</xr:GeneratedType>\n`
  );
}

function getSpecsForRootTag(rootTag: string): GeneratedTypeSpec[] {
  // Patterns derived from `FormatSamples/ut_demo_ForFormat` exports.
  switch (rootTag) {
    case 'Catalog':
    case 'Document':
    case 'Task':
      return [
        { namePrefix: `${rootTag}Object`, category: 'Object' },
        { namePrefix: `${rootTag}Ref`, category: 'Ref' },
        { namePrefix: `${rootTag}Selection`, category: 'Selection' },
        { namePrefix: `${rootTag}List`, category: 'List' },
        { namePrefix: `${rootTag}Manager`, category: 'Manager' },
      ];
    case 'BusinessProcess':
      return [
        { namePrefix: 'BusinessProcessObject', category: 'Object' },
        { namePrefix: 'BusinessProcessRef', category: 'Ref' },
        { namePrefix: 'BusinessProcessSelection', category: 'Selection' },
        { namePrefix: 'BusinessProcessList', category: 'List' },
        { namePrefix: 'BusinessProcessManager', category: 'Manager' },
        { namePrefix: 'BusinessProcessRoutePointRef', category: 'RoutePointRef' },
      ];
    case 'Enum':
      return [
        { namePrefix: 'EnumRef', category: 'Ref' },
        { namePrefix: 'EnumManager', category: 'Manager' },
        { namePrefix: 'EnumList', category: 'List' },
      ];
    case 'Report':
      return [
        { namePrefix: 'ReportObject', category: 'Object' },
        { namePrefix: 'ReportManager', category: 'Manager' },
      ];
    case 'DataProcessor':
      return [
        { namePrefix: 'DataProcessorObject', category: 'Object' },
        { namePrefix: 'DataProcessorManager', category: 'Manager' },
      ];
    case 'Constant':
      return [
        { namePrefix: 'ConstantManager', category: 'Manager' },
        { namePrefix: 'ConstantValueManager', category: 'ValueManager' },
        { namePrefix: 'ConstantValueKey', category: 'ValueKey' },
      ];
    case 'InformationRegister':
      return [
        { namePrefix: 'InformationRegisterRecord', category: 'Record' },
        { namePrefix: 'InformationRegisterManager', category: 'Manager' },
        { namePrefix: 'InformationRegisterSelection', category: 'Selection' },
        { namePrefix: 'InformationRegisterList', category: 'List' },
        { namePrefix: 'InformationRegisterRecordSet', category: 'RecordSet' },
        { namePrefix: 'InformationRegisterRecordKey', category: 'RecordKey' },
        { namePrefix: 'InformationRegisterRecordManager', category: 'RecordManager' },
      ];
    case 'AccumulationRegister':
    case 'AccountingRegister':
    case 'CalculationRegister':
      return [
        { namePrefix: `${rootTag}Record`, category: 'Record' },
        { namePrefix: `${rootTag}Manager`, category: 'Manager' },
        { namePrefix: `${rootTag}Selection`, category: 'Selection' },
        { namePrefix: `${rootTag}List`, category: 'List' },
        { namePrefix: `${rootTag}RecordSet`, category: 'RecordSet' },
        { namePrefix: `${rootTag}RecordKey`, category: 'RecordKey' },
      ];
    default:
      // Best-effort fallback: at least provide a Manager, which is commonly present.
      return [{ namePrefix: `${rootTag}Manager`, category: 'Manager' }];
  }
}

export function buildInternalInfoXml(rootTag: string, objectName: string, baseIndent: string): string {
  const { lineIndent, childIndent } = indentOf(baseIndent);
  const specs = getSpecsForRootTag(rootTag);
  let xml = `${lineIndent}<InternalInfo>\n`;
  for (const spec of specs) {
    xml += makeGeneratedType(spec, objectName, childIndent);
  }
  xml += `${lineIndent}</InternalInfo>\n`;
  return xml;
}

export function injectInternalInfoIntoMetadataXml(
  xml: string,
  rootTag: string,
  objectName: string
): string {
  // Role and CommonModule must not have InternalInfo (Configurator / EDT shape).
  if (rootTag === 'Role' || rootTag === 'CommonModule') {
    return xml;
  }
  if (xml.includes('<InternalInfo>')) {
    return xml;
  }

  // Insert right before <Properties> of the rootTag.
  const re = new RegExp(
    `(<${rootTag}\\b[^>]*>\\s*\\r?\\n)([\\t ]*)<Properties>`,
    'm'
  );
  const m = xml.match(re);
  if (!m) {return xml;}
  const indent = m[2] ?? '';
  const internalInfo = buildInternalInfoXml(rootTag, objectName, indent);
  return xml.replace(re, `$1${internalInfo}${indent}<Properties>`);
}

export function buildTabularSectionInternalInfoObject(
  rootTag: string,
  parentObjectName: string,
  sectionName: string
): Record<string, unknown> {
  const sectionTypePrefix = `${rootTag}TabularSection`;
  const rowTypePrefix = `${rootTag}TabularSectionRow`;
  const generatedBase = `${parentObjectName}.${sectionName}`;

  const makeType = (namePrefix: string, category: string): Record<string, unknown> => ({
    '@_name': `${namePrefix}.${generatedBase}`,
    '@_category': category,
    'xr:TypeId': [{ '#text': XMLWriter.generateSimpleUuid() }],
    'xr:ValueId': [{ '#text': XMLWriter.generateSimpleUuid() }],
  });

  return {
    'xr:GeneratedType': [
      makeType(sectionTypePrefix, 'TabularSection'),
      makeType(rowTypePrefix, 'TabularSectionRow'),
    ],
  };
}

