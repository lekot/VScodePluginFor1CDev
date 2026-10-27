import { XMLValidator } from 'fast-xml-parser';
import { METADATA_TYPE_DESCRIPTORS } from '../../constants/metadataTypeDescriptors';
import { XmlParser } from '../../parsers/xmlParser';
import { localName } from '../../parsers/xmlNavHelpers';

export interface ExtensionDependencyArtifact {
  readonly relativePath: string;
  readonly content: Buffer;
}

export interface ExtensionMetadataReference {
  readonly artifactPath: string;
  readonly qualifiedName: string;
  readonly metadataType: string;
  readonly objectName: string;
}

export interface ExtensionDependencyScanResult {
  readonly references: readonly ExtensionMetadataReference[];
  readonly errors: readonly { readonly artifactPath: string; readonly message: string }[];
}

const ROOT_TYPE_BY_TOKEN = buildRootTypeLookup();
const NON_REFERENCE_CONTAINERS = new Set(['comment', 'synonym', 'generatedtype', 'module', 'moduletext', 'script', 'scripttext', 'bsl']);

/** Finds only typed 1C metadata references in structured XML, never arbitrary text. */
export function scanExtensionXmlDependencies(
  artifacts: readonly ExtensionDependencyArtifact[],
): ExtensionDependencyScanResult {
  const references: ExtensionMetadataReference[] = [];
  const errors: Array<{ artifactPath: string; message: string }> = [];
  const seen = new Set<string>();

  for (const artifact of artifacts) {
    if (!artifact.relativePath.toLowerCase().endsWith('.xml')) {continue;}
    const xml = artifact.content.toString('utf8').replace(/^\uFEFF/u, '');
    const validation = XMLValidator.validate(xml);
    if (validation !== true) {
      errors.push({
        artifactPath: artifact.relativePath,
        message: `XML нельзя проверить на metadata dependencies: ${validation.err?.msg ?? 'malformed XML'}.`,
      });
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = XmlParser.parseString(xml);
    } catch (error) {
      errors.push({
        artifactPath: artifact.relativePath,
        message: `XML нельзя разобрать для проверки metadata dependencies: ${errorMessage(error)}.`,
      });
      continue;
    }

    const addReference = (token: string, syntax: 'cfg' | 'mdObjectRef' | 'designTimeRef'): void => {
      const value = token.trim();
      const dot = value.indexOf('.');
      if (dot <= 0 || dot === value.length - 1) {
        if (syntax !== 'cfg' || value.toLowerCase().startsWith('cfg:')) {
          errors.push({ artifactPath: artifact.relativePath, message: `Неизвестная XML metadata reference: ${value || '(empty)'}.` });
        }
        return;
      }

      let typeToken = value.slice(0, dot);
      if (syntax === 'cfg') {
        if (!typeToken.toLowerCase().startsWith('cfg:')) {return;}
        typeToken = typeToken.slice(4);
      }
      const metadataType = ROOT_TYPE_BY_TOKEN.get(typeToken.toLowerCase());
      const objectPath = value.slice(dot + 1).trim();
      const objectName = objectPath.split('.')[0]?.trim();
      if (!metadataType || !objectName || !isMetadataName(objectName)) {
        if (syntax !== 'cfg' || value.toLowerCase().startsWith('cfg:')) {
          errors.push({ artifactPath: artifact.relativePath, message: `XML metadata reference type or name is unsupported: ${value}.` });
        }
        return;
      }
      const qualifiedName = `${metadataType}.${objectName}`;
      const key = `${artifact.relativePath.toLowerCase()}\0${qualifiedName.toLowerCase()}`;
      if (seen.has(key)) {return;}
      seen.add(key);
      references.push({ artifactPath: artifact.relativePath, qualifiedName, metadataType, objectName });
    };

    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) {visit(entry);}
        return;
      }
      if (!isRecord(value)) {return;}
      for (const [key, child] of Object.entries(value)) {
        if (isAttributeKey(key) || key.startsWith('#') || key.startsWith('?')) {continue;}
        const elementName = localName(key);
        const excluded = NON_REFERENCE_CONTAINERS.has(elementName.toLowerCase());
        const items = Array.isArray(child) ? child : [child];
        for (const item of items) {
          if (!excluded) {
            if (elementName.toLowerCase() === 'type') {
              const text = directText(item);
              if (text) {addReference(text, 'cfg');}
            }
            const typedReference = isRecord(item) ? metadataObjectReferenceKind(item) : undefined;
            if (isRecord(item) && typedReference) {
              const text = directText(item);
              addReference(text ?? '', typedReference);
            }
            visit(item);
          }
        }
      }
    };
    visit(parsed);
  }

  return { references, errors };
}

function buildRootTypeLookup(): ReadonlyMap<string, string> {
  const lookup = new Map<string, string>();
  const knownTypeSuffixes = ['Object', 'Ref', 'Selection', 'List', 'Manager', 'Record', 'RecordSet', 'RecordManager', 'RecordSelection', 'RecordList'];
  for (const descriptor of METADATA_TYPE_DESCRIPTORS) {
    const rootType = descriptor.designerRootTag;
    lookup.set(rootType.toLowerCase(), rootType);
    for (const alias of descriptor.designerRootTagAliases ?? []) {lookup.set(alias.toLowerCase(), rootType);}
    if (descriptor.referenceKind) {lookup.set(descriptor.referenceKind.toLowerCase(), rootType);}
    for (const suffix of knownTypeSuffixes) {lookup.set(`${rootType}${suffix}`.toLowerCase(), rootType);}
  }
  return lookup;
}

function metadataObjectReferenceKind(value: Record<string, unknown>): 'mdObjectRef' | 'designTimeRef' | undefined {
  for (const [key, attributeValue] of Object.entries(value)) {
    if (!isAttributeKey(key)) {continue;}
    const attributeName = key.startsWith('@_') ? key.slice(2) : key.slice(1);
    if (localName(attributeName).toLowerCase() !== 'type' || typeof attributeValue !== 'string') {continue;}
    switch (localName(attributeValue.trim()).toLowerCase()) {
      case 'mdobjectref': return 'mdObjectRef';
      case 'designtimeref': return 'designTimeRef';
    }
  }
  return undefined;
}

function directText(value: unknown): string | undefined {
  if (typeof value === 'string') {return value.trim();}
  if (!isRecord(value)) {return undefined;}
  const textValues = Object.entries(value)
    .filter(([key]) => key === '#text')
    .map(([, text]) => text)
    .filter((text): text is string => typeof text === 'string')
    .map((text) => text.trim());
  return textValues.length === 1 ? textValues[0] : undefined;
}

function isMetadataName(value: string): boolean {
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(value);
}

function isAttributeKey(value: string): boolean {
  return value === ':@' || value.startsWith('@_');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
