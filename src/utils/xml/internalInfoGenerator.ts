import { XMLWriter } from '../XMLWriter';
import { getExplicitGeneratedTypeSpecs, ROOT_TAGS_WITHOUT_INTERNALINFO } from './metadataGeneratedTypeSchema';
import type { GeneratedTypeSpec } from './metadataGeneratedTypeSchema';
export { getExplicitGeneratedTypeSpecs, ROOT_TAGS_WITHOUT_INTERNALINFO } from './metadataGeneratedTypeSchema';
export type { GeneratedTypeSpec } from './metadataGeneratedTypeSchema';

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

function getSpecsForRootTag(rootTag: string): readonly GeneratedTypeSpec[] {
  return getExplicitGeneratedTypeSpecs(rootTag) ?? [{ namePrefix: `${rootTag}Manager`, category: 'Manager' }];
}

export function buildInternalInfoXml(rootTag: string, objectName: string, baseIndent: string): string {
  const { lineIndent, childIndent } = indentOf(baseIndent);
  const specs = getSpecsForRootTag(rootTag);
  let xml = `${lineIndent}<InternalInfo>\n`;
  if (rootTag === 'ExchangePlan') {
    xml += `${childIndent}<xr:ThisNode>${XMLWriter.generateSimpleUuid()}</xr:ThisNode>\n`;
  }
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
  if (ROOT_TAGS_WITHOUT_INTERNALINFO.has(rootTag)) {
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

