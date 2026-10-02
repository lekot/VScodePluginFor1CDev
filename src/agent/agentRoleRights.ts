import * as fs from 'fs';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { CONFIGURATION_XML } from '../constants/fileNames';
import { getMetadataTypeDescriptorByRootTag } from '../constants/metadataTypeDescriptors';
import { ConfigFormat } from '../parsers/formatDetector';
import { EdtParser } from '../parsers/edtParser';
import { MetadataType } from '../models/treeNode';
import {
  assertNoSymlinkSegments,
  assertPathWithinRoot,
} from '../services/configurationSession/pathBoundary';
import { hashContent } from '../services/configurationSession/atomicFileStorage';
import type { MutationExpectation, MutationPlan } from '../services/configurationSession/mutationPlan';
import { validateElementName } from '../utils/elementNameValidator';
import { XMLWriter } from '../utils/XMLWriter';
import { MetadataTypeMapper } from '../utils/metadataTypeMapper';
import {
  getSetForNewObjectsDefault,
  loadRightsXml,
  mergeNamedRightsIntoDom,
  serializeRightsDomToXml,
} from '../rolesEditor/rightsXmlEditWriter';
import { requireDocumentWriteFormatProfile } from '../utils/format/formatRank';
import type {
  AgentResult,
  AgentSetRoleRightsParams,
  AgentSetRoleRightsResult,
} from './types';

const COMMON_OBJECT_RIGHTS = [
  'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString',
  'InteractiveInsert', 'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark',
  'InteractiveDelete', 'InteractiveDeleteMarked', 'InteractiveDeletePredefinedData',
  'InteractiveSetDeletionMarkPredefinedData', 'InteractiveClearDeletionMarkPredefinedData',
  'InteractiveDeleteMarkedPredefinedData', 'ReadDataHistory', 'ViewDataHistory',
  'UpdateDataHistory', 'UpdateDataHistoryOfMissingData', 'ReadDataHistoryOfMissingData',
  'UpdateDataHistorySettings', 'UpdateDataHistoryVersionComment',
  'EditDataHistoryVersionComment', 'SwitchToDataHistoryVersion',
] as const;

const DOCUMENT_RIGHTS = [
  ...COMMON_OBJECT_RIGHTS.filter((right) => !right.endsWith('PredefinedData')),
  'Posting', 'UndoPosting', 'InteractivePosting', 'InteractivePostingRegular',
  'InteractiveUndoPosting', 'InteractiveChangeOfPosted',
] as const;

const ROOT_RIGHTS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  Configuration: [
    'Administration', 'DataAdministration', 'UpdateDataBaseConfiguration',
    'ConfigurationExtensionsAdministration', 'ActiveUsers', 'EventLog', 'ExclusiveMode',
    'ThinClient', 'ThickClient', 'WebClient', 'MobileClient', 'ExternalConnection',
    'Automation', 'Output', 'SaveUserData', 'TechnicalSpecialistMode',
    'InteractiveOpenExtDataProcessors', 'InteractiveOpenExtReports', 'AnalyticsSystemClient',
    'CollaborationSystemInfoBaseRegistration', 'MainWindowModeNormal',
    'MainWindowModeWorkplace', 'MainWindowModeEmbeddedWorkplace',
    'MainWindowModeFullscreenWorkplace', 'MainWindowModeKiosk',
  ],
  Catalog: COMMON_OBJECT_RIGHTS,
  Document: DOCUMENT_RIGHTS,
  InformationRegister: [
    'Read', 'Update', 'View', 'Edit', 'TotalsControl', 'ReadDataHistory', 'ViewDataHistory',
    'UpdateDataHistory', 'UpdateDataHistoryOfMissingData', 'ReadDataHistoryOfMissingData',
    'UpdateDataHistorySettings', 'UpdateDataHistoryVersionComment',
    'EditDataHistoryVersionComment', 'SwitchToDataHistoryVersion',
  ],
  AccumulationRegister: ['Read', 'Update', 'View', 'Edit', 'TotalsControl'],
  AccountingRegister: ['Read', 'Update', 'View', 'Edit', 'TotalsControl'],
  CalculationRegister: ['Read', 'View'],
  Constant: [
    'Read', 'Update', 'View', 'Edit', 'ReadDataHistory', 'ViewDataHistory', 'UpdateDataHistory',
    'UpdateDataHistorySettings', 'UpdateDataHistoryVersionComment', 'EditDataHistoryVersionComment',
    'SwitchToDataHistoryVersion',
  ],
  ChartOfAccounts: [
    'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'InteractiveInsert',
    'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark', 'InteractiveDelete',
    'InteractiveDeletePredefinedData', 'InteractiveSetDeletionMarkPredefinedData',
    'InteractiveClearDeletionMarkPredefinedData', 'InteractiveDeleteMarkedPredefinedData',
    'ReadDataHistory', 'ReadDataHistoryOfMissingData', 'UpdateDataHistory',
    'UpdateDataHistoryOfMissingData', 'UpdateDataHistorySettings',
    'UpdateDataHistoryVersionComment',
  ],
  ChartOfCharacteristicTypes: [
    'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'InteractiveInsert',
    'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark', 'InteractiveDelete',
    'InteractiveDeletePredefinedData', 'InteractiveSetDeletionMarkPredefinedData',
    'InteractiveClearDeletionMarkPredefinedData', 'InteractiveDeleteMarkedPredefinedData',
    'ReadDataHistory', 'ReadDataHistoryOfMissingData', 'UpdateDataHistory',
    'UpdateDataHistoryOfMissingData', 'UpdateDataHistorySettings',
    'UpdateDataHistoryVersionComment', 'InteractiveDeleteMarked', 'EditDataHistoryVersionComment',
    'SwitchToDataHistoryVersion', 'ViewDataHistory',
  ],
  ChartOfCalculationTypes: [
    'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'InteractiveInsert',
    'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark', 'InteractiveDelete',
    'InteractiveDeletePredefinedData', 'InteractiveSetDeletionMarkPredefinedData',
    'InteractiveClearDeletionMarkPredefinedData', 'InteractiveDeleteMarkedPredefinedData',
  ],
  ExchangePlan: [
    'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'InteractiveInsert',
    'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark', 'InteractiveDelete',
    'InteractiveDeleteMarked', 'ReadDataHistory', 'ViewDataHistory', 'UpdateDataHistory',
    'ReadDataHistoryOfMissingData', 'UpdateDataHistoryOfMissingData', 'UpdateDataHistorySettings',
    'UpdateDataHistoryVersionComment', 'EditDataHistoryVersionComment', 'SwitchToDataHistoryVersion',
  ],
  BusinessProcess: [
    'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'Start',
    'InteractiveInsert', 'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark',
    'InteractiveDelete', 'InteractiveActivate', 'InteractiveStart',
  ],
  Task: [
    'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'Execute',
    'InteractiveInsert', 'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark',
    'InteractiveDelete', 'InteractiveActivate', 'InteractiveExecute',
  ],
  DataProcessor: ['Use', 'View'],
  Report: ['Use', 'View'],
  CommonForm: ['View'],
  CommonCommand: ['View'],
  Subsystem: ['View'],
  FilterCriterion: ['View'],
  DocumentJournal: ['Read', 'View'],
  Sequence: ['Read', 'Update'],
  WebService: ['Use'],
  HTTPService: ['Use'],
  IntegrationService: ['Use'],
  SessionParameter: ['Get', 'Set'],
  CommonAttribute: ['View', 'Edit'],
  ExternalDataSource: [
    'Use', 'Administration', 'StandardAuthenticationChange',
    'SessionStandardAuthenticationChange', 'SessionOSAuthenticationChange',
  ],
};

const INTERACTIVE_DELETE_RIGHTS = new Set([
  'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark', 'InteractiveDelete',
  'InteractiveDeleteMarked', 'InteractiveDeletePredefinedData',
  'InteractiveSetDeletionMarkPredefinedData', 'InteractiveClearDeletionMarkPredefinedData',
  'InteractiveDeleteMarkedPredefinedData',
]);
const POST_RIGHTS = ['Posting', 'UndoPosting', 'InteractivePosting', 'InteractiveUndoPosting'] as const;

export type RoleRightsErrorCode =
  | 'INVALID_ROLE_RIGHTS_DSL'
  | 'INVALID_ROLE_RIGHTS_OBJECT'
  | 'UNSUPPORTED_ROLE_RIGHT'
  | 'UNSUPPORTED_ROLE_PRESET'
  | 'ROLE_NOT_FOUND'
  | 'ROLE_RIGHTS_OBJECT_NOT_FOUND'
  | 'ROLE_RIGHTS_METADATA_INVALID'
  | 'UNSUPPORTED_ROLE_FORMAT';

export class AgentRoleRightsError extends Error {
  constructor(readonly code: RoleRightsErrorCode, message: string) {
    super(message);
    this.name = 'AgentRoleRightsError';
  }
}

export interface ParsedRoleRightsEntry {
  readonly type: string;
  readonly name: string;
  readonly objectName: string;
  readonly rights: Readonly<Record<string, boolean>>;
}

function fail(code: RoleRightsErrorCode, message: string): never {
  throw new AgentRoleRightsError(code, message);
}

function selectedRights(type: string, definition: string): Set<string> {
  const allowed = ROOT_RIGHTS_BY_TYPE[type];
  if (!allowed) {
    return fail('INVALID_ROLE_RIGHTS_OBJECT', `Тип объекта «${type}» не поддерживает права ролей.`);
  }
  const known = new Set(allowed);
  const value = definition.trim();
  if (value.startsWith('@')) {
    if (value.includes(',')) {
      return fail('INVALID_ROLE_RIGHTS_DSL', 'Пресет должен быть единственным значением после двоеточия.');
    }
    if (value === '@view') {
      const selected = new Set(['Read', 'View', 'InputByString'].filter((right) => known.has(right)));
      if (known.has('Use')) {selected.add('Use');}
      return selected;
    }
    if (value === '@edit') {
      const selected = selectedRights(type, '@view');
      for (const right of [
        'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InteractiveInsert', 'InputByString',
      ]) {
        if (known.has(right)) {selected.add(right);}
      }
      for (const right of INTERACTIVE_DELETE_RIGHTS) {
        if (known.has(right)) {selected.add(right);}
      }
      return selected;
    }
    if (value === '@post') {
      if (type !== 'Document') {
        return fail('UNSUPPORTED_ROLE_PRESET', 'Пресет @post применим только к объектам типа Document.');
      }
      const selected = selectedRights(type, '@edit');
      for (const right of POST_RIGHTS) {selected.add(right);}
      return selected;
    }
    if (value === '@admin') {
      return new Set(allowed);
    }
    return fail('UNSUPPORTED_ROLE_PRESET', `Неизвестный пресет прав «${value}».`);
  }

  const values = value.split(',').map((right) => right.trim());
  if (values.some((right) => right.length === 0)) {
    return fail('INVALID_ROLE_RIGHTS_DSL', 'Список прав содержит пустое значение.');
  }
  const duplicates = values.filter((right, index) => values.indexOf(right) !== index);
  if (duplicates.length > 0) {
    return fail('INVALID_ROLE_RIGHTS_DSL', `Право «${duplicates[0]}» указано повторно.`);
  }
  for (const right of values) {
    if (right.startsWith('@')) {
      return fail('UNSUPPORTED_ROLE_PRESET', `Неизвестный пресет прав «${right}».`);
    }
    if (!known.has(right)) {
      return fail('UNSUPPORTED_ROLE_RIGHT', `Право «${right}» не применимо к типу «${type}».`);
    }
  }
  return new Set(values);
}

/** Compile DSL entries against the full role-rights allowlist. */
export function compileRoleRightsDsl(entries: readonly string[]): ParsedRoleRightsEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    return fail('INVALID_ROLE_RIGHTS_DSL', 'Нужно указать хотя бы один объект прав.');
  }
  const seenObjects = new Set<string>();
  return entries.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      return fail('INVALID_ROLE_RIGHTS_DSL', 'Строка объекта прав не может быть пустой.');
    }
    const separator = entry.indexOf(':');
    if (separator < 0 || entry.indexOf(':', separator + 1) >= 0) {
      return fail('INVALID_ROLE_RIGHTS_DSL', `Ожидается формат «Тип.Имя: права»: ${entry.trim()}`);
    }
    const objectPath = entry.slice(0, separator).trim();
    const definition = entry.slice(separator + 1).trim();
    const segments = objectPath.split('.').map((segment) => segment.trim());
    if (segments.length !== 2 || segments.some((segment) => !segment)) {
      return fail('INVALID_ROLE_RIGHTS_DSL', `Ожидается объект верхнего уровня «Тип.Имя»: ${objectPath}`);
    }
    const [type, name] = segments as [string, string];
    if (!ROOT_RIGHTS_BY_TYPE[type]) {
      return fail('INVALID_ROLE_RIGHTS_OBJECT', `Тип объекта «${type}» не поддерживает права ролей.`);
    }
    if (validateElementName(name, [])) {
      return fail('INVALID_ROLE_RIGHTS_OBJECT', `Некорректное имя объекта «${name}».`);
    }
    const identity = `${type}.${name}`.toLocaleLowerCase();
    if (seenObjects.has(identity)) {
      return fail('INVALID_ROLE_RIGHTS_DSL', `Объект «${type}.${name}» указан повторно.`);
    }
    seenObjects.add(identity);
    const selected = selectedRights(type, definition);
    const rights: Record<string, boolean> = {};
    for (const right of ROOT_RIGHTS_BY_TYPE[type]!) {
      rights[right] = selected.has(right);
    }
    return { type, name, objectName: `${type}.${name}`, rights };
  });
}

const METADATA_XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: true,
});

function localName(name: string): string {
  return name.includes(':') ? name.split(':').pop()! : name;
}

function fieldValue(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {return undefined;}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (localName(key) === name) {return child;}
  }
  return undefined;
}

function textValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {return String(value).trim();}
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = textValue(item);
      if (text) {return text;}
    }
    return '';
  }
  if (value && typeof value === 'object') {
    const text = (value as Record<string, unknown>)['#text'];
    return text === undefined ? '' : String(text).trim();
  }
  return '';
}

function readConfigurationObjects(xml: string): Map<string, Set<string>> {
  const parsed = METADATA_XML_PARSER.parse(xml) as Record<string, unknown>;
  const metaDataObject = fieldValue(parsed, 'MetaDataObject');
  const configuration = fieldValue(metaDataObject, 'Configuration');
  const childObjects = fieldValue(configuration, 'ChildObjects');
  if (!childObjects || typeof childObjects !== 'object' || Array.isArray(childObjects)) {
    return fail('ROLE_RIGHTS_METADATA_INVALID', 'Configuration.xml не содержит ChildObjects.');
  }
  const result = new Map<string, Set<string>>();
  for (const [type, rawObjects] of Object.entries(childObjects as Record<string, unknown>)) {
    const names = new Set<string>();
    const candidates = Array.isArray(rawObjects) ? rawObjects : [rawObjects];
    for (const candidate of candidates) {
      const name = textValue(candidate);
      if (name) {names.add(name);}
    }
    result.set(localName(type), names);
  }
  return result;
}

function getConfigurationName(xml: string): string {
  const parsed = METADATA_XML_PARSER.parse(xml) as Record<string, unknown>;
  const configuration = fieldValue(fieldValue(parsed, 'MetaDataObject'), 'Configuration');
  const properties = fieldValue(configuration, 'Properties');
  return textValue(fieldValue(properties, 'Name'));
}

async function expandCommandRights(
  configRoot: string,
  format: ConfigFormat,
  entries: readonly ParsedRoleRightsEntry[],
  assignments: Record<string, Record<string, boolean>>,
): Promise<void> {
  for (const entry of entries) {
    if (entry.type === 'Configuration') {continue;}
    const metadataPath = format === ConfigFormat.EDT
      ? (() => {
        const descriptor = getMetadataTypeDescriptorByRootTag(entry.type);
        if (!descriptor) {
          return fail('ROLE_RIGHTS_METADATA_INVALID', `Тип «${entry.type}» не имеет EDT metadata descriptor.`);
        }
        return path.join(configRoot, 'src', descriptor.edtFolder, entry.name, descriptor.edtFileName);
      })()
      : path.join(
        configRoot,
        MetadataTypeMapper.getDesignerFolderIdForMetadataType(entry.type as MetadataType) ?? `${entry.type}s`,
        `${entry.name}.xml`,
      );
    let xml: string;
    try {
      xml = (await readContainedFile(configRoot, metadataPath, 'ROLE_RIGHTS_METADATA_INVALID')).toString('utf8');
    } catch {
      return fail('ROLE_RIGHTS_METADATA_INVALID', `Не удалось прочитать метаданные «${entry.objectName}».`);
    }
    try {
      requireDocumentWriteFormatProfile(xml);
      const commands = await XMLWriter.listNestedElementNames(metadataPath, 'Command');
      for (const commandName of commands) {
        assignments[`${entry.objectName}.Command.${commandName}`] = {
          View: Boolean(entry.rights.View),
        };
      }
    } catch {
      return fail('ROLE_RIGHTS_METADATA_INVALID', `Не удалось проверить дочерние метаданные «${entry.objectName}».`);
    }
  }
}

interface ElementRange {
  readonly start: number;
  readonly openEnd: number;
  readonly closeStart: number;
  readonly end: number;
  readonly parentName?: string;
}

interface OpenElement {
  readonly name: string;
  readonly start: number;
  readonly openEnd: number;
  readonly parentName?: string;
}

function findElementRange(xml: string, target: string, directParent?: string): ElementRange | undefined {
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<[^>]+>/g;
  const stack: OpenElement[] = [];
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(xml)) !== null) {
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<![CDATA[') || token.startsWith('<?') || token.startsWith('<!')) {
      continue;
    }
    const close = /^<\s*\/\s*([^\s>]+)/.exec(token);
    if (close) {
      const closingName = close[1]!;
      let opened: OpenElement | undefined;
      while (stack.length > 0) {
        const candidate = stack.pop()!;
        if (candidate.name === closingName) {
          opened = candidate;
          break;
        }
      }
      if (opened && localName(opened.name) === target
        && (!directParent || localName(opened.parentName ?? '') === directParent)) {
        return {
          start: opened.start,
          openEnd: opened.openEnd,
          closeStart: match.index,
          end: tokens.lastIndex,
          parentName: opened.parentName,
        };
      }
      continue;
    }
    const open = /^<\s*([^\s/>]+)/.exec(token);
    if (!open) {continue;}
    const name = open[1]!;
    if (/\/\s*>$/.test(token)) {continue;}
    stack.push({
      name,
      start: match.index,
      openEnd: tokens.lastIndex,
      parentName: stack[stack.length - 1]?.name,
    });
  }
  return undefined;
}

async function readContainedFile(root: string, target: string, missingCode: RoleRightsErrorCode): Promise<Buffer> {
  let canonical: { canonicalRoot: string; canonicalTarget: string };
  try {
    canonical = await assertPathWithinRoot(root, target);
    await assertNoSymlinkSegments(canonical.canonicalRoot, canonical.canonicalTarget);
    const stat = await fs.promises.lstat(canonical.canonicalTarget);
    if (!stat.isFile() || stat.isSymbolicLink()) {throw new Error('not a regular file');}
    return await fs.promises.readFile(canonical.canonicalTarget);
  } catch {
    return fail(missingCode, 'Не удалось безопасно прочитать файл метаданных роли.');
  }
}

async function listConfigurationObjects(
  configRoot: string,
  format: ConfigFormat,
  requestedTypes: readonly string[],
): Promise<{ objects: Map<string, Set<string>>; name: string }> {
  const configPath = format === ConfigFormat.EDT
    ? path.join(configRoot, 'src', 'Configuration', 'Configuration.mdo')
    : path.join(configRoot, CONFIGURATION_XML);
  const bytes = await readContainedFile(configRoot, configPath, 'ROLE_RIGHTS_METADATA_INVALID');
  try {
    const xml = bytes.toString('utf8');
    requireDocumentWriteFormatProfile(xml);
    const name = getConfigurationName(xml);
    if (!name) {
      return fail('ROLE_RIGHTS_METADATA_INVALID', 'Метаданные конфигурации не содержат Properties.Name.');
    }
    let objects: Map<string, Set<string>>;
    if (format === ConfigFormat.EDT) {
      objects = new Map([['Configuration', new Set([name])]]);
      for (const type of new Set(['Role', ...requestedTypes])) {
        if (type === 'Configuration') {continue;}
        const descriptor = getMetadataTypeDescriptorByRootTag(type);
        if (!descriptor) {
          return fail('ROLE_RIGHTS_METADATA_INVALID', `Тип «${type}» не имеет EDT metadata descriptor.`);
        }
        const indexed = await EdtParser.parseTypeIndex(configRoot, descriptor.edtFolder);
        objects.set(type, new Set(indexed.map((node) => node.name)));
      }
    } else {
      objects = readConfigurationObjects(xml);
    }
    return { objects, name };
  } catch (error) {
    if (error instanceof AgentRoleRightsError) {throw error;}
    return fail('ROLE_RIGHTS_METADATA_INVALID', 'Метаданные конфигурации не прошли проверку формата.');
  }
}

async function verifyRoleAndObjects(
  configRoot: string,
  format: ConfigFormat,
  roleName: string,
  entries: readonly ParsedRoleRightsEntry[],
): Promise<{ rolePath: string; version: string }> {
  if (format !== ConfigFormat.EDT && format !== ConfigFormat.Designer) {
    return fail('UNSUPPORTED_ROLE_FORMAT', 'Запись прав поддерживает только форматы EDT и Designer.');
  }
  const rolePath = format === ConfigFormat.EDT
    ? path.join(configRoot, 'src', 'Roles', roleName, 'Role.mdo')
    : path.join(configRoot, 'Roles', `${roleName}.xml`);
  const roleXml = await readContainedFile(configRoot, rolePath, 'ROLE_NOT_FOUND');
  let version: string;
  try {
    const profile = requireDocumentWriteFormatProfile(roleXml.toString('utf8'));
    version = profile.version;
  } catch {
    return fail('ROLE_RIGHTS_METADATA_INVALID', 'Файл роли не прошёл проверку формата.');
  }
  if (format === ConfigFormat.Designer && !findElementRange(roleXml.toString('utf8'), 'Role')) {
    return fail('ROLE_RIGHTS_METADATA_INVALID', 'Role.xml не содержит элемент Role.');
  }

  const configuration = await listConfigurationObjects(configRoot, format, entries.map((entry) => entry.type));
  const roleNames = configuration.objects.get('Role');
  if (!roleNames?.has(roleName)) {
    return fail('ROLE_NOT_FOUND', `Роль «${roleName}» не зарегистрирована в метаданных конфигурации.`);
  }
  for (const entry of entries) {
    const exists = entry.type === 'Configuration'
      ? entry.name === configuration.name
      : configuration.objects.get(entry.type)?.has(entry.name) ?? false;
    if (!exists) {
      return fail('ROLE_RIGHTS_OBJECT_NOT_FOUND', `Объект «${entry.objectName}» отсутствует в конфигурации.`);
    }
  }
  return { rolePath, version };
}

function pathExpectation(source: Buffer): MutationExpectation {
  return { state: 'file', hash: hashContent(source) };
}

function relativePath(configRoot: string, targetPath: string): string {
  return path.relative(configRoot, targetPath).split(path.sep).join('/');
}

function buildAssignments(
  entries: readonly ParsedRoleRightsEntry[],
): Record<string, Record<string, boolean>> {
  return Object.fromEntries(entries.map((entry) => [entry.objectName, { ...entry.rights }]));
}

/** Build a rollback-capable plan for replacing selected role object rights. */
export async function planSetRoleRights(
  configRoot: string,
  format: ConfigFormat,
  params: AgentSetRoleRightsParams,
): Promise<MutationPlan<AgentResult<AgentSetRoleRightsResult>>> {
  if (!params || typeof params !== 'object' || typeof params.roleName !== 'string'
    || validateElementName(params.roleName, []) || !Array.isArray(params.objects)) {
    return fail('INVALID_ROLE_RIGHTS_DSL', 'Переданы некорректные параметры записи прав роли.');
  }
  const entries = compileRoleRightsDsl(params.objects);
  const { rolePath, version } = await verifyRoleAndObjects(
    configRoot,
    format,
    params.roleName,
    entries,
  );
  const assignments = buildAssignments(entries);
  await expandCommandRights(configRoot, format, entries, assignments);

  const rightsPath = format === ConfigFormat.EDT
    ? path.join(path.dirname(rolePath), 'Ext', 'Rights.xml')
    : path.join(configRoot, 'Roles', params.roleName, 'Ext', 'Rights.xml');
  const rightsPathBoundary = await assertPathWithinRoot(configRoot, rightsPath);
  const rightsStat = await fs.promises.lstat(rightsPathBoundary.canonicalTarget).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {return undefined;}
    throw error;
  });
  let original: Buffer | undefined;
  if (rightsStat) {
    if (!rightsStat.isFile() || rightsStat.isSymbolicLink()) {
      return fail('ROLE_RIGHTS_METADATA_INVALID', 'Rights.xml должен быть обычным файлом.');
    }
    const safePath = await assertPathWithinRoot(configRoot, rightsPath);
    await assertNoSymlinkSegments(safePath.canonicalRoot, safePath.canonicalTarget);
    original = await fs.promises.readFile(safePath.canonicalTarget);
  }
  let dom: Awaited<ReturnType<typeof loadRightsXml>>;
  try {
    dom = await loadRightsXml(rightsPath, version);
  } catch {
    return fail('ROLE_RIGHTS_METADATA_INVALID', 'Rights.xml содержит некорректные метаданные XML.');
  }
  const setForNewObjects = getSetForNewObjectsDefault(dom);
  for (const [objectName, objectRights] of Object.entries(assignments)) {
    const isRootObject = objectName.split('.').length === 2;
    mergeNamedRightsIntoDom(dom, { [objectName]: objectRights }, {
      compactWrite: true,
      defaultValue: isRootObject ? setForNewObjects : false,
    });
  }
  const updated = serializeRightsDomToXml(dom, version);
  const steps = [] as MutationPlan<AgentResult<AgentSetRoleRightsResult>>['steps'][number][];
  if (!rightsStat) {
    steps.push({ type: 'ensureDirectory', targetPath: path.dirname(rightsPath) });
  }
  steps.push({
    type: 'writeFile',
    targetPath: rightsPath,
    content: updated,
    encoding: 'utf8',
    expected: original ? pathExpectation(original) : { state: 'missing' },
  });
  return {
    kind: 'agent.roles.setRights',
    steps,
    result: {
      success: true,
      data: {
        roleName: params.roleName,
        objectsAffected: Object.keys(assignments).length,
        files: [relativePath(configRoot, rightsPath)],
      },
    },
  };
}
