import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getMetadataTypeDescriptorByRootTag, METADATA_TYPE_DESCRIPTORS } from '../../src/constants/metadataTypeDescriptors';
import { ROOT_TAGS_WITHOUT_INTERNALINFO, getExplicitGeneratedTypeSpecs } from '../../src/utils/xml/metadataGeneratedTypeSchema';
import { buildInternalInfoXml } from '../../src/utils/xml/internalInfoGenerator';

export type ExtensionCompareRootType = typeof METADATA_TYPE_DESCRIPTORS[number]['designerRootTag'];

export interface ExtensionCompareObjectFixture {
  type: ExtensionCompareRootType;
  name: string;
  uuid: string;
  belonging?: 'Own' | 'Adopted';
  anchorUuid?: string;
  propertiesXml?: string;
  childObjectsXml?: string;
  descriptorRootTag?: string;
  descriptorXml?: string;
}

export interface ExtensionCompareConfigurationFixture {
  version?: string;
  uuid?: string;
  name?: string;
  purpose?: 'AddOn' | 'Customization' | 'Patch' | string;
  namePrefix?: string;
  /** Override the default CFE root ownership marker; null omits the marker. */
  rootObjectBelonging?: string | null;
  rootPropertiesXml?: string;
  objects?: readonly ExtensionCompareObjectFixture[];
  registrations?: readonly { type: ExtensionCompareRootType; name: string; rootTag?: string }[];
}

export async function createExtensionCompareTempRoot(prefix = 'issue336-compare-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeDesignerConfiguration(
  rootPath: string,
  fixture: ExtensionCompareConfigurationFixture = {},
): Promise<void> {
  const version = fixture.version ?? '2.20';
  const registrations: readonly { type: ExtensionCompareRootType; name: string; rootTag?: string }[] = fixture.registrations
    ?? (fixture.objects ?? []).map(({ type, name }) => ({ type, name }));
  const extensionProperties = [
    fixture.name === undefined ? '' : `<Name>${xmlEscape(fixture.name)}</Name>`,
    fixture.rootObjectBelonging === null
      ? ''
      : fixture.rootObjectBelonging === undefined && fixture.purpose === undefined
        ? ''
        : `<ObjectBelonging>${xmlEscape(fixture.rootObjectBelonging ?? 'Adopted')}</ObjectBelonging>`,
    fixture.purpose === undefined
      ? ''
      : `<ConfigurationExtensionPurpose>${xmlEscape(fixture.purpose)}</ConfigurationExtensionPurpose>`,
    fixture.namePrefix === undefined ? '' : `<NamePrefix>${xmlEscape(fixture.namePrefix)}</NamePrefix>`,
  ].join('');
  const registrationXml = registrations
    .map(({ type, name, rootTag }) => {
      const canonicalType = getMetadataTypeDescriptorByRootTag(type)?.designerRootTag;
      if (!canonicalType) {
        throw new Error(`Unknown extension compare fixture root type: ${type}`);
      }
      const registrationTag = rootTag ?? canonicalType;
      return `<${registrationTag}>${xmlEscape(name)}</${registrationTag}>`;
    })
    .join('');
  const rootUuid = fixture.uuid ?? '11111111-1111-4111-8111-111111111111';
  const configurationXml = `<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject version="${xmlEscape(version)}"><Configuration uuid="${xmlEscape(rootUuid)}"><Properties>${extensionProperties}${fixture.rootPropertiesXml ?? ''}</Properties><ChildObjects>${registrationXml}</ChildObjects></Configuration></MetaDataObject>`;

  await fs.mkdir(rootPath, { recursive: true });
  await fs.writeFile(path.join(rootPath, 'Configuration.xml'), configurationXml, 'utf8');

  for (const object of fixture.objects ?? []) {
    await writeMetadataObject(rootPath, object, version);
  }
}

export async function writeMetadataObject(
  rootPath: string,
  fixture: ExtensionCompareObjectFixture,
  version = '2.20',
): Promise<string> {
  const descriptor = getMetadataTypeDescriptorByRootTag(fixture.type);
  if (!descriptor) {
    throw new Error(`Unknown extension compare fixture root type: ${fixture.type}`);
  }
  const folder = descriptor.designerFolder;
  const descriptorPath = path.join(rootPath, folder, `${fixture.name}.xml`);
  await fs.mkdir(path.dirname(descriptorPath), { recursive: true });
  const xml = fixture.descriptorXml ?? metadataObjectXml(fixture, version);
  await fs.writeFile(descriptorPath, xml, 'utf8');
  return descriptorPath;
}

export async function writeCompareBytes(
  rootPath: string,
  relativePath: string,
  content: string | Uint8Array,
): Promise<string> {
  const targetPath = path.join(rootPath, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content);
  return targetPath;
}

export function metadataObjectXml(
  fixture: ExtensionCompareObjectFixture,
  version = '2.20',
): string {
  const descriptor = getMetadataTypeDescriptorByRootTag(fixture.type);
  if (!descriptor) {
    throw new Error(`Unknown extension compare fixture root type: ${fixture.type}`);
  }
  const rootTag = fixture.descriptorRootTag ?? descriptor.designerRootTag;
  const internalInfo = !ROOT_TAGS_WITHOUT_INTERNALINFO.has(descriptor.designerRootTag)
    && getExplicitGeneratedTypeSpecs(descriptor.designerRootTag) !== undefined
    ? buildInternalInfoXml(descriptor.designerRootTag, fixture.name, '')
    : '';
  const belonging = fixture.belonging === undefined || fixture.belonging === 'Own'
    ? ''
    : `<ObjectBelonging>${fixture.belonging}</ObjectBelonging>`;
  const anchor = fixture.anchorUuid === undefined
    ? ''
    : `<ExtendedConfigurationObject>${fixture.anchorUuid}</ExtendedConfigurationObject>`;
  const properties = `${belonging}<Name>${xmlEscape(fixture.name)}</Name>${anchor}${fixture.propertiesXml ?? ''}`;
  const children = fixture.childObjectsXml === undefined
    ? descriptor.structure.hasChildObjects
      ? '<ChildObjects/>'
      : ''
    : `<ChildObjects>${fixture.childObjectsXml}</ChildObjects>`;

  const namespaceAttributes = internalInfo ? ' xmlns:xr="http://v8.1c.ru/8.3/xcf/readable"' : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject${namespaceAttributes} version="${xmlEscape(version)}"><${rootTag} uuid="${xmlEscape(fixture.uuid)}">${internalInfo}<Properties>${properties}</Properties>${children}</${rootTag}></MetaDataObject>`;
}

export async function readUtf8(rootPath: string, relativePath: string): Promise<string> {
  return fs.readFile(path.join(rootPath, relativePath), 'utf8');
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}
