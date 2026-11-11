import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { XMLValidator } from 'fast-xml-parser';

import type { Dirent } from 'fs';
import { getMetadataTypeDescriptorByRootTag, METADATA_TYPE_DESCRIPTORS } from '../../constants/metadataTypeDescriptors';
import { CONFIGURATION_XML } from '../../constants/fileNames';
import { parseCfeObjectIdentity, type CfeObjectIdentity } from '../../extensionSupport/cfeProject/ownership';
import { captureMergePath, type MergePathSnapshot, type MergeSnapshotDirectory } from '../merge/mergeSnapshot';
import { localName } from '../../parsers/xmlNavHelpers';
import { XmlParser } from '../../parsers/xmlParser';
import { validateElementName } from '../../utils/elementNameValidator';
import type { CompareSide } from '../domain/compareContracts';
import { isConfigurationCompareCancelled, throwIfCompareCancelled, type CompareCancellationToken } from '../compareCancellation';
import type { CompareBuildProgress } from '../compareProgress';

export type ExtensionRootKind = 'cf' | 'cfe' | 'unknown';

export interface ExtensionIndexDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly relativePath?: string;
  readonly qualifiedName?: string;
}

export interface ExtensionCapturedFile {
  readonly relativePath: string;
  readonly content?: Buffer;
  readonly hash: string;
  readonly rootExpandedName?: string;
}

export interface ExtensionIndexedObject {
  readonly side: CompareSide;
  readonly sourceId: string;
  readonly metadataType: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly descriptorRelativePath?: string;
  readonly sidecarRelativePath?: string;
  readonly identity?: CfeObjectIdentity;
  /** Exact root tag present in descriptor XML; identity.type is registry-canonical. */
  readonly descriptorRootTag?: string;
  readonly descriptorContent?: Buffer;
  readonly descriptorHash?: string;
  readonly sidecarSnapshot?: MergePathSnapshot;
  readonly sidecarFiles: readonly ExtensionCapturedFile[];
  readonly supportedRootType: boolean;
  readonly valid: boolean;
  readonly unsupportedReason?: string;
}

export interface ExtensionMetadataIndex {
  readonly rootPath: string;
  readonly canonicalRootPath?: string;
  readonly sourceId: string;
  readonly side: CompareSide;
  rootKind: ExtensionRootKind;
  readonly hasConfigurationXml: boolean;
  readonly configurationContent?: Buffer;
  readonly configurationHash?: string;
  readonly formatVersion?: string;
  readonly configurationUuid?: string;
  readonly configurationName?: string;
  readonly objectBelonging?: string;
  readonly purpose?: string;
  readonly namePrefix?: string;
  readonly objects: ExtensionIndexedObject[];
  readonly diagnostics: ExtensionIndexDiagnostic[];
  readonly cfeMarkerSeen: boolean;
}

export interface ExtensionMetadataRootEvidence {
  readonly rootKind: ExtensionRootKind;
  readonly cfeMarkerSeen: boolean;
}

const CFE_PURPOSES = new Set(['Customization', 'Patch', 'AddOn']);
export const SUPPORTED_EXTENSION_FORMATS: ReadonlySet<string> = new Set(['2.17', '2.18', '2.19', '2.20', '2.21']);
const CFE_MARKER_PATTERN = /<(?:[\w.-]+:)?(?:ObjectBelonging|ExtendedConfigurationObject|ConfigurationExtensionPurpose)\b/iu;

interface RootProbe {
  rootPath: string;
  canonicalRootPath?: string;
  sourceId: string;
  side: CompareSide;
  rootKind: ExtensionRootKind;
  hasConfigurationXml: boolean;
  configurationContent?: Buffer;
  configurationHash?: string;
  formatVersion?: string;
  configurationUuid?: string;
  configurationName?: string;
  objectBelonging?: string;
  purpose?: string;
  namePrefix?: string;
  registrations: RootRegistration[];
  diagnostics: ExtensionIndexDiagnostic[];
  cfeMarkerSeen: boolean;
}

interface RootProbeEvidenceRecord {
  readonly probe: RootProbe;
  readonly canonicalRootPath?: string;
  readonly hasConfigurationXml: boolean;
  readonly configurationHash?: string;
}

// Evidence handles are short-lived and opaque; this WeakMap is not a root-path cache.
const rootProbeEvidence = new WeakMap<ExtensionMetadataRootEvidence, RootProbeEvidenceRecord>();

interface RootRegistration {
  readonly metadataType: string;
  readonly name: string;
  readonly qualifiedName: string;
}

/** Reads only root Configuration.xml registrations and their direct descriptors/artifact trees. */
export async function indexExtensionMetadataRoot(input: {
  readonly rootPath: string;
  readonly sourceId: string;
  readonly side: CompareSide;
  readonly cancellation?: CompareCancellationToken;
  readonly onProgress?: (progress: CompareBuildProgress) => void;
  readonly rootEvidence?: ExtensionMetadataRootEvidence;
}): Promise<ExtensionMetadataIndex> {
  throwIfCompareCancelled(input.cancellation);
  const evidenceRecord = input.rootEvidence ? rootProbeEvidence.get(input.rootEvidence) : undefined;
  if (input.rootEvidence && !evidenceRecord) {
    throw new Error('Extension metadata root evidence was not produced by this module.');
  }
  const probe = evidenceRecord
    ? await validateRootProbeEvidence(input, evidenceRecord)
    : await probeRoot(input);
  const objects: ExtensionIndexedObject[] = [];
  let objectMarkerSeen = false;

  for (const registration of probe.registrations) {
    throwIfCompareCancelled(input.cancellation);
    const indexed = await indexRegisteredObject({
      rootPath: probe.canonicalRootPath ?? input.rootPath,
      sourceId: input.sourceId,
      side: input.side,
      registration,
      rootFormatVersion: probe.formatVersion,
      cancellation: input.cancellation,
    });
    objects.push(indexed);
    notifyProgress(input.onProgress, { phase: 'metadata', completed: objects.length, total: probe.registrations.length });
    if (indexed.descriptorContent && CFE_MARKER_PATTERN.test(decodeXml(indexed.descriptorContent))) {
      objectMarkerSeen = true;
    }
  }

  const rootKind = probe.rootKind === 'cfe' || objectMarkerSeen ? 'cfe' : probe.rootKind;
  const diagnostics = [...probe.diagnostics];
  if (rootKind === 'cfe') {
    if (!probe.hasConfigurationXml) {
      diagnostics.push({ code: 'EXTENSION_CONFIGURATION_XML_MISSING', message: 'Признаки CFE обнаружены, но корневой Configuration.xml отсутствует.' });
    }
    if (probe.objectBelonging !== 'Adopted') {
      diagnostics.push({ code: 'EXTENSION_ROOT_BELONGING_INVALID', message: 'Корневой Configuration.xml CFE должен содержать ObjectBelonging=Adopted.' });
    }
    if (!probe.purpose || !CFE_PURPOSES.has(probe.purpose)) {
      diagnostics.push({ code: 'EXTENSION_PURPOSE_INVALID', message: 'Назначение CFE отсутствует или не поддержано.' });
    }
    if (probe.namePrefix !== undefined && probe.namePrefix !== '' && validateElementName(probe.namePrefix, []) !== null) {
      diagnostics.push({ code: 'EXTENSION_NAME_PREFIX_INVALID', message: 'Префикс имён CFE некорректен.' });
    }
  }

  return {
    rootPath: input.rootPath,
    canonicalRootPath: probe.canonicalRootPath,
    sourceId: input.sourceId,
    side: input.side,
    rootKind,
    hasConfigurationXml: probe.hasConfigurationXml,
    configurationContent: probe.configurationContent,
    configurationHash: probe.configurationHash,
    formatVersion: probe.formatVersion,
    configurationUuid: probe.configurationUuid,
    configurationName: probe.configurationName,
    objectBelonging: probe.objectBelonging,
    purpose: probe.purpose,
    namePrefix: probe.namePrefix,
    objects,
    diagnostics,
    cfeMarkerSeen: probe.cfeMarkerSeen || objectMarkerSeen,
  };
}

/** Probes only root metadata and direct descriptor XML for CFE evidence. */
export async function probeExtensionMetadataRoot(input: {
  readonly rootPath: string;
  readonly cancellation?: CompareCancellationToken;
}): Promise<ExtensionMetadataRootEvidence> {
  throwIfCompareCancelled(input.cancellation);
  const probe = await probeRoot({
    rootPath: input.rootPath,
    sourceId: '',
    side: 'left',
    cancellation: input.cancellation,
  });
  const evidence: ExtensionMetadataRootEvidence = Object.freeze({
    rootKind: probe.rootKind,
    cfeMarkerSeen: probe.cfeMarkerSeen,
  });
  rootProbeEvidence.set(evidence, {
    probe,
    canonicalRootPath: probe.canonicalRootPath,
    hasConfigurationXml: probe.hasConfigurationXml,
    configurationHash: probe.configurationHash,
  });
  return evidence;
}

async function validateRootProbeEvidence(
  input: { readonly rootPath: string; readonly sourceId: string; readonly side: CompareSide; readonly cancellation?: CompareCancellationToken },
  record: RootProbeEvidenceRecord,
): Promise<RootProbe> {
  throwIfCompareCancelled(input.cancellation);
  let canonicalRootPath: string;
  try {
    canonicalRootPath = await fs.realpath(input.rootPath);
    throwIfCompareCancelled(input.cancellation);
  } catch (error) {
    throwIfCompareCancelled(input.cancellation);
    throw error;
  }
  if (!record.canonicalRootPath || normalizeRootPath(canonicalRootPath) !== normalizeRootPath(record.canonicalRootPath)) {
    throw new Error('Extension metadata root evidence belongs to a different root.');
  }

  const currentRootStat = await fs.lstat(canonicalRootPath);
  throwIfCompareCancelled(input.cancellation);
  if (!currentRootStat.isDirectory()) {
    throw new Error('Extension metadata root evidence no longer identifies a directory.');
  }
  const configurationPath = path.join(canonicalRootPath, CONFIGURATION_XML);
  let currentConfigurationContent: Buffer | undefined;
  let configurationEntryInvalid = false;
  try {
    const configurationStat = await fs.lstat(configurationPath);
    throwIfCompareCancelled(input.cancellation);
    if (configurationStat.isFile() && !configurationStat.isSymbolicLink()) {
      currentConfigurationContent = await fs.readFile(configurationPath);
      throwIfCompareCancelled(input.cancellation);
    } else {
      configurationEntryInvalid = true;
    }
  } catch (error) {
    throwIfCompareCancelled(input.cancellation);
    if (!isMissing(error)) {throw error;}
  }
  const configurationHash = currentConfigurationContent ? hash(currentConfigurationContent) : undefined;
  if (configurationEntryInvalid || record.hasConfigurationXml !== (currentConfigurationContent !== undefined)
    || record.configurationHash !== configurationHash) {
    return probeRoot(input);
  }
  return {
    ...record.probe,
    rootPath: input.rootPath,
    sourceId: input.sourceId,
    side: input.side,
  };
}

async function probeRoot(input: {
  rootPath: string;
  sourceId: string;
  side: CompareSide;
  cancellation?: CompareCancellationToken;
}): Promise<RootProbe> {
  const diagnostics: ExtensionIndexDiagnostic[] = [];
  let canonicalRootPath: string | undefined;
  let hasConfigurationXml = false;
  let configurationContent: Buffer | undefined;
  let configurationHash: string | undefined;
  let formatVersion: string | undefined;
  let configurationUuid: string | undefined;
  let configurationName: string | undefined;
  let objectBelonging: string | undefined;
  let purpose: string | undefined;
  let namePrefix: string | undefined;
  let registrations: RootRegistration[] = [];
  let cfeMarkerSeen = false;

  try {
    throwIfCompareCancelled(input.cancellation);
    canonicalRootPath = await fs.realpath(input.rootPath);
    throwIfCompareCancelled(input.cancellation);
    const rootStat = await fs.lstat(canonicalRootPath);
    throwIfCompareCancelled(input.cancellation);
    if (!rootStat.isDirectory()) {
      diagnostics.push({ code: 'EXTENSION_ROOT_INVALID', message: 'Корень сравнения не является каталогом.' });
      canonicalRootPath = undefined;
    }
  } catch (error) {
    throwIfCompareCancelled(input.cancellation);
    rethrowIfCancelled(error);
    diagnostics.push({ code: 'EXTENSION_ROOT_UNAVAILABLE', message: `Корень сравнения недоступен: ${errorMessage(error)}` });
  }

  if (canonicalRootPath) {
    cfeMarkerSeen = await hasCfeMarkerFile(canonicalRootPath, input.cancellation);
    const configurationPath = path.join(canonicalRootPath, CONFIGURATION_XML);
    try {
      throwIfCompareCancelled(input.cancellation);
      const stat = await fs.lstat(configurationPath);
      throwIfCompareCancelled(input.cancellation);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        diagnostics.push({ code: 'EXTENSION_CONFIGURATION_XML_INVALID', message: 'Корневой Configuration.xml не является обычным файлом.', relativePath: CONFIGURATION_XML });
      } else {
        configurationContent = await fs.readFile(configurationPath);
        throwIfCompareCancelled(input.cancellation);
        hasConfigurationXml = true;
        configurationHash = hash(configurationContent);
        const xml = decodeXml(configurationContent);
        cfeMarkerSeen ||= CFE_MARKER_PATTERN.test(xml);
        const validation = XMLValidator.validate(xml);
        if (validation !== true) {
          diagnostics.push({ code: 'EXTENSION_CONFIGURATION_XML_MALFORMED', message: `Корневой Configuration.xml содержит некорректный XML: ${validation.err?.msg ?? 'ошибка структуры'}`, relativePath: CONFIGURATION_XML });
        } else {
          const parsed = XmlParser.parseString(xml);
          const envelope = readSingleElement(parsed, 'MetaDataObject');
          const configuration = envelope ? readSingleElement(envelope, 'Configuration') : undefined;
          if (!envelope || !configuration) {
            diagnostics.push({ code: 'EXTENSION_CONFIGURATION_XML_INVALID', message: 'Configuration.xml не содержит единственный MetaDataObject/Configuration.', relativePath: CONFIGURATION_XML });
          } else {
            formatVersion = readAttribute(envelope, 'version');
            const candidateConfigurationUuid = readAttribute(configuration, 'uuid');
            if (isNonZeroUuid(candidateConfigurationUuid)) {
              configurationUuid = candidateConfigurationUuid;
            } else {
              diagnostics.push({
                code: 'EXTENSION_CONFIGURATION_UUID_INVALID',
                message: 'Configuration.xml должен содержать корректный ненулевой UUID Configuration.',
                relativePath: CONFIGURATION_XML,
              });
            }
            const properties = readSingleProperties(configuration);
            if (properties) {
              configurationName = readSingleText(properties, 'Name');
              objectBelonging = readSingleText(properties, 'ObjectBelonging');
              purpose = readSingleText(properties, 'ConfigurationExtensionPurpose');
              namePrefix = readSingleText(properties, 'NamePrefix');
            } else {
              diagnostics.push({
                code: 'EXTENSION_CONFIGURATION_PROPERTIES_INVALID',
                message: 'Configuration.xml должен содержать единственный прямой элемент Properties.',
                relativePath: CONFIGURATION_XML,
              });
            }
            cfeMarkerSeen ||= objectBelonging !== undefined || purpose !== undefined;
            if (countDirectElementOccurrences(configuration, 'ChildObjects') > 1) {
              diagnostics.push({
                code: 'EXTENSION_CONFIGURATION_CHILD_OBJECTS_INVALID',
                message: 'Configuration.xml не может содержать несколько прямых элементов ChildObjects.',
                relativePath: CONFIGURATION_XML,
              });
            } else {
              const childObjects = readSingleElement(configuration, 'ChildObjects');
              registrations = childObjects ? readRegistrations(childObjects, diagnostics) : [];
            }
          }
        }
      }
    } catch (error) {
      throwIfCompareCancelled(input.cancellation);
      rethrowIfCancelled(error);
      if (isMissing(error)) {
        diagnostics.push({ code: 'EXTENSION_CONFIGURATION_XML_MISSING', message: 'Корневой Configuration.xml отсутствует.', relativePath: CONFIGURATION_XML });
      } else {
        diagnostics.push({ code: 'EXTENSION_CONFIGURATION_XML_READ_FAILED', message: `Не удалось прочитать Configuration.xml: ${errorMessage(error)}`, relativePath: CONFIGURATION_XML });
      }
    }
  }

  if (!cfeMarkerSeen && canonicalRootPath) {
    cfeMarkerSeen = await hasObjectCfeMarkers(canonicalRootPath, input.cancellation);
  }
  const rootKind: ExtensionRootKind = cfeMarkerSeen
    ? 'cfe'
    : hasConfigurationXml && !diagnostics.some((item) => item.code.startsWith('EXTENSION_CONFIGURATION_'))
      ? 'cf'
      : 'unknown';

  return {
    rootPath: input.rootPath,
    canonicalRootPath,
    sourceId: input.sourceId,
    side: input.side,
    rootKind,
    hasConfigurationXml,
    configurationContent,
    configurationHash,
    formatVersion,
    configurationUuid,
    configurationName,
    objectBelonging,
    purpose,
    namePrefix,
    registrations,
    diagnostics,
    cfeMarkerSeen,
  };
}

async function indexRegisteredObject(input: {
  rootPath: string;
  sourceId: string;
  side: CompareSide;
  registration: RootRegistration;
  rootFormatVersion?: string;
  cancellation?: CompareCancellationToken;
}): Promise<ExtensionIndexedObject> {
  const { registration } = input;
  const descriptor = getMetadataTypeDescriptorByRootTag(registration.metadataType);
  const supportedRootType = descriptor !== undefined;
  if (!descriptor) {
    return invalidObject(input, 'EXTENSION_METADATA_TYPE_UNKNOWN', 'Каталог типа объекта не известен.', undefined, supportedRootType);
  }
  const relativeDescriptorPath = `${descriptor.designerFolder}/${registration.name}.xml`;
  const absoluteDescriptorPath = path.join(input.rootPath, descriptor.designerFolder, `${registration.name}.xml`);
  try {
    throwIfCompareCancelled(input.cancellation);
    const stat = await fs.lstat(absoluteDescriptorPath);
      throwIfCompareCancelled(input.cancellation);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return invalidObject(input, 'EXTENSION_DESCRIPTOR_INVALID', 'Дескриптор объекта не является обычным файлом.', relativeDescriptorPath, supportedRootType);
    }
    const descriptorContent = await fs.readFile(absoluteDescriptorPath);
    throwIfCompareCancelled(input.cancellation);
    const descriptorXml = decodeXml(descriptorContent);
    const validation = XMLValidator.validate(descriptorXml);
    if (validation !== true) {
      return invalidObject(input, 'EXTENSION_DESCRIPTOR_MALFORMED', `Дескриптор содержит некорректный XML: ${validation.err?.msg ?? 'ошибка структуры'}.`, relativeDescriptorPath, supportedRootType, descriptorContent);
    }
    const rawIdentity = parseCfeObjectIdentity(descriptorXml, relativeDescriptorPath);
    const descriptorIdentityType = getMetadataTypeDescriptorByRootTag(rawIdentity.type)?.designerRootTag ?? rawIdentity.type;
    if (descriptorIdentityType !== registration.metadataType || rawIdentity.name !== registration.name) {
      return invalidObject(input, 'EXTENSION_DESCRIPTOR_IDENTITY_MISMATCH', 'Identity дескриптора не совпадает с непосредственной регистрацией Configuration.xml.', relativeDescriptorPath, supportedRootType, descriptorContent, rawIdentity);
    }
    const identity = descriptorIdentityType === rawIdentity.type
      ? rawIdentity
      : { ...rawIdentity, type: descriptorIdentityType };
    const metaDataObject = readSingleElement(XmlParser.parseString(descriptorXml), 'MetaDataObject');
    const descriptorVersion = metaDataObject ? readAttribute(metaDataObject, 'version') : undefined;
    const sidecarRelativePath = `${descriptor.designerFolder}/${registration.name}`;
    const sidecarAbsolutePath = path.join(input.rootPath, descriptor.designerFolder, registration.name);
    let sidecarSnapshot: MergePathSnapshot;
    try {
      sidecarSnapshot = await captureMergePath(sidecarAbsolutePath, {
        retainContent: false,
        probeXmlRootNames: true,
        cancellation: input.cancellation,
      });
    } catch (error) {
      throwIfCompareCancelled(input.cancellation);
      rethrowIfCancelled(error);
      return invalidObject(input, 'EXTENSION_SIDECAR_UNSAFE', `Дерево sidecar содержит недопустимый файловый объект: ${errorMessage(error)}`, relativeDescriptorPath, supportedRootType, descriptorContent, identity);
    }
    const sidecarFiles = sidecarSnapshot.state === 'directory'
      ? flattenDirectory(sidecarSnapshot, sidecarRelativePath)
      : [];
    let unsupportedReason: string | undefined;
    if (descriptorVersion !== input.rootFormatVersion) {
      unsupportedReason = 'Версия дескриптора не совпадает с версией корневого Configuration.xml.';
    }
    if (sidecarSnapshot.state !== 'missing' && sidecarSnapshot.type !== 'directory') {
      unsupportedReason = 'Sidecar для объекта должен быть каталогом либо отсутствовать.';
    }
    return {
      side: input.side,
      sourceId: input.sourceId,
      metadataType: registration.metadataType,
      name: registration.name,
      qualifiedName: registration.qualifiedName,
      descriptorRelativePath: relativeDescriptorPath,
      descriptorRootTag: rawIdentity.type,
      sidecarRelativePath,
      identity,
      descriptorContent,
      descriptorHash: hash(descriptorContent),
      sidecarSnapshot,
      sidecarFiles,
      supportedRootType,
      valid: !unsupportedReason,
      unsupportedReason,
    };
  } catch (error) {
    throwIfCompareCancelled(input.cancellation);
    rethrowIfCancelled(error);
    if (isMissing(error)) {
      return invalidObject(input, 'EXTENSION_DESCRIPTOR_MISSING', 'Зарегистрированный объект не имеет корневого XML-дескриптора.', relativeDescriptorPath, supportedRootType);
    }
    return invalidObject(input, 'EXTENSION_DESCRIPTOR_READ_FAILED', `Не удалось проверить дескриптор: ${errorMessage(error)}`, relativeDescriptorPath, supportedRootType);
  }
}

function invalidObject(
  input: { readonly side: CompareSide; readonly sourceId: string; readonly registration: RootRegistration },
  code: string,
  reason: string,
  descriptorRelativePath: string | undefined,
  supportedRootType: boolean,
  descriptorContent?: Buffer,
  identity?: CfeObjectIdentity,
): ExtensionIndexedObject {
  return {
    side: input.side,
    sourceId: input.sourceId,
    metadataType: input.registration.metadataType,
    name: input.registration.name,
    qualifiedName: input.registration.qualifiedName,
    descriptorRelativePath,
    descriptorRootTag: identity?.type,
    identity,
    descriptorContent,
    descriptorHash: descriptorContent ? hash(descriptorContent) : undefined,
    sidecarFiles: [],
    supportedRootType,
    valid: false,
    unsupportedReason: `${code}: ${reason}`,
  };
}

function readRegistrations(childObjects: Record<string, unknown>, diagnostics: ExtensionIndexDiagnostic[]): RootRegistration[] {
  const registrations: RootRegistration[] = [];
  for (const [rawType, rawValues] of Object.entries(childObjects)) {
    if (isXmlMetaKey(rawType) || rawValues === undefined || rawValues === null) {
      continue;
    }
    const rawMetadataType = localName(rawType);
    const metadataType = getMetadataTypeDescriptorByRootTag(rawMetadataType)?.designerRootTag ?? rawMetadataType;
    const values = Array.isArray(rawValues) ? rawValues : [rawValues];
    for (const value of values) {
      const name = scalarText(value);
      if (!name || validateElementName(name, []) !== null) {
        diagnostics.push({ code: 'EXTENSION_REGISTRATION_INVALID', message: `Непосредственная регистрация ${metadataType} содержит некорректное имя.` });
        continue;
      }
      registrations.push({ metadataType, name, qualifiedName: `${metadataType}.${name}` });
    }
  }
  const counts = new Map<string, number>();
  for (const registration of registrations) {
    const key = registration.qualifiedName.toLocaleLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [qualifiedName, count] of counts) {
    if (count > 1) {
      diagnostics.push({ code: 'EXTENSION_DUPLICATE_QUALIFIED_NAME', message: `Непосредственная регистрация ${qualifiedName} повторяется ${count} раз.`, qualifiedName });
    }
  }
  return registrations;
}

function readSingleElement(record: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const matches = Object.entries(record).filter(([key, value]) => !isXmlMetaKey(key) && localName(key) === name && value !== undefined);
  if (matches.length !== 1) {
    return undefined;
  }
  const value = unwrapOne(matches[0]![1]);
  return isRecord(value) ? value : undefined;
}

function countDirectElementOccurrences(record: Record<string, unknown>, name: string): number {
  return Object.entries(record).reduce((count, [key, value]) => {
    if (isXmlMetaKey(key) || localName(key) !== name) {
      return count;
    }
    return count + (Array.isArray(value) ? value.length : 1);
  }, 0);
}

function readSingleProperties(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const matches = Object.entries(record).filter(([key]) => !isXmlMetaKey(key) && localName(key) === 'Properties');
  if (matches.length !== 1) {
    return undefined;
  }
  const rawValue = matches[0]![1];
  if (Array.isArray(rawValue)) {
    if (rawValue.length !== 1) {
      return undefined;
    }
    const value = rawValue[0];
    if (isRecord(value)) {
      return value;
    }
    return isEmptyXmlElementValue(value) ? {} : undefined;
  }
  if (isRecord(rawValue)) {
    return rawValue;
  }
  return isEmptyXmlElementValue(rawValue) ? {} : undefined;
}

function isEmptyXmlElementValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function readSingleText(record: Record<string, unknown>, name: string): string | undefined {
  const matches = Object.entries(record).filter(([key, value]) => !isXmlMetaKey(key) && localName(key) === name && value !== undefined);
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length !== 1) {
    return undefined;
  }
  return scalarText(matches[0]![1]);
}

function readAttribute(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[`@_${name}`];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isNonZeroUuid(value: string | undefined): value is string {
  return value !== undefined
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
    && value.toLowerCase() !== '00000000-0000-0000-0000-000000000000';
}

function scalarText(value: unknown): string | undefined {
  const unwrapped = unwrapOne(value);
  if (typeof unwrapped === 'string') {
    const text = unwrapped.trim();
    return text || undefined;
  }
  if (!isRecord(unwrapped)) {
    return undefined;
  }
  const keys = Object.keys(unwrapped).filter((key) => !isXmlMetaKey(key));
  if (keys.some((key) => key !== '#text')) {
    return undefined;
  }
  const text = unwrapped['#text'];
  return typeof text === 'string' && text.trim() ? text.trim() : undefined;
}

function unwrapOne(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.length === 1 ? value[0] : undefined;
}

function flattenDirectory(snapshot: MergeSnapshotDirectory, baseRelativePath: string): ExtensionCapturedFile[] {
  const files: ExtensionCapturedFile[] = [];
  for (const child of snapshot.children) {
    // Snapshot child paths already include their ancestors relative to the
    // captured sidecar root, so add the object's sidecar prefix exactly once.
    const relativePath = `${baseRelativePath}/${child.relativePath.replace(/\\/g, '/')}`;
    if (child.type === 'file') {
      if (child.contentBase64 === undefined) {
        files.push({
          relativePath,
          hash: child.hash,
          ...(child.rootExpandedName ? { rootExpandedName: child.rootExpandedName } : {}),
        });
        continue;
      }
      files.push({
        relativePath,
        content: Buffer.from(child.contentBase64, 'base64'),
        hash: child.hash,
        ...(child.rootExpandedName ? { rootExpandedName: child.rootExpandedName } : {}),
      });
    } else {
      files.push(...flattenDirectory(child, baseRelativePath));
    }
  }
  return files;
}

async function hasCfeMarkerFile(rootPath: string, cancellation?: CompareCancellationToken): Promise<boolean> {
  for (const name of ['1cv8.cfe', 'ConfigurationExtension.xml']) {
    try {
      throwIfCompareCancelled(cancellation);
      const stat = await fs.lstat(path.join(rootPath, name));
      throwIfCompareCancelled(cancellation);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        return true;
      }
    } catch (error) {
      throwIfCompareCancelled(cancellation);
      rethrowIfCancelled(error);
      if (!isMissing(error)) {
        return true;
      }
    }
  }
  return false;
}

async function hasObjectCfeMarkers(rootPath: string, cancellation?: CompareCancellationToken): Promise<boolean> {
  // Root descriptors live directly in the known metadata folders. Recursing is limited to
  // metadata XML only so a missing Configuration.xml cannot silently fall through to CF mode.
  const typeFolders = new Set(METADATA_TYPE_DESCRIPTORS.map((descriptor) => descriptor.designerFolder));
  const descriptorPaths: string[] = [];
  for (const folder of typeFolders) {
    throwIfCompareCancelled(cancellation);
    const directory = path.join(rootPath, folder);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
      throwIfCompareCancelled(cancellation);
    } catch (error) {
      throwIfCompareCancelled(cancellation);
      rethrowIfCancelled(error);
      if (isMissing(error)) {
        continue;
      }
      return true;
    }
    for (const entry of entries) {
      throwIfCompareCancelled(cancellation);
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.xml') {
        continue;
      }
      descriptorPaths.push(path.join(directory, entry.name));
    }
  }

  let found = false;
  let cancellationError: unknown;
  let nextDescriptor = 0;
  const readWorker = async (): Promise<void> => {
    while (!found && cancellationError === undefined) {
      try {
        throwIfCompareCancelled(cancellation);
      } catch (error) {
        cancellationError = error;
        return;
      }
      const descriptorPath = descriptorPaths[nextDescriptor++];
      if (!descriptorPath) {return;}
      try {
        const content = await fs.readFile(descriptorPath);
        try {
          throwIfCompareCancelled(cancellation);
        } catch (error) {
          cancellationError = error;
          return;
        }
        if (CFE_MARKER_PATTERN.test(decodeXml(content))) {found = true;}
      } catch (error) {
        if (isConfigurationCompareCancelled(error)) {
          cancellationError = error;
        } else {
          try {
            throwIfCompareCancelled(cancellation);
          } catch (cancelled) {
            cancellationError = cancelled;
            return;
          }
          // An unreadable descriptor cannot establish that the root is an ordinary CF.
          found = true;
        }
        return;
      }
    }
  };
  const workerCount = Math.min(16, descriptorPaths.length);
  await Promise.all(Array.from({ length: workerCount }, () => readWorker()));
  if (cancellationError !== undefined) {throw cancellationError;}
  throwIfCompareCancelled(cancellation);
  return found;
}

function notifyProgress(
  callback: ((progress: CompareBuildProgress) => void) | undefined,
  progress: CompareBuildProgress,
): void {
  try {callback?.(progress);} catch { /* Progress observers cannot fail metadata indexing. */ }
}

function rethrowIfCancelled(error: unknown): void {
  if (isConfigurationCompareCancelled(error)) {throw error;}
}

function isXmlMetaKey(key: string): boolean {
  return key === ':@' || key === '@_' || key.startsWith('@_') || key.startsWith('#') || key.startsWith('?');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function decodeXml(content: Buffer): string {
  return content.toString('utf8').replace(/^\uFEFF/u, '');
}

function hash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeRootPath(value: string): string {
  const resolved = path.resolve(value);
  let end = resolved.length;
  while (end > 0 && isPathSeparator(resolved.charAt(end - 1))) {end -= 1;}
  const normalized = resolved.slice(0, end);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

function isPathSeparator(value: string): boolean {
  return value === '/' || value === '\\';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
