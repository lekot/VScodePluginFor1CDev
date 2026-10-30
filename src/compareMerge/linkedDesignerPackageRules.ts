import { elementChildren, parseXmlDocument, textContent } from './xml/xmlDom';
import { namespaceUriForName } from './adapters/semanticXml/semanticXmlIdentity';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';

export type LinkedDesignerPackageKind = 'Form' | 'Template' | 'Command';

const TEMPLATE_EXTENSIONS: Readonly<Record<string, string>> = {
  SpreadsheetDocument: 'xml',
  DataCompositionSchema: 'xml',
  HTMLDocument: 'html',
  TextDocument: 'txt',
  BinaryData: 'bin',
  ActiveDocument: 'xml',
};

/** Resolves the required body path from the actual Designer descriptor contract. */
export function requiredLinkedDesignerBodyPath(
  kind: LinkedDesignerPackageKind,
  descriptorRelativePath: string,
  descriptorContent: Buffer,
): string | undefined {
  const descriptorPath = descriptorRelativePath.replace(/\\/gu, '/');
  if (!/\.xml$/iu.test(descriptorPath)) {return undefined;}
  const packagePrefix = descriptorPath.slice(0, -'.xml'.length);
  if (kind === 'Form') {return `${packagePrefix}/Ext/Form.xml`;}
  if (kind === 'Command') {return `${packagePrefix}/Ext/CommandModule.bsl`;}

  const templateType = readTemplateType(descriptorContent);
  const extension = templateType ? TEMPLATE_EXTENSIONS[templateType] : undefined;
  return extension ? `${packagePrefix}/Ext/Template.${extension}` : undefined;
}

function readTemplateType(content: Buffer): string | undefined {
  try {
    const root = parseXmlDocument(content.toString('utf8')).root;
    if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MDCLASSES_NAMESPACE) {return undefined;}
    const templates = elementChildren(root).filter((element) =>
      (element.localName === 'Template' || element.localName === 'CommonTemplate') && namespaceUriForName(element) === MDCLASSES_NAMESPACE);
    if (templates.length !== 1) {return undefined;}
    const properties = elementChildren(templates[0]!).filter((element) => element.localName === 'Properties' && namespaceUriForName(element) === MDCLASSES_NAMESPACE);
    if (properties.length !== 1) {return undefined;}
    const values = elementChildren(properties[0]!).filter((element) => element.localName === 'TemplateType' && namespaceUriForName(element) === MDCLASSES_NAMESPACE);
    if (values.length !== 1) {return undefined;}
    return textContent(values[0]!).trim() || undefined;
  } catch {
    return undefined;
  }
}
