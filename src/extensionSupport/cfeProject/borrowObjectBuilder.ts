import type { CfeObjectIdentity } from './ownership';

interface GeneratedTypeDefinition {
  readonly prefix: string;
  readonly category: string;
}

export interface CfeBorrowTypeRule {
  readonly designerFolder: string;
  readonly generatedTypes: readonly GeneratedTypeDefinition[];
  readonly requiresChildObjects: boolean;
  readonly copiedBooleanProperties?: readonly string[];
}

/**
 * The supported shell rules are shared by the CFE command and semantic compare.
 * Adding a root type requires an explicit dependency and shell review.
 */
export const CFE_BORROW_TYPE_MATRIX: Readonly<Record<string, CfeBorrowTypeRule>> = Object.freeze({
  Catalog: Object.freeze({
    designerFolder: 'Catalogs',
    generatedTypes: Object.freeze([
      { prefix: 'CatalogObject', category: 'Object' },
      { prefix: 'CatalogRef', category: 'Ref' },
      { prefix: 'CatalogSelection', category: 'Selection' },
      { prefix: 'CatalogList', category: 'List' },
      { prefix: 'CatalogManager', category: 'Manager' },
    ]),
    requiresChildObjects: true,
  }),
  Document: Object.freeze({
    designerFolder: 'Documents',
    generatedTypes: Object.freeze([
      { prefix: 'DocumentObject', category: 'Object' },
      { prefix: 'DocumentRef', category: 'Ref' },
      { prefix: 'DocumentSelection', category: 'Selection' },
      { prefix: 'DocumentList', category: 'List' },
      { prefix: 'DocumentManager', category: 'Manager' },
    ]),
    requiresChildObjects: true,
  }),
  Enum: Object.freeze({
    designerFolder: 'Enums',
    generatedTypes: Object.freeze([
      { prefix: 'EnumRef', category: 'Ref' },
      { prefix: 'EnumManager', category: 'Manager' },
      { prefix: 'EnumList', category: 'List' },
    ]),
    requiresChildObjects: true,
  }),
  CommonModule: Object.freeze({
    designerFolder: 'CommonModules',
    generatedTypes: Object.freeze([]),
    requiresChildObjects: false,
    copiedBooleanProperties: Object.freeze([
      'Global',
      'ClientManagedApplication',
      'Server',
      'ExternalConnection',
      'ClientOrdinaryApplication',
      'ServerCall',
    ]),
  }),
});

export interface BorrowedObjectShellInput {
  readonly identity: Pick<CfeObjectIdentity, 'type' | 'name' | 'uuid'>;
  readonly formatVersion: string;
  readonly localUuid: string;
  readonly copiedProperties: Readonly<Record<string, string>>;
  readonly generatedTypeIds: readonly { readonly typeId: string; readonly valueId: string }[];
}

/** Builds only the adopted root shell; all UUIDs and copied values come from the caller. */
export function buildBorrowedObjectShell(input: BorrowedObjectShellInput): string {
  const { identity } = input;
  const rule = CFE_BORROW_TYPE_MATRIX[identity.type];
  if (!rule) {
    throw new Error(`Unsupported borrowed metadata type: ${identity.type}`);
  }
  if (input.generatedTypeIds.length !== rule.generatedTypes.length) {
    throw new Error(`Borrowed shell for ${identity.type} requires ${rule.generatedTypes.length} generated type identities.`);
  }

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<MetaDataObject ${xmlNamespaces(input.formatVersion)} version="${input.formatVersion}">`,
    `\t<${identity.type} uuid="${input.localUuid}">`,
  ];
  if (rule.generatedTypes.length === 0) {
    lines.push('\t\t<InternalInfo/>');
  } else {
    lines.push('\t\t<InternalInfo>');
    for (const [index, generatedType] of rule.generatedTypes.entries()) {
      const ids = input.generatedTypeIds[index]!;
      lines.push(`\t\t\t<xr:GeneratedType name="${generatedType.prefix}.${escapeXml(identity.name)}" category="${generatedType.category}">`);
      lines.push(`\t\t\t\t<xr:TypeId>${ids.typeId}</xr:TypeId>`);
      lines.push(`\t\t\t\t<xr:ValueId>${ids.valueId}</xr:ValueId>`);
      lines.push('\t\t\t</xr:GeneratedType>');
    }
    lines.push('\t\t</InternalInfo>');
  }
  lines.push('\t\t<Properties>');
  lines.push('\t\t\t<ObjectBelonging>Adopted</ObjectBelonging>');
  lines.push(`\t\t\t<Name>${escapeXml(identity.name)}</Name>`);
  lines.push('\t\t\t<Comment/>');
  lines.push(`\t\t\t<ExtendedConfigurationObject>${identity.uuid}</ExtendedConfigurationObject>`);
  for (const property of rule.copiedBooleanProperties ?? []) {
    const value = input.copiedProperties[property] ?? 'false';
    if (value !== 'true' && value !== 'false') {
      throw new Error(`Borrowed shell boolean property ${property} is invalid.`);
    }
    lines.push(`\t\t\t<${property}>${value}</${property}>`);
  }
  lines.push('\t\t</Properties>');
  if (rule.requiresChildObjects) {
    lines.push('\t\t<ChildObjects/>');
  }
  lines.push(`\t</${identity.type}>`);
  lines.push('</MetaDataObject>');
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function xmlNamespaces(formatVersion: string): string {
  const palette = formatVersion === '2.21' ? ' xmlns:pal="http://v8.1c.ru/8.1/data/ui/colors/palette"' : '';
  return `xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform"${palette} xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
