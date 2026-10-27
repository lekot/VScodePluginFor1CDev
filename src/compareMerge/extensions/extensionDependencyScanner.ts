import { XMLValidator } from 'fast-xml-parser';
import { METADATA_TYPE_DESCRIPTORS } from '../../constants/metadataTypeDescriptors';
import { getExplicitGeneratedTypeSpecs } from '../../utils/xml/metadataGeneratedTypeSchema';
import { XmlParser } from '../../parsers/xmlParser';
import { localName } from '../../parsers/xmlNavHelpers';
import { scanKnownRootPropertyReferences } from './extensionKnownRootPropertyReferences';

export interface ExtensionDependencyArtifact {
  readonly relativePath: string;
  readonly content: Buffer;
}

export interface ExtensionMetadataReference {
  readonly artifactPath: string;
  readonly qualifiedName: string;
  readonly metadataType: string;
  readonly objectName: string;
  readonly requiresCfeDeclaration?: true;
}

export interface ExtensionDependencyScanResult {
  readonly references: readonly ExtensionMetadataReference[];
  readonly errors: readonly { readonly artifactPath: string; readonly message: string }[];
}

const ROOT_TYPE_BY_TOKEN = buildRootTypeLookup();
const NON_REFERENCE_CONTAINERS = new Set(['comment', 'synonym', 'generatedtype', 'module', 'moduletext', 'script', 'scripttext', 'bsl']);
const ROLE_RIGHTS_XML_PATH = /^Roles\/[^/]+\/Ext\/Rights\.xml$/iu;

/** Finds only typed 1C metadata references in structured XML, never arbitrary text. */
export function scanExtensionXmlDependencies(
  artifacts: readonly ExtensionDependencyArtifact[],
): ExtensionDependencyScanResult {
  const references: ExtensionMetadataReference[] = [];
  const errors: Array<{ artifactPath: string; message: string }> = [];
  const referenceIndexes = new Map<string, number>();

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

    const appendReference = (metadataType: string, objectName: string, requiresCfeDeclaration = false): void => {
      const qualifiedName = `${metadataType}.${objectName}`;
      const key = `${artifact.relativePath.toLowerCase()}\0${qualifiedName.toLowerCase()}`;
      const existingIndex = referenceIndexes.get(key);
      if (existingIndex !== undefined) {
        if (requiresCfeDeclaration && !references[existingIndex]?.requiresCfeDeclaration) {
          references[existingIndex] = { ...references[existingIndex]!, requiresCfeDeclaration: true };
        }
        return;
      }
      referenceIndexes.set(key, references.length);
      references.push({
        artifactPath: artifact.relativePath,
        qualifiedName,
        metadataType,
        objectName,
        ...(requiresCfeDeclaration ? { requiresCfeDeclaration: true as const } : {}),
      });
    };

    const addReference = (token: string, syntax: 'cfg' | 'mdObjectRef' | 'designTimeRef' | 'rightsName'): void => {
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
      const isConfigurationRootReference = syntax === 'rightsName' && typeToken.toLowerCase() === 'configuration';
      const metadataType = isConfigurationRootReference
        ? 'Configuration'
        : ROOT_TYPE_BY_TOKEN.get(typeToken.toLowerCase());
      const objectPath = value.slice(dot + 1).trim();
      const objectName = objectPath.split('.')[0]?.trim();
      if (!metadataType || !objectName || !isMetadataName(objectName)
        || (isConfigurationRootReference && objectPath.includes('.'))) {
        if (syntax !== 'cfg' || value.toLowerCase().startsWith('cfg:')) {
          errors.push({ artifactPath: artifact.relativePath, message: `XML metadata reference type or name is unsupported: ${value}.` });
        }
        return;
      }
      appendReference(metadataType, objectName);
    };

    const knownRootReferences = scanKnownRootPropertyReferences(parsed, artifact.relativePath);
    errors.push(...knownRootReferences.errors);
    for (const reference of knownRootReferences.references) {
      appendReference(reference.metadataType, reference.objectName, reference.requiresCfeDeclaration === true);
    }

    if (ROLE_RIGHTS_XML_PATH.test(artifact.relativePath.replace(/\\/gu, '/'))) {
      scanRoleRightsXml(parsed, artifact.relativePath, (value) => addReference(value, 'rightsName'), errors);
    }

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
  for (const descriptor of METADATA_TYPE_DESCRIPTORS) {
    const rootType = descriptor.designerRootTag;
    lookup.set(rootType.toLowerCase(), rootType);
    for (const alias of descriptor.designerRootTagAliases ?? []) {lookup.set(alias.toLowerCase(), rootType);}
    if (descriptor.referenceKind) {lookup.set(descriptor.referenceKind.toLowerCase(), rootType);}
    for (const generatedType of getExplicitGeneratedTypeSpecs(rootType) ?? []) {
      lookup.set(generatedType.namePrefix.toLowerCase(), rootType);
    }
  }
  return lookup;
}

function scanRoleRightsXml(
  parsed: Record<string, unknown>,
  artifactPath: string,
  addReference: (value: string) => void,
  errors: Array<{ artifactPath: string; message: string }>,
): void {
  const roots = directChildren(parsed);
  if (roots.length !== 1 || localName(roots[0]![0]).toLowerCase() !== 'rights' || !isRecord(roots[0]![1])) {
    errors.push({ artifactPath, message: 'Rights.xml должен содержать единственный корневой элемент rights.' });
    return;
  }
  const rights = roots[0]![1] as Record<string, unknown>;
  for (const objectValue of directChildValues(rights, 'object')) {
    if (!isRecord(objectValue)) {
      errors.push({ artifactPath, message: 'Rights.xml содержит некорректный прямой элемент object.' });
      continue;
    }
    const names = directChildValues(objectValue, 'name');
    if (names.length !== 1) {
      errors.push({ artifactPath, message: 'Каждый прямой object в Rights.xml должен содержать единственный name.' });
      continue;
    }
    const name = directText(names[0]);
    if (name === undefined) {
      errors.push({ artifactPath, message: 'Прямой object/name в Rights.xml не содержит однозначный текст metadata reference.' });
      continue;
    }
    addReference(name);
  }
}

function directChildren(value: Record<string, unknown>): Array<readonly [string, unknown]> {
  return Object.entries(value).filter(([key]) => !isAttributeKey(key) && !key.startsWith('#') && !key.startsWith('?'));
}

function directChildValues(value: Record<string, unknown>, name: string): unknown[] {
  return directChildren(value)
    .filter(([key]) => localName(key).toLowerCase() === name.toLowerCase())
    .flatMap(([, child]) => Array.isArray(child) ? child : [child]);
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
