import { XMLValidator } from 'fast-xml-parser';
import { XmlParser } from '../../parsers/xmlParser';
import { localName } from '../../parsers/xmlNavHelpers';
import type { MergeFileWitness } from '../merge/mergePreview';

export interface ExtensionDocumentRegisterRecordsScanResult {
  readonly references: readonly string[];
  readonly inheritsRegisterRecords: boolean;
  readonly errors: readonly { readonly artifactPath: string; readonly message: string }[];
}

export interface RecorderRegisterRequirement {
  readonly qualifiedName: string;
  readonly metadataType: string;
  readonly isOwnFullCopy: boolean;
  readonly descriptorXml?: Buffer | string;
}

export interface RecorderDocumentVersion {
  readonly qualifiedName: string;
  readonly adoptedDocument: boolean;
  readonly registerRecords: ExtensionDocumentRegisterRecordsScanResult;
  readonly witnesses: readonly MergeFileWitness[];
}

export interface OwnRegisterRecorderPreflightInput {
  readonly registers: readonly RecorderRegisterRequirement[];
  readonly targetDocuments: readonly RecorderDocumentVersion[];
  readonly provenTargetBaseDocuments: readonly RecorderDocumentVersion[];
  readonly selectedDocumentOutputs: readonly RecorderDocumentVersion[];
}

export interface OwnRegisterRecorderPreflightResult {
  readonly blockers: readonly { readonly registerQualifiedName: string; readonly message: string }[];
  readonly witnessesByRegister: ReadonlyMap<string, readonly MergeFileWitness[]>;
}

const REGISTER_ROOT_TYPES = new Set([
  'AccumulationRegister',
  'InformationRegister',
  'AccountingRegister',
  'CalculationRegister',
]);

/** Reads RegisterRecords only from direct Document/Properties/ RegisterRecords/Item MDObjectRef nodes. */
export function scanDocumentRegisterRecords(input: {
  readonly artifactPath: string;
  readonly xml: Buffer | string;
  readonly adoptedDocument: boolean;
}): ExtensionDocumentRegisterRecordsScanResult {
  const references: string[] = [];
  const errors: Array<{ artifactPath: string; message: string }> = [];
  const xml = (Buffer.isBuffer(input.xml) ? input.xml.toString('utf8') : input.xml).replace(/^\uFEFF/u, '');
  const parsed = parseXml(xml, input.artifactPath, errors);
  if (!parsed) {
    return { references, inheritsRegisterRecords: false, errors };
  }

  const metaDataObjects = directChildValues(parsed, 'MetaDataObject');
  if (metaDataObjects.length !== 1 || !isRecord(metaDataObjects[0])) {
    errors.push({ artifactPath: input.artifactPath, message: 'Дескриптор Document должен содержать единственный MetaDataObject.' });
    return { references, inheritsRegisterRecords: false, errors };
  }
  const documents = directChildValues(metaDataObjects[0], 'Document');
  if (documents.length !== 1 || !isRecord(documents[0])) {
    errors.push({ artifactPath: input.artifactPath, message: 'MetaDataObject должен содержать единственный прямой Document.' });
    return { references, inheritsRegisterRecords: false, errors };
  }
  const properties = directChildValues(documents[0], 'Properties');
  if (properties.length !== 1 || !isRecord(properties[0])) {
    errors.push({ artifactPath: input.artifactPath, message: 'Document должен содержать единственный прямой Properties.' });
    return { references, inheritsRegisterRecords: false, errors };
  }

  const registerRecordsSections = directChildValues(properties[0], 'RegisterRecords');
  if (registerRecordsSections.length === 0) {
    return { references, inheritsRegisterRecords: input.adoptedDocument, errors };
  }
  if (registerRecordsSections.length !== 1) {
    errors.push({ artifactPath: input.artifactPath, message: 'Document/Properties/RegisterRecords должен встречаться не более одного раза и иметь корректную структуру.' });
    return { references, inheritsRegisterRecords: false, errors };
  }

  const section = registerRecordsSections[0];
  if (isRecord(section)) {
    for (const [itemName, itemValue] of directChildren(section)) {
      if (localName(itemName).toLowerCase() !== 'item') {continue;}
      if (!isRecord(itemValue)) {
        errors.push({ artifactPath: input.artifactPath, message: 'RegisterRecords содержит некорректный прямой xr:Item.' });
        continue;
      }
      if (metadataObjectReferenceType(itemValue) !== 'MDObjectRef') {continue;}
      const rawReference = directText(itemValue);
      const reference = rawReference === undefined ? undefined : parseRegisterReference(rawReference);
      if (!reference) {
        errors.push({
          artifactPath: input.artifactPath,
          message: `RegisterRecords содержит некорректную прямую ссылку регистра: ${rawReference ?? '(empty)'}.`,
        });
        continue;
      }
      if (!references.some((existing) => normalizeQualifiedName(existing) === normalizeQualifiedName(reference))) {
        references.push(reference);
      }
    }
  } else if (section !== '') {
    errors.push({ artifactPath: input.artifactPath, message: 'RegisterRecords должен содержать прямой список элементов.' });
  }

  return { references, inheritsRegisterRecords: false, errors };
}

/** Verifies recorder coverage for selected own full-copy registers using the final Document mapping. */
export function preflightOwnRegisterRecorders(
  input: OwnRegisterRecorderPreflightInput,
): OwnRegisterRecorderPreflightResult {
  const requirements = input.registers.filter(isRecorderRequiredRegister);
  if (requirements.length === 0) {
    return { blockers: [], witnessesByRegister: new Map() };
  }

  const baseMappings = new Map<string, EffectiveDocumentMapping>();
  for (const document of input.provenTargetBaseDocuments) {
    mergeMapping(baseMappings, document.qualifiedName, mappingFromVersion(document));
  }

  const effectiveDocuments = new Map<string, EffectiveDocumentMapping>(baseMappings);
  for (const document of input.targetDocuments) {
    effectiveDocuments.set(
      normalizeQualifiedName(document.qualifiedName),
      applyDocumentVersion(document, baseMappings.get(normalizeQualifiedName(document.qualifiedName))),
    );
  }
  for (const document of input.selectedDocumentOutputs) {
    effectiveDocuments.set(
      normalizeQualifiedName(document.qualifiedName),
      applyDocumentVersion(document, baseMappings.get(normalizeQualifiedName(document.qualifiedName))),
    );
  }

  const blockers: Array<{ registerQualifiedName: string; message: string }> = [];
  const witnessesByRegister = new Map<string, readonly MergeFileWitness[]>();
  for (const register of requirements) {
    const key = normalizeQualifiedName(register.qualifiedName);
    const witnesses = Array.from(effectiveDocuments.values())
      .flatMap((document) => document.witnessesByRegister.get(key) ?? []);
    if (witnesses.length === 0) {
      blockers.push({
        registerQualifiedName: register.qualifiedName,
        message: `Для переноса регистра ${register.qualifiedName} не найден документ-регистратор с прямой ссылкой в RegisterRecords. Выберите или перенесите такой Document.`,
      });
      continue;
    }
    witnessesByRegister.set(register.qualifiedName, dedupeWitnesses(witnesses));
  }

  return { blockers, witnessesByRegister };
}

function isRecorderRequiredRegister(register: RecorderRegisterRequirement): boolean {
  if (!register.isOwnFullCopy) {return false;}
  if (register.metadataType === 'AccumulationRegister'
    || register.metadataType === 'AccountingRegister'
    || register.metadataType === 'CalculationRegister') {
    return true;
  }
  return register.metadataType === 'InformationRegister'
    && readDirectInformationRegisterWriteMode(register.descriptorXml) === 'RecorderSubordinate';
}

function readDirectInformationRegisterWriteMode(xmlInput: Buffer | string | undefined): string | undefined {
  if (xmlInput === undefined) {return undefined;}
  const errors: Array<{ artifactPath: string; message: string }> = [];
  const xml = (Buffer.isBuffer(xmlInput) ? xmlInput.toString('utf8') : xmlInput).replace(/^\uFEFF/u, '');
  const parsed = parseXml(xml, 'InformationRegister.xml', errors);
  if (!parsed) {return undefined;}
  const metaDataObjects = directChildValues(parsed, 'MetaDataObject');
  if (metaDataObjects.length !== 1 || !isRecord(metaDataObjects[0])) {return undefined;}
  const registers = directChildValues(metaDataObjects[0], 'InformationRegister');
  if (registers.length !== 1 || !isRecord(registers[0])) {return undefined;}
  const properties = directChildValues(registers[0], 'Properties');
  if (properties.length !== 1 || !isRecord(properties[0])) {return undefined;}
  const writeModes = directChildValues(properties[0], 'WriteMode');
  return writeModes.length === 1 ? directText(writeModes[0]) : undefined;
}

interface EffectiveDocumentMapping {
  readonly witnessesByRegister: ReadonlyMap<string, readonly MergeFileWitness[]>;
}

function mappingFromVersion(document: RecorderDocumentVersion): EffectiveDocumentMapping {
  const mapping = new Map<string, MergeFileWitness[]>();
  if (document.registerRecords.errors.length > 0) {
    return { witnessesByRegister: mapping };
  }
  for (const reference of document.registerRecords.references) {
    const key = normalizeQualifiedName(reference);
    mergeWitnessList(mapping, key, document.witnesses);
  }
  return { witnessesByRegister: mapping };
}

function applyDocumentVersion(
  document: RecorderDocumentVersion,
  baseMapping: EffectiveDocumentMapping | undefined,
): EffectiveDocumentMapping {
  const next = new Map<string, MergeFileWitness[]>();
  if (document.registerRecords.errors.length > 0) {
    return { witnessesByRegister: next };
  }
  if (document.adoptedDocument && baseMapping) {
    for (const [key, witnesses] of baseMapping.witnessesByRegister) {
      mergeWitnessList(next, key, witnesses);
      mergeWitnessList(next, key, document.witnesses);
    }
  }
  const declared = mappingFromVersion(document);
  for (const [key, witnesses] of declared.witnessesByRegister) {
    mergeWitnessList(next, key, witnesses);
  }
  return { witnessesByRegister: next };
}

function mergeMapping(
  mappings: Map<string, EffectiveDocumentMapping>,
  qualifiedName: string,
  incoming: EffectiveDocumentMapping,
): void {
  const key = normalizeQualifiedName(qualifiedName);
  const merged = new Map<string, MergeFileWitness[]>();
  const existing = mappings.get(key);
  for (const mapping of [existing, incoming]) {
    if (!mapping) {continue;}
    for (const [register, witnesses] of mapping.witnessesByRegister) {
      mergeWitnessList(merged, register, witnesses);
    }
  }
  mappings.set(key, { witnessesByRegister: merged });
}

function mergeWitnessList(
  target: Map<string, MergeFileWitness[]>,
  key: string,
  incoming: readonly MergeFileWitness[],
): void {
  const witnesses = target.get(key) ?? [];
  witnesses.push(...incoming);
  target.set(key, witnesses);
}

function dedupeWitnesses(witnesses: readonly MergeFileWitness[]): MergeFileWitness[] {
  const seen = new Set<string>();
  return witnesses.filter((witness) => {
    const key = `${witness.sourceId}\0${witness.relativePath.toLowerCase()}\0${witness.expectedHash}\0${witness.kind ?? 'file'}`;
    if (seen.has(key)) {return false;}
    seen.add(key);
    return true;
  });
}

function parseRegisterReference(value: string): string | undefined {
  const trimmed = value.trim();
  const dot = trimmed.indexOf('.');
  if (dot <= 0 || dot !== trimmed.lastIndexOf('.') || dot === trimmed.length - 1) {return undefined;}
  const metadataType = trimmed.slice(0, dot).trim();
  const objectName = trimmed.slice(dot + 1).trim();
  if (!REGISTER_ROOT_TYPES.has(metadataType) || !isMetadataName(objectName)) {return undefined;}
  return `${metadataType}.${objectName}`;
}

function metadataObjectReferenceType(value: Record<string, unknown>): string | undefined {
  for (const [key, attributeValue] of Object.entries(value)) {
    if (!isAttributeKey(key) || typeof attributeValue !== 'string') {continue;}
    const attributeName = key.startsWith('@_') ? key.slice(2) : key.slice(1);
    if (localName(attributeName).toLowerCase() === 'type') {
      return localName(attributeValue.trim());
    }
  }
  return undefined;
}

function directText(value: unknown): string | undefined {
  if (typeof value === 'string') {return value.trim();}
  if (!isRecord(value) || Object.keys(value).some((key) => !isAttributeKey(key) && key !== '#text')) {return undefined;}
  const texts = Object.entries(value)
    .filter(([key]) => key === '#text')
    .map(([, text]) => text)
    .filter((text): text is string => typeof text === 'string');
  return texts.length === 1 ? texts[0]!.trim() : undefined;
}

function directChildren(value: Record<string, unknown>): Array<readonly [string, unknown]> {
  return Object.entries(value)
    .filter(([key]) => !isAttributeKey(key) && !key.startsWith('#') && !key.startsWith('?'))
    .flatMap(([key, child]) => Array.isArray(child)
      ? child.map((item) => [key, item] as const)
      : [[key, child] as const]);
}

function directChildValues(value: Record<string, unknown>, name: string): unknown[] {
  return directChildren(value)
    .filter(([key]) => localName(key).toLowerCase() === name.toLowerCase())
    .flatMap(([, child]) => Array.isArray(child) ? child : [child]);
}

function parseXml(
  xml: string,
  artifactPath: string,
  errors: Array<{ artifactPath: string; message: string }>,
): Record<string, unknown> | undefined {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    errors.push({ artifactPath, message: `XML нельзя проверить для разбора RegisterRecords: ${validation.err?.msg ?? 'malformed XML'}.` });
    return undefined;
  }
  try {
    return XmlParser.parseString(xml);
  } catch (error) {
    errors.push({ artifactPath, message: `XML нельзя разобрать для RegisterRecords: ${errorMessage(error)}.` });
    return undefined;
  }
}

function isMetadataName(value: string): boolean {
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(value);
}

function normalizeQualifiedName(value: string): string {
  return value.trim().toLowerCase();
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
