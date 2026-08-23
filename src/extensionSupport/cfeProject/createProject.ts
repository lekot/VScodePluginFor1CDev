import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { assertNoSymlinkSegments, assertPathWithinRoot, validateWorkspaceRelativePath } from '../../services/configurationSession/pathBoundary';
import { validateElementName } from '../../utils/elementNameValidator';
import type { WorkspaceRegistry } from '../../services/configurationSession/WorkspaceRegistry';
import { CfeProjectManifestStorage } from './manifest';
import { CfeBorrowService } from './borrowObject';
import { CfeProjectRegistry } from './registry';
import {
  CfeProjectError,
  type CfeBorrowObjectOutcome,
  type CfeBorrowObjectRequest,
  type CfeCreateProjectOutcome,
  type CfeCreateProjectRequest,
  type CfeProjectManifestRecord,
} from './types';

const SUPPORTED_FORMATS = new Set(['2.17', '2.18', '2.19', '2.20', '2.21']);
const CONTAINED_OBJECT_CLASS_IDS = [
  '9cd510cd-abfc-11d4-9434-004095e12fc7',
  '9fcd25a0-4822-11d4-9414-008048da11f9',
  'e3687481-0a87-462c-a166-9f34594f9bba',
  '9de14907-ec23-4a07-96f0-85521cb6b53b',
  '51f2d5d8-ea4d-4064-8892-82951750031e',
  'e68182ea-4237-4383-967f-90c1e3370bc7',
  'fb282519-d103-4dd3-bc12-cb271d631dfc',
] as const;
const XML_NAMESPACES = 'xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform"';
const XML_NAMESPACES_AFTER_PALETTE = 'xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';

export interface CfeProjectServiceOptions {
  /** Refreshes WorkspaceRegistry discovery after a successful manifest upsert. */
  readonly refreshWorkspace?: () => Promise<void>;
  /** Dependency seams are used by recovery tests and keep recovery behavior deterministic. */
  readonly manifestStorage?: CfeProjectManifestStorage;
  readonly removePublishedDirectory?: (workspaceRoot: string, target: string) => Promise<unknown | undefined>;
}

/** Application boundary for the first CFE vertical: scaffold plus durable relation. */
export class CfeProjectService {
  readonly projects: CfeProjectRegistry;
  readonly borrow: CfeBorrowService;

  constructor(
    readonly workspaceRoot: string,
    private readonly workspaceRegistry: WorkspaceRegistry,
    private readonly options: CfeProjectServiceOptions = {},
  ) {
    this.projects = new CfeProjectRegistry(workspaceRoot, workspaceRegistry, options.manifestStorage);
    this.borrow = new CfeBorrowService(this.projects);
  }

  async listProjects() { return this.projects.list(); }
  async getContext(baseConfigurationId: string) { return this.projects.getByBase(baseConfigurationId); }
  async getContextByExtension(extensionConfigurationId: string) { return this.projects.getByExtension(extensionConfigurationId); }
  async validate(): Promise<void> { await this.projects.list(); }
  async borrowObject(request: CfeBorrowObjectRequest): Promise<CfeBorrowObjectOutcome> {
    return this.borrow.borrowObject(request);
  }

  async createProject(request: CfeCreateProjectRequest): Promise<CfeCreateProjectOutcome> {
    const baseSession = this.workspaceRegistry.require(request.baseConfigurationId);
    const outcome = await baseSession.runExclusive({
      kind: 'cfe.createProject',
      execute: async () => this.createInBaseSession(baseSession.identity.rootPath, request),
    });
    if (outcome.status === 'committed') {
      return outcome.value;
    }
    if (outcome.status === 'failed' && outcome.error instanceof CfeProjectError) {
      throw outcome.error;
    }
    const error = outcome.status === 'failed' || outcome.status === 'conflict' ? outcome.error : undefined;
    throw new CfeProjectError('CFE_VALIDATION_FAILED', error?.message ?? 'Не удалось создать CFE-проект.');
  }

  private async createInBaseSession(baseRoot: string, request: CfeCreateProjectRequest): Promise<CfeCreateProjectOutcome> {
    const workspaceRoot = await fs.promises.realpath(this.workspaceRoot);
    const baseRelative = workspaceRelative(workspaceRoot, baseRoot);
    const baseXml = await fs.promises.readFile(path.join(baseRoot, 'Configuration.xml'), 'utf8');
    const formatVersion = attribute(baseXml, 'MetaDataObject', 'version');
    if (!formatVersion || !SUPPORTED_FORMATS.has(formatVersion)) {
      throw new CfeProjectError('CFE_UNSUPPORTED_FORMAT', 'Поддерживаются только Designer XML форматов 2.17–2.21.');
    }
    const extensionName = validateExtensionName(request.extensionName);
    const purpose = validatePurpose(request.purpose);
    const namePrefix = normalizeNamePrefix(request.namePrefix, extensionName);
    const compatibilityMode = validateCompatibilityMode(request.compatibilityMode);
    const targetRelative = request.target !== undefined
      ? validateTargetPath(request.target)
      : `${baseRelative ? `${baseRelative}/` : ''}ConfigurationExtensions/${extensionName}`;
    const target = await assertPathWithinRoot(workspaceRoot, path.join(workspaceRoot, targetRelative));
    await assertNoSymlinkSegments(target.canonicalRoot, target.canonicalTarget);
    if (await exists(target.canonicalTarget)) {
      throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Каталог CFE-проекта уже существует.');
    }
    const language = await readDefaultLanguage(baseRoot, baseXml);
    const staging = path.join(path.dirname(target.canonicalTarget), `.${path.basename(target.canonicalTarget)}.${randomUUID()}.staging`);
    let published = false;
    try {
      await fs.promises.mkdir(path.dirname(staging), { recursive: true });
      await assertNoSymlinkSegments(target.canonicalRoot, target.canonicalTarget);
      await fs.promises.mkdir(staging, { recursive: false });
      await writeScaffold(staging, {
        formatVersion, extensionName, purpose, namePrefix, compatibilityMode, language,
        scriptVariant: readValidatedBaseValue(baseXml, 'ScriptVariant', 'Russian'),
        interfaceCompatibilityMode: readValidatedBaseValue(baseXml, 'InterfaceCompatibilityMode', 'TaxiEnableVersion8_2'),
        includeDefaultRole: request.includeDefaultRole === true,
      });
      await validateScaffold(staging, formatVersion, language.name);
      await assertNoSymlinkSegments(target.canonicalRoot, target.canonicalTarget);
      await fs.promises.rename(staging, target.canonicalTarget);
      published = true;
      const record: CfeProjectManifestRecord = {
        baseConfiguration: baseRelative,
        extensionConfiguration: targetRelative,
        extensionName,
      };
      try {
        await this.projects.manifest.upsert(record);
      } catch (error) {
        const rollbackError = await (this.options.removePublishedDirectory ?? removePublishedDirectory)(workspaceRoot, target.canonicalTarget);
        if (rollbackError) {
          const journalPath = await writeRecoveryJournal(workspaceRoot, record, error, rollbackError);
          return { status: 'outcome-unknown', code: 'CFE_OUTCOME_UNKNOWN', recoveryJournalPath: journalPath };
        }
        throw error;
      }
      // Discovery is a cache refresh; persistence and publication are already complete.
      await this.options.refreshWorkspace?.().catch(() => undefined);
      const context = await this.projects.findByPaths(baseRoot, target.canonicalTarget).catch(() => undefined);
      return { status: 'created', context };
    } finally {
      if (!published) {
        await fs.promises.rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      }
    }
  }
}

interface SourceLanguage { readonly name: string; readonly uuid: string; readonly code: string; }
interface ScaffoldRequest {
  readonly formatVersion: string;
  readonly extensionName: string;
  readonly purpose: CfeCreateProjectRequest['purpose'];
  readonly namePrefix: string;
  readonly compatibilityMode: string;
  readonly language: SourceLanguage;
  readonly scriptVariant: string;
  readonly interfaceCompatibilityMode: string;
  readonly includeDefaultRole: boolean;
}

async function readDefaultLanguage(baseRoot: string, baseXml: string): Promise<SourceLanguage> {
  const defaultLanguage = element(baseXml, 'DefaultLanguage')?.replace(/^Language\./, '');
  if (!defaultLanguage || validateElementName(defaultLanguage, []) !== null) {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'В основной конфигурации не задан язык по умолчанию.');
  }
  const xml = await fs.promises.readFile(path.join(baseRoot, 'Languages', `${defaultLanguage}.xml`), 'utf8');
  const uuid = attribute(xml, 'Language', 'uuid');
  if (!uuid || !isUuid(uuid)) {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Не удалось определить UUID языка основной конфигурации.');
  }
  const code = element(xml, 'LanguageCode');
  if (!code || !/^[a-z]{2,3}(-[A-Z]{2})?$/u.test(code)) {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Язык основной конфигурации содержит некорректный LanguageCode.');
  }
  return { name: defaultLanguage, uuid, code };
}

async function writeScaffold(root: string, request: ScaffoldRequest): Promise<void> {
  const roleName = `${request.namePrefix || `${request.extensionName}_`}ОсновнаяРоль`;
  const roleSection = request.includeDefaultRole ? `<DefaultRoles><xr:Item xsi:type="xr:MDObjectRef">Role.${xml(roleName)}</xr:Item></DefaultRoles>` : '<DefaultRoles/>';
  const childRole = request.includeDefaultRole ? `<Role>${xml(roleName)}</Role>` : '';
  const captions = request.formatVersion === '2.21' ? '<Caption/><ShortCaption/>' : '';
  const configurationXml = `<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject ${xmlNamespaces(request.formatVersion)} version="${request.formatVersion}">\n<Configuration uuid="${randomUUID()}"><InternalInfo>${containedObjects()}</InternalInfo><Properties><ObjectBelonging>Adopted</ObjectBelonging><Name>${xml(request.extensionName)}</Name><Synonym><v8:item><v8:lang>${xml(request.language.code)}</v8:lang><v8:content>${xml(request.extensionName)}</v8:content></v8:item></Synonym><Comment/><ConfigurationExtensionPurpose>${request.purpose}</ConfigurationExtensionPurpose><KeepMappingToExtendedConfigurationObjectsByIDs>true</KeepMappingToExtendedConfigurationObjectsByIDs><NamePrefix>${xml(request.namePrefix)}</NamePrefix><ConfigurationExtensionCompatibilityMode>${xml(request.compatibilityMode)}</ConfigurationExtensionCompatibilityMode><DefaultRunMode>ManagedApplication</DefaultRunMode><UsePurposes><v8:Value xsi:type="app:ApplicationUsePurpose">PlatformApplication</v8:Value></UsePurposes><ScriptVariant>${xml(request.scriptVariant)}</ScriptVariant>${roleSection}<Vendor/><Version/>${captions}<DefaultLanguage>Language.${xml(request.language.name)}</DefaultLanguage><BriefInformation/><DetailedInformation/><Copyright/><VendorInformationAddress/><ConfigurationInformationAddress/><InterfaceCompatibilityMode>${xml(request.interfaceCompatibilityMode)}</InterfaceCompatibilityMode></Properties><ChildObjects><Language>${xml(request.language.name)}</Language>${childRole}</ChildObjects></Configuration>\n</MetaDataObject>\n`;
  const languageXml = `<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject ${xmlNamespaces(request.formatVersion)} version="${request.formatVersion}"><Language uuid="${randomUUID()}"><InternalInfo/><Properties><ObjectBelonging>Adopted</ObjectBelonging><Name>${xml(request.language.name)}</Name><Comment/><ExtendedConfigurationObject>${xml(request.language.uuid)}</ExtendedConfigurationObject><LanguageCode>${xml(request.language.code)}</LanguageCode></Properties></Language></MetaDataObject>\n`;
  await fs.promises.mkdir(path.join(root, 'Languages'));
  await writeXmlFile(path.join(root, 'Configuration.xml'), configurationXml);
  await writeXmlFile(path.join(root, 'Languages', `${request.language.name}.xml`), languageXml);
  if (request.includeDefaultRole) {
    await fs.promises.mkdir(path.join(root, 'Roles'));
    const roleXml = `<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject ${xmlNamespaces(request.formatVersion)} version="${request.formatVersion}"><Role uuid="${randomUUID()}"><Properties><Name>${xml(roleName)}</Name><Synonym/><Comment/></Properties></Role></MetaDataObject>\n`;
    await writeXmlFile(path.join(root, 'Roles', `${roleName}.xml`), roleXml);
  }
}

async function validateScaffold(root: string, formatVersion: string, languageName: string): Promise<void> {
  const [configurationXml, languageXml] = await Promise.all([
    fs.promises.readFile(path.join(root, 'Configuration.xml'), 'utf8'),
    fs.promises.readFile(path.join(root, 'Languages', `${languageName}.xml`), 'utf8'),
  ]);
  const contained = configurationXml.match(/<xr:ContainedObject>/g) ?? [];
  const containedClassIds = [...configurationXml.matchAll(/<xr:ClassId>([^<]+)<\/xr:ClassId>/g)].map((match) => match[1]);
  const containedObjectIds = configurationXml.match(/<xr:ObjectId>[\s\S]*?<\/xr:ObjectId>/g) ?? [];
  const hasPalette = /xmlns:pal="http:\/\/v8\.1c\.ru\/8\.1\/data\/ui\/colors\/palette"/.test(configurationXml);
  const hasCaptions = /<Caption\/><ShortCaption\/>/.test(configurationXml);
  if (attribute(configurationXml, 'MetaDataObject', 'version') !== formatVersion
    || !attribute(configurationXml, 'Configuration', 'uuid')
    || element(configurationXml, 'ObjectBelonging') !== 'Adopted'
    || !element(configurationXml, 'ConfigurationExtensionPurpose')
    || contained.length !== 7 || containedObjectIds.length !== 7
    || containedClassIds.length !== CONTAINED_OBJECT_CLASS_IDS.length
    || containedClassIds.some((classId, index) => classId !== CONTAINED_OBJECT_CLASS_IDS[index])
    || (formatVersion === '2.21' && (!hasPalette || !hasCaptions))
    || (formatVersion !== '2.21' && (hasPalette || hasCaptions))
    || !attribute(languageXml, 'Language', 'uuid')
    || !element(languageXml, 'ExtendedConfigurationObject')) {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Сгенерированный CFE-проект не прошёл структурную проверку.');
  }
  if (await exists(path.join(root, 'ConfigDumpInfo.xml'))) {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'CFE scaffold не должен создавать ConfigDumpInfo.xml.');
  }
}

function workspaceRelative(workspaceRoot: string, root: string): string {
  const relative = path.relative(workspaceRoot, root).replace(/\\/g, '/');
  return relative === '' ? '.' : validateWorkspaceRelativePath(relative);
}
function validateExtensionName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Имя расширения должно быть строкой.');
  }
  const name = value.trim();
  if (validateElementName(name, []) !== null) {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Имя расширения содержит недопустимые символы.');
  }
  return name;
}
function validatePurpose(value: unknown): CfeCreateProjectRequest['purpose'] {
  if (value === 'Customization' || value === 'Patch' || value === 'AddOn') { return value; }
  throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Указана недопустимая цель расширения.');
}
function normalizeNamePrefix(value: unknown, extensionName: string): string {
  if (typeof value !== 'string') {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Префикс имён расширения должен быть строкой.');
  }
  const prefix = value.trim() || `${extensionName}_`;
  if (validateElementName(prefix, []) !== null) {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Префикс имён расширения содержит недопустимые символы.');
  }
  return prefix;
}
function validateCompatibilityMode(value: unknown): string {
  if (typeof value !== 'string') {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Режим совместимости расширения должен быть строкой.');
  }
  const mode = value.trim();
  if (mode === 'DontUse' || /^Version8_3_\d{1,2}$/.test(mode)) { return mode; }
  throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Указан недопустимый режим совместимости расширения.');
}
function validateTargetPath(value: unknown): string {
  if (typeof value !== 'string') {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Каталог CFE-проекта должен быть строкой.');
  }
  try {
    return validateWorkspaceRelativePath(value);
  } catch (error) {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', message(error));
  }
}
function readValidatedBaseValue(xmlText: string, name: 'ScriptVariant' | 'InterfaceCompatibilityMode', fallback: string): string {
  const value = element(xmlText, name);
  if (value === undefined) { return fallback; }
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', `Основная конфигурация содержит недопустимое значение ${name}.`);
  }
  return value;
}
function xmlNamespaces(formatVersion: string): string {
  const palette = formatVersion === '2.21' ? ' xmlns:pal="http://v8.1c.ru/8.1/data/ui/colors/palette"' : '';
  return `${XML_NAMESPACES}${palette} ${XML_NAMESPACES_AFTER_PALETTE}`;
}
function containedObjects(): string {
  return CONTAINED_OBJECT_CLASS_IDS.map((classId) => `<xr:ContainedObject><xr:ClassId>${classId}</xr:ClassId><xr:ObjectId>${randomUUID()}</xr:ObjectId></xr:ContainedObject>`).join('');
}
function xml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function attribute(xmlText: string, elementName: string, attributeName: string): string | undefined { return new RegExp(`<${elementName}\\b[^>]*\\b${attributeName}\\s*=\\s*["']([^"']+)["']`, 'i').exec(xmlText)?.[1]; }
function element(xmlText: string, name: string): string | undefined { return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(xmlText)?.[1]?.trim(); }
async function exists(target: string): Promise<boolean> { try { await fs.promises.lstat(target); return true; } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') { return false; } throw error; } }
async function writeXmlFile(target: string, content: string): Promise<void> {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n').replace(/[\r\n]+$/, '');
  await fs.promises.writeFile(target, `\uFEFF${normalized}`, 'utf8');
}
async function removePublishedDirectory(workspaceRoot: string, target: string): Promise<unknown | undefined> { try { const boundary = await assertPathWithinRoot(workspaceRoot, target); await assertNoSymlinkSegments(boundary.canonicalRoot, boundary.canonicalTarget); await fs.promises.rm(boundary.canonicalTarget, { recursive: true, force: true, maxRetries: 3 }); return undefined; } catch (error) { return error; } }
async function writeRecoveryJournal(workspaceRoot: string, record: CfeProjectManifestRecord, cause: unknown, rollbackError: unknown): Promise<string> { const directory = path.join(workspaceRoot, '.vscode'); await fs.promises.mkdir(directory, { recursive: true }); const journalPath = path.join(directory, `cfe-project-recovery-${randomUUID()}.json`); await fs.promises.writeFile(journalPath, JSON.stringify({ version: 1, record, cause: message(cause), rollbackError: message(rollbackError) }, null, 2), 'utf8'); return journalPath; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
