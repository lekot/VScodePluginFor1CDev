import { localName } from '../../parsers/xmlNavHelpers';

export interface ExtensionKnownRootPropertyReference {
  readonly artifactPath: string;
  readonly qualifiedName: string;
  readonly metadataType: string;
  readonly objectName: string;
}

export interface ExtensionKnownRootPropertyScanResult {
  readonly references: readonly ExtensionKnownRootPropertyReference[];
  readonly errors: readonly { readonly artifactPath: string; readonly message: string }[];
}

interface RootPropertyReferenceSpec {
  readonly rootType: string;
  readonly propertyName: string;
  readonly referenceType: string;
  readonly optional: boolean;
}

const ROOT_PROPERTY_REFERENCES: readonly RootPropertyReferenceSpec[] = [
  { rootType: 'AccountingRegister', propertyName: 'ChartOfAccounts', referenceType: 'ChartOfAccounts', optional: false },
  { rootType: 'CalculationRegister', propertyName: 'ChartOfCalculationTypes', referenceType: 'ChartOfCalculationTypes', optional: false },
  { rootType: 'ChartOfAccounts', propertyName: 'ExtDimensionTypes', referenceType: 'ChartOfCharacteristicTypes', optional: true },
];

/** Reads the few untyped references stored as direct properties of known 1C root descriptors. */
export function scanKnownRootPropertyReferences(
  parsedXml: Readonly<Record<string, unknown>>,
  artifactPath: string,
): ExtensionKnownRootPropertyScanResult {
  const references: ExtensionKnownRootPropertyReference[] = [];
  const errors: Array<{ artifactPath: string; message: string }> = [];
  const metadataObjects = directChildValues(parsedXml, 'MetaDataObject');
  if (metadataObjects.length !== 1 || !isRecord(metadataObjects[0])) {
    return { references, errors };
  }

  const metadataObject = metadataObjects[0];
  for (const spec of ROOT_PROPERTY_REFERENCES) {
    const roots = directChildValues(metadataObject, spec.rootType);
    if (roots.length === 0) {continue;}
    if (roots.length !== 1 || !isRecord(roots[0])) {
      errors.push({
        artifactPath,
        message: `MetaDataObject должен содержать единственный прямой элемент ${spec.rootType} для проверки ${spec.propertyName}.`,
      });
      continue;
    }

    const propertiesSections = directChildValues(roots[0], 'Properties');
    if (propertiesSections.length !== 1 || !isRecord(propertiesSections[0])) {
      errors.push({
        artifactPath,
        message: `${spec.rootType} должен содержать единственный прямой Properties для проверки ${spec.propertyName}.`,
      });
      continue;
    }

    const propertyValues = directChildValues(propertiesSections[0], spec.propertyName);
    if (propertyValues.length === 0) {continue;}
    if (propertyValues.length !== 1) {
      errors.push({
        artifactPath,
        message: `${spec.rootType}/Properties/${spec.propertyName} должен встречаться ровно один раз.`,
      });
      continue;
    }

    const rawValue = directText(propertyValues[0]);
    if (rawValue === undefined) {
      errors.push({
        artifactPath,
        message: `${spec.rootType}/Properties/${spec.propertyName} должен содержать только прямой текст metadata reference.`,
      });
      continue;
    }
    if (rawValue === '') {
      if (!spec.optional) {
        errors.push({
          artifactPath,
          message: `${spec.rootType}/Properties/${spec.propertyName} не может быть пустым metadata reference.`,
        });
      }
      continue;
    }

    const reference = parseReference(rawValue, spec.referenceType);
    if (!reference) {
      errors.push({
        artifactPath,
        message: `${spec.rootType}/Properties/${spec.propertyName} содержит неподдерживаемую metadata reference: ${rawValue}.`,
      });
      continue;
    }
    references.push({
      artifactPath,
      qualifiedName: `${reference.metadataType}.${reference.objectName}`,
      metadataType: reference.metadataType,
      objectName: reference.objectName,
    });
  }

  return { references, errors };
}

function parseReference(value: string, expectedType: string): { readonly metadataType: string; readonly objectName: string } | undefined {
  const dot = value.indexOf('.');
  if (dot <= 0 || dot !== value.lastIndexOf('.') || dot === value.length - 1) {return undefined;}
  const metadataType = value.slice(0, dot).trim();
  const objectName = value.slice(dot + 1).trim();
  if (metadataType !== expectedType || !isMetadataName(objectName)) {return undefined;}
  return { metadataType, objectName };
}

function directChildValues(value: Record<string, unknown>, name: string): unknown[] {
  return Object.entries(value)
    .filter(([key]) => !isNonElementKey(key) && localName(key).toLowerCase() === name.toLowerCase())
    .flatMap(([, child]) => Array.isArray(child) ? child : [child]);
}

function directText(value: unknown): string | undefined {
  if (typeof value === 'string') {return value.trim();}
  if (!isRecord(value)) {return undefined;}
  const childElements = Object.keys(value).filter((key) => !isNonElementKey(key));
  if (childElements.length > 0) {return undefined;}
  const texts = Object.entries(value)
    .filter(([key]) => key === '#text')
    .map(([, text]) => text)
    .filter((text): text is string => typeof text === 'string');
  return texts.length === 1 ? texts[0]!.trim() : undefined;
}

function isMetadataName(value: string): boolean {
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(value);
}

function isNonElementKey(key: string): boolean {
  return key === ':@' || key === '@_' || key.startsWith('@_') || key.startsWith('#') || key.startsWith('?');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
