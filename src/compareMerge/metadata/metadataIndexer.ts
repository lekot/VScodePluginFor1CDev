import * as fs from 'fs/promises';
import * as path from 'path';

import type { CompareSide, MetadataIdentity, MetadataNameSource } from '../domain/compareContracts';
import { getValueByLocalName, localName } from '../../parsers/xmlNavHelpers';
import { XmlParser } from '../../parsers/xmlParser';
import { getMetadataTypeDescriptorByRootTag, METADATA_TYPE_DESCRIPTORS } from '../../constants/metadataTypeDescriptors';
import { readMetadataHeaderPrefix } from './metadataHeaderReader';
import {
  type CompareCancellationToken,
  throwIfCompareCancelled,
} from '../compareCancellation';

export interface MetadataIndexFileInput {
  sourceId: string;
  side: CompareSide;
  filePath: string;
  metadataType?: string;
  qualifiedName?: string;
  readUuid?: boolean;
  cancellation?: CompareCancellationToken;
}

export interface MetadataIndexFolderInput {
  sourceId: string;
  side: CompareSide;
  folderPath: string;
  metadataType?: string;
  concurrency?: number;
  readUuid?: boolean;
  cancellation?: CompareCancellationToken;
  directoryConcurrency?: number;
}

export async function indexMetadataFile(input: MetadataIndexFileInput): Promise<MetadataIdentity> {
  throwIfCompareCancelled(input.cancellation);
  if (input.metadataType && input.qualifiedName) {
    const uuid =
      input.readUuid === false ? undefined : await readMetadataUuidPrefix(input.filePath);
    throwIfCompareCancelled(input.cancellation);
    return {
      sourceId: input.sourceId,
      side: input.side,
      metadataType: input.metadataType,
      qualifiedName: input.qualifiedName,
      uuid,
      filePath: input.filePath,
      containerPath: path.dirname(input.filePath),
      objectPath: input.qualifiedName,
      nameSource: 'callerInput',
      uuidSource: uuid ? 'xmlAttribute' : 'missing',
      confidence: uuid ? 'strong' : 'nameOnly',
    };
  }

  const parsed = await XmlParser.parseFileAsync(input.filePath);
  throwIfCompareCancelled(input.cancellation);
  return projectMetadataIdentity(input, parsed);
}

function projectMetadataIdentity(
  input: MetadataIndexFileInput,
  parsed: Record<string, unknown>
): MetadataIdentity {
  const root = getRootElement(parsed);
  const metadataType =
    input.metadataType ??
    inferMetadataTypeFromXml(root, parsed) ??
    inferMetadataTypeFromPath(input.filePath);
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

async function readMetadataUuidPrefix(filePath: string): Promise<string | undefined> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return readMetadataUuidFast(buffer.toString('utf-8', 0, bytesRead));
  } finally {
    await handle.close();
  }
}

function readMetadataUuidFast(content: string): string | undefined {
  const uuid = content.match(/\buuid\s*=\s*"([^"]+)"/i)?.[1];
  return uuid === undefined ? undefined : Buffer.from(uuid, 'utf8').toString('utf8');
}

export async function indexMetadataFolder(
  input: MetadataIndexFolderInput
): Promise<MetadataIdentity[]> {
  throwIfCompareCancelled(input.cancellation);
  const xmlFiles = await collectMetadataXmlFiles(
    input.folderPath,
    input.cancellation,
    input.directoryConcurrency ?? 8,
  );
  const indexed = await mapLimit(xmlFiles, input.concurrency ?? 16, async (filePath) => {
    throwIfCompareCancelled(input.cancellation);
    const pathContext = inferMetadataPathContext(input.folderPath, filePath, input.metadataType);
    if (!pathContext) {
      if (!(await isStandaloneMetadataFile(filePath))) {
        return undefined;
      }
    }

    const fileInput: MetadataIndexFileInput = {
      sourceId: input.sourceId,
      side: input.side,
      filePath,
      metadataType: pathContext?.metadataType,
      qualifiedName: pathContext?.qualifiedName,
      readUuid: input.readUuid,
      cancellation: input.cancellation,
    };
    if (fileInput.metadataType && !fileInput.qualifiedName) {
      return indexMetadataFileFromHeader(fileInput);
    }
    return indexMetadataFile(fileInput);
  }, input.cancellation);

  return indexed.filter((identity): identity is MetadataIdentity => Boolean(identity));
}

async function indexMetadataFileFromHeader(input: MetadataIndexFileInput): Promise<MetadataIdentity> {
  const metadataType = input.metadataType;
  if (!metadataType) {
    return indexMetadataFile(input);
  }

  const descriptor = METADATA_DESCRIPTORS_BY_TYPE.get(metadataType);
  const rootTags = [metadataType, descriptor?.designerRootTag, ...(descriptor?.designerRootTagAliases ?? [])]
    .filter((tag): tag is string => tag !== undefined);
  const prefix = await readMetadataHeaderPrefix({
    filePath: input.filePath,
    rootTags,
    cancellation: input.cancellation,
  });
  if (!prefix) {
    return indexMetadataFile(input);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = XmlParser.parseString(prefix);
  } catch {
    return indexMetadataFile(input);
  }
  throwIfCompareCancelled(input.cancellation);

  stripProcessingInstructionNodes(parsed);
  const root = getRootElement(parsed);
  const objectElement = findMetadataObjectElement(parsed, metadataType) ?? root.value;
  if (!readPropertiesName(objectElement) && !readPropertiesName(root.value)) {
    return indexMetadataFile(input);
  }

  return projectMetadataIdentity(input, parsed);
}

function stripProcessingInstructionNodes(parsed: Record<string, unknown>): void {
  for (const key of Object.keys(parsed)) {
    if (key.startsWith('?')) {
      delete parsed[key];
    }
  }
}

interface MetadataPathContext {
  metadataType?: string;
  qualifiedName?: string;
}

async function collectMetadataXmlFiles(
  folderPath: string,
  cancellation: CompareCancellationToken | undefined,
  concurrency: number,
): Promise<string[]> {
  const xmlFiles: string[] = [];
  const directories = [folderPath];
  let nextDirectoryIndex = 0;
  let activeDirectoryReads = 0;
  let failure: { error: unknown } | undefined;
  const directoryWaiters: Array<() => void> = [];

  function wakeDirectoryWaiters(): void {
    for (const wake of directoryWaiters.splice(0)) {
      wake();
    }
  }

  async function collect(): Promise<void> {
    while (!failure) {
      try {
        throwIfCompareCancelled(cancellation);
        if (nextDirectoryIndex >= directories.length) {
          if (activeDirectoryReads === 0) {
            return;
          }

          await new Promise<void>((resolve) => directoryWaiters.push(resolve));
          continue;
        }

        const currentFolderPath = directories[nextDirectoryIndex];
        nextDirectoryIndex += 1;
        activeDirectoryReads += 1;
        try {
          const entries = await fs.readdir(currentFolderPath, { withFileTypes: true });
          throwIfCompareCancelled(cancellation);
          if (failure) {
            return;
          }

          for (const entry of entries) {
            const entryPath = path.join(currentFolderPath, entry.name);
            if (entry.isDirectory()) {
              if (entry.name.toLowerCase() !== 'ext') {
                directories.push(entryPath);
              }
              continue;
            }

            if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.xml') {
              xmlFiles.push(entryPath);
            }
          }
        } finally {
          activeDirectoryReads -= 1;
          wakeDirectoryWaiters();
        }
      } catch (error) {
        failure ??= { error };
        wakeDirectoryWaiters();
      }
    }
  }

  const limit = Math.max(1, Math.min(Math.floor(concurrency), 32));
  const settled = await Promise.allSettled(Array.from({ length: limit }, collect));
  const rejectedWorker = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) {
    throw failure.error;
  }
  if (rejectedWorker) {
    throw rejectedWorker.reason;
  }
  throwIfCompareCancelled(cancellation);
  return xmlFiles.sort((left, right) => left.localeCompare(right));
}

async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
  cancellation?: CompareCancellationToken
): Promise<R[]> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failure: { error: unknown } | undefined;
  let completedSinceYield = 0;

  async function run(): Promise<void> {
    while (!failure) {
      let index: number;
      try {
        throwIfCompareCancelled(cancellation);
        if (nextIndex >= items.length) {
          return;
        }
        index = nextIndex;
        nextIndex += 1;
      } catch (error) {
        failure ??= { error };
        return;
      }

      try {
        results[index] = await worker(items[index]);
        throwIfCompareCancelled(cancellation);
        completedSinceYield += 1;
        if (completedSinceYield >= 64) {
          completedSinceYield = 0;
          await new Promise<void>((resolve) => setImmediate(resolve));
          throwIfCompareCancelled(cancellation);
        }
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  }

  const settled = await Promise.allSettled(Array.from({ length: limit }, run));
  const rejectedWorker = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) {
    throw failure.error;
  }
  if (rejectedWorker) {
    throw rejectedWorker.reason;
  }
  throwIfCompareCancelled(cancellation);
  return results;
}

function inferMetadataPathContext(
  folderPath: string,
  filePath: string,
  explicitMetadataType: string | undefined
): MetadataPathContext | undefined {
  const relativeParts = path.relative(folderPath, filePath).split(path.sep).filter(Boolean);
  const folderMetadataType =
    explicitMetadataType ?? inferKnownMetadataTypeFromFolderName(path.basename(folderPath));
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
    return {
      metadataType: rootMetadataType,
      qualifiedName: rootMetadataType ? `${rootMetadataType}.${fileBaseName}` : undefined,
    };
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

function inferMetadataTypeFromXml(
  root: { name: string; value: unknown },
  parsed: Record<string, unknown>
): string | undefined {
  const rootName = localName(root.name);
  if (rootName !== 'MetaDataObject') {
    return metadataTypeForRootTag(rootName);
  }

  if (!isRecord(root.value)) {
    return undefined;
  }

  for (const [key, value] of Object.entries(root.value)) {
    if (isXmlPayloadKey(key) && value !== undefined) {
      return metadataTypeForRootTag(localName(key));
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

function metadataTypeForRootTag(rootTag: string): string {
  return String(getMetadataTypeDescriptorByRootTag(rootTag)?.type ?? rootTag);
}

function findMetadataObjectElement(parsed: Record<string, unknown>, metadataType: string): unknown {
  const root = getRootElement(parsed);
  if (localName(root.name) === metadataType) {
    return firstValue(root.value);
  }

  if (isRecord(root.value)) {
    const descriptor = METADATA_DESCRIPTORS_BY_TYPE.get(metadataType);
    const rootTags = [metadataType, descriptor?.designerRootTag, ...(descriptor?.designerRootTagAliases ?? [])]
      .filter((value): value is string => value !== undefined);
    for (const rootTag of rootTags) {
      const direct = getValueByLocalName(root.value, rootTag);
      if (direct !== undefined) {return firstValue(direct);}
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

const NESTED_METADATA_FOLDER_TYPES: Record<string, string> = {
  Attributes: 'Attribute',
  Commands: 'Command',
  Dimensions: 'Dimension',
  Forms: 'Form',
  Resources: 'Resource',
  TabularSections: 'TabularSection',
  Templates: 'Template',
};

const METADATA_FOLDER_TYPES: Record<string, string> = Object.fromEntries([
  ...METADATA_TYPE_DESCRIPTORS.map((descriptor) => [descriptor.designerFolder, String(descriptor.type)]),
  ...Object.entries(NESTED_METADATA_FOLDER_TYPES),
]);

const METADATA_DESCRIPTORS_BY_TYPE = new Map(
  METADATA_TYPE_DESCRIPTORS.map((descriptor) => [String(descriptor.type), descriptor])
);

const KNOWN_METADATA_TYPES = new Set(Object.values(METADATA_FOLDER_TYPES));

/** Metadata roots that can own a Designer descriptor/container in a configuration export. */
export const KNOWN_ROOT_METADATA_TYPES: ReadonlySet<string> = new Set(
  METADATA_TYPE_DESCRIPTORS.map((descriptor) => String(descriptor.type))
);
