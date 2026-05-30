import * as fs from 'fs/promises';
import * as path from 'path';

import type { CompareSide, MetadataIdentity, MetadataNameSource } from '../domain/compareContracts';
import { getValueByLocalName, localName } from '../../parsers/xmlNavHelpers';
import { XmlParser } from '../../parsers/xmlParser';

export interface MetadataIndexFileInput {
  sourceId: string;
  side: CompareSide;
  filePath: string;
  metadataType?: string;
  qualifiedName?: string;
}

export interface MetadataIndexFolderInput {
  sourceId: string;
  side: CompareSide;
  folderPath: string;
  metadataType?: string;
}

export async function indexMetadataFile(input: MetadataIndexFileInput): Promise<MetadataIdentity> {
  const parsed = await XmlParser.parseFileAsync(input.filePath);
  const root = getRootElement(parsed);
  const metadataType =
    input.metadataType ?? inferMetadataTypeFromXml(root, parsed) ?? inferMetadataTypeFromPath(input.filePath);
  const objectElement = findMetadataObjectElement(parsed, metadataType) ?? root.value;
  const xmlName = readPropertiesName(objectElement) ?? readPropertiesName(root.value);
  const pathName = path.basename(input.filePath, path.extname(input.filePath));
  const name = extractNameFromQualifiedName(input.qualifiedName) ?? xmlName ?? pathName;
  const nameSource: MetadataNameSource = input.qualifiedName
    ? 'callerInput'
    : xmlName
      ? 'xmlPropertiesName'
      : 'fileName';
  const qualifiedName = input.qualifiedName ?? `${metadataType}.${name}`;
  const uuid = readUuid(objectElement) ?? readUuid(root.value);

  return {
    sourceId: input.sourceId,
    side: input.side,
    metadataType,
    qualifiedName,
    uuid,
    filePath: input.filePath,
    containerPath: path.dirname(input.filePath),
    objectPath: qualifiedName,
    nameSource,
    uuidSource: uuid ? 'xmlAttribute' : 'missing',
    confidence: uuid ? 'strong' : 'nameOnly',
  };
}

export async function indexMetadataFolder(input: MetadataIndexFolderInput): Promise<MetadataIdentity[]> {
  const xmlFiles = await collectXmlFiles(input.folderPath);

  const identities: MetadataIdentity[] = [];
  for (const filePath of xmlFiles) {
    if (isUnderExtFolder(input.folderPath, filePath)) {
      continue;
    }

    const pathContext = inferMetadataPathContext(input.folderPath, filePath, input.metadataType);
    if (!pathContext) {
      if (!(await isStandaloneMetadataFile(filePath))) {
        continue;
      }
    }

    identities.push(
      await indexMetadataFile({
        sourceId: input.sourceId,
        side: input.side,
        filePath,
        metadataType: pathContext?.metadataType,
        qualifiedName: pathContext?.qualifiedName,
      })
    );
  }

  return identities;
}

interface MetadataPathContext {
  metadataType?: string;
  qualifiedName?: string;
}

async function collectXmlFiles(folderPath: string): Promise<string[]> {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const xmlFiles: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      xmlFiles.push(...(await collectXmlFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.xml') {
      xmlFiles.push(entryPath);
    }
  }

  return xmlFiles.sort((left, right) => left.localeCompare(right));
}

function isUnderExtFolder(folderPath: string, filePath: string): boolean {
  return path
    .relative(folderPath, filePath)
    .split(path.sep)
    .some((part) => part.toLowerCase() === 'ext');
}

function inferMetadataPathContext(
  folderPath: string,
  filePath: string,
  explicitMetadataType: string | undefined
): MetadataPathContext | undefined {
  const relativeParts = path.relative(folderPath, filePath).split(path.sep).filter(Boolean);
  const folderMetadataType = explicitMetadataType ?? inferKnownMetadataTypeFromFolderName(path.basename(folderPath));
  if (relativeParts.length === 0) {
    return folderMetadataType ? { metadataType: folderMetadataType } : undefined;
  }

  if (relativeParts.length === 1 && !folderMetadataType) {
    return undefined;
  }

  const fileName = relativeParts[relativeParts.length - 1];
  const fileBaseName = path.basename(fileName, path.extname(fileName));
  const folderParts = relativeParts.slice(0, -1);
  let cursor = 0;
  let rootMetadataType = folderMetadataType;

  if (!rootMetadataType) {
    const firstFolderType = inferKnownMetadataTypeFromFolderName(relativeParts[0]);
    if (firstFolderType && relativeParts.length > 1) {
      rootMetadataType = firstFolderType;
      cursor = 1;
    } else {
      rootMetadataType = inferMetadataTypeFromFolder(folderPath);
    }
  }

  if (folderParts.length <= cursor) {
    return { metadataType: rootMetadataType };
  }

  if (folderParts.length === cursor + 1) {
    return { metadataType: rootMetadataType };
  }

  const ownerName = folderParts[cursor];
  if (!rootMetadataType || !ownerName) {
    return { metadataType: rootMetadataType };
  }

  const qualifiedNameParts = [rootMetadataType, ownerName];
  let metadataType = rootMetadataType;
  let index = cursor + 1;

  while (index < folderParts.length) {
    const nestedMetadataType = inferKnownMetadataTypeFromFolderName(folderParts[index]);
    if (!nestedMetadataType) {
      return undefined;
    }

    const objectName = folderParts[index + 1] ?? fileBaseName;
    qualifiedNameParts.push(nestedMetadataType, objectName);
    metadataType = nestedMetadataType;
    index += 2;
  }

  return {
    metadataType,
    qualifiedName: qualifiedNameParts.join('.'),
  };
}

async function isStandaloneMetadataFile(filePath: string): Promise<boolean> {
  const parsed = await XmlParser.parseFileAsync(filePath);
  const metadataType = inferMetadataTypeFromXml(getRootElement(parsed), parsed);
  return metadataType ? isKnownMetadataType(metadataType) : false;
}

function getRootElement(parsed: Record<string, unknown>): { name: string; value: unknown } {
  for (const [name, value] of Object.entries(parsed)) {
    if (name === '?xml' || name.startsWith('#')) {
      continue;
    }

    return { name, value };
  }

  return { name: 'Unknown', value: parsed };
}

function inferMetadataTypeFromXml(root: { name: string; value: unknown }, parsed: Record<string, unknown>): string | undefined {
  const rootName = localName(root.name);
  if (rootName !== 'MetaDataObject') {
    return rootName;
  }

  if (!isRecord(root.value)) {
    return undefined;
  }

  for (const [key, value] of Object.entries(root.value)) {
    if (isXmlPayloadKey(key) && value !== undefined) {
      return localName(key);
    }
  }

  return getRootElement(parsed).name;
}

function inferMetadataTypeFromPath(filePath: string): string {
  return inferMetadataTypeFromFolder(path.dirname(filePath)) ?? 'Unknown';
}

function inferMetadataTypeFromFolder(folderPath: string): string | undefined {
  const folderName = path.basename(folderPath);
  return inferKnownMetadataTypeFromFolderName(folderName) ?? singularizeMetadataFolder(folderName);
}

function inferKnownMetadataTypeFromFolderName(folderName: string | undefined): string | undefined {
  return folderName ? METADATA_FOLDER_TYPES[folderName] : undefined;
}

function isKnownMetadataType(metadataType: string): boolean {
  return KNOWN_METADATA_TYPES.has(metadataType);
}

function findMetadataObjectElement(parsed: Record<string, unknown>, metadataType: string): unknown {
  const root = getRootElement(parsed);
  if (localName(root.name) === metadataType) {
    return firstValue(root.value);
  }

  if (isRecord(root.value)) {
    const direct = getValueByLocalName(root.value, metadataType);
    if (direct !== undefined) {
      return firstValue(direct);
    }
  }

  return undefined;
}

function readPropertiesName(value: unknown): string | undefined {
  const record = firstRecord(value);
  if (!record) {
    return undefined;
  }

  const properties = firstRecord(getValueByLocalName(record, 'Properties'));
  if (!properties) {
    return undefined;
  }

  return scalarToString(getValueByLocalName(properties, 'Name'));
}

function readUuid(value: unknown): string | undefined {
  const record = firstRecord(value);
  if (!record) {
    return undefined;
  }

  return (
    scalarToString(record['@_uuid']) ??
    scalarToString(record.uuid) ??
    scalarToString(record['@_UUID']) ??
    scalarToString(record.UUID)
  );
}

function extractNameFromQualifiedName(qualifiedName: string | undefined): string | undefined {
  if (!qualifiedName) {
    return undefined;
  }

  const parts = qualifiedName.split('.');
  return parts[parts.length - 1];
}

function firstValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  const first = firstValue(value);
  return isRecord(first) ? first : undefined;
}

function scalarToString(value: unknown): string | undefined {
  const scalar = firstValue(value);
  if (typeof scalar === 'string') {
    const trimmed = scalar.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof scalar === 'number' || typeof scalar === 'boolean') {
    return String(scalar);
  }
  if (isRecord(scalar)) {
    return scalarToString(scalar['#text']);
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isXmlPayloadKey(key: string): boolean {
  return key !== ':@' && !key.startsWith('@_') && !key.startsWith('#');
}

function singularizeMetadataFolder(folderName: string): string {
  if (folderName.endsWith('ies')) {
    return `${folderName.slice(0, -3)}y`;
  }
  if (folderName.endsWith('s')) {
    return folderName.slice(0, -1);
  }

  return folderName;
}

const METADATA_FOLDER_TYPES: Record<string, string> = {
  AccumulationRegisters: 'AccumulationRegister',
  AccountingRegisters: 'AccountingRegister',
  BusinessProcesses: 'BusinessProcess',
  CalculationRegisters: 'CalculationRegister',
  Catalogs: 'Catalog',
  ChartsOfAccounts: 'ChartOfAccounts',
  ChartsOfCalculationTypes: 'ChartOfCalculationTypes',
  ChartsOfCharacteristicTypes: 'ChartOfCharacteristicTypes',
  CommonAttributes: 'CommonAttribute',
  CommonCommands: 'CommonCommand',
  CommonForms: 'CommonForm',
  CommonModules: 'CommonModule',
  CommonPictures: 'CommonPicture',
  CommonTemplates: 'CommonTemplate',
  CommandGroups: 'CommandGroup',
  Constants: 'Constant',
  DataProcessors: 'DataProcessor',
  DefinedTypes: 'DefinedType',
  DocumentJournals: 'DocumentJournal',
  DocumentNumerators: 'DocumentNumerator',
  Documents: 'Document',
  Enums: 'Enum',
  EventSubscriptions: 'EventSubscription',
  ExchangePlans: 'ExchangePlan',
  ExternalDataSources: 'ExternalDataSource',
  FilterCriteria: 'FilterCriterion',
  FunctionalOptions: 'FunctionalOption',
  FunctionalOptionsParameters: 'FunctionalOptionsParameter',
  HTTPServices: 'HTTPService',
  InformationRegisters: 'InformationRegister',
  IntegrationServices: 'IntegrationService',
  Interfaces: 'Interface',
  Languages: 'Language',
  Reports: 'Report',
  Roles: 'Role',
  ScheduledJobs: 'ScheduledJob',
  SessionParameters: 'SessionParameter',
  SettingsStorages: 'SettingsStorage',
  Styles: 'Style',
  Subsystems: 'Subsystem',
  Tasks: 'Task',
  WebServices: 'WebService',
  WSReferences: 'WSReference',
  XDTOPackages: 'XDTOPackage',
  Attributes: 'Attribute',
  Commands: 'Command',
  Dimensions: 'Dimension',
  Forms: 'Form',
  Resources: 'Resource',
  TabularSections: 'TabularSection',
  Templates: 'Template',
};

const KNOWN_METADATA_TYPES = new Set(Object.values(METADATA_FOLDER_TYPES));
