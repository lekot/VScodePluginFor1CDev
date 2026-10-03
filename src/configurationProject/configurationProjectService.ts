import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { XMLValidator } from 'fast-xml-parser';
import {
  assertNoSymlinkSegments,
  assertPathWithinRoot,
  validateWorkspaceRelativePath,
  PathBoundaryError,
} from '../services/configurationSession/pathBoundary';
import { validateElementName } from '../utils/elementNameValidator';

export const CONFIGURATION_PROJECT_FORMAT_VERSION = '2.20' as const;

export type ConfigurationProjectLanguage = 'ru' | 'en';

export interface ConfigurationProjectRequest {
  readonly workspaceRoot: string;
  readonly targetRelativePath: string;
  readonly name: string;
  readonly language?: ConfigurationProjectLanguage;
}

export interface ConfigurationProjectOutcome {
  readonly rootPath: string;
  readonly formatVersion: typeof CONFIGURATION_PROJECT_FORMAT_VERSION;
}

export type ConfigurationProjectErrorCode =
  | 'CONFIGURATION_PROJECT_INVALID_REQUEST'
  | 'CONFIGURATION_PROJECT_PATH_CONFLICT'
  | 'CONFIGURATION_PROJECT_WRITE_FAILED';

export class ConfigurationProjectError extends Error {
  constructor(
    readonly code: ConfigurationProjectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigurationProjectError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ConfigurationProjectServiceOptions {
  readonly templateDirectory?: string;
  readonly writeTextFile?: (filePath: string, contents: string) => Promise<void>;
}

interface LanguageProfile {
  readonly code: ConfigurationProjectLanguage;
  readonly name: string;
  readonly languageLabel: string;
}

const LANGUAGE_PROFILES: Readonly<Record<ConfigurationProjectLanguage, LanguageProfile>> = {
  ru: { code: 'ru', name: 'Русский', languageLabel: 'Русский' },
  en: { code: 'en', name: 'English', languageLabel: 'English' },
};

const CONTAINED_OBJECT_CLASS_IDS = [
  '9cd510cd-abfc-11d4-9434-004095e12fc7',
  '9fcd25a0-4822-11d4-9414-008048da11f9',
  'e3687481-0a87-462c-a166-9f34594f9bba',
  '9de14907-ec23-4a07-96f0-85521cb6b53b',
  '51f2d5d8-ea4d-4064-8892-82951750031e',
  'e68182ea-4237-4383-967f-90c1e3370bc7',
  'fb282519-d103-4dd3-bc12-cb271d631dfc',
] as const;

const DEFAULT_TEMPLATE_DIRECTORY = path.resolve(__dirname, '../../resources/configuration-project');

/** Creates the pinned empty Designer XML 2.20 profile without starting the 1C platform. */
export class ConfigurationProjectService {
  constructor(private readonly options: ConfigurationProjectServiceOptions = {}) {}

  async createProject(request: ConfigurationProjectRequest): Promise<ConfigurationProjectOutcome> {
    const validated = validateRequest(request);
    let workspaceRoot: string;
    try {
      const rootStat = await fs.promises.stat(validated.workspaceRoot);
      if (!rootStat.isDirectory()) {
        throw new Error('not a directory');
      }
      workspaceRoot = await fs.promises.realpath(validated.workspaceRoot);
    } catch {
      throw new ConfigurationProjectError(
        'CONFIGURATION_PROJECT_INVALID_REQUEST',
        'Корневая папка workspace не существует или недоступна.',
      );
    }

    const relativePath = validateRelativeTarget(validated.targetRelativePath);
    const lexicalTarget = path.join(workspaceRoot, ...relativePath.split('/'));
    const initialTarget = await resolveSafeTarget(workspaceRoot, lexicalTarget);
    await assertTargetDoesNotExist(initialTarget);

    try {
      await fs.promises.mkdir(path.dirname(initialTarget), { recursive: true });
    } catch {
      throw new ConfigurationProjectError(
        'CONFIGURATION_PROJECT_WRITE_FAILED',
        'Не удалось создать родительскую папку проекта.',
      );
    }

    const target = await resolveSafeTarget(workspaceRoot, lexicalTarget);
    await assertTargetDoesNotExist(target);

    const staging = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${randomUUID()}.staging`,
    );
    let stagingCreated = false;
    try {
      await fs.promises.mkdir(staging, { recursive: false });
      stagingCreated = true;
      const scaffold = await this.createScaffold(validated.name, validated.language);
      await this.writeScaffold(staging, scaffold, validated.language.name);
      await validateScaffold(staging, scaffold, validated.name, validated.language);

      const latestTarget = await resolveSafeTarget(workspaceRoot, lexicalTarget);
      await assertTargetDoesNotExist(latestTarget);
      await assertNoSymlinkSegments(workspaceRoot, latestTarget);
      await fs.promises.rename(staging, latestTarget);
      stagingCreated = false;
      return {
        rootPath: latestTarget,
        formatVersion: CONFIGURATION_PROJECT_FORMAT_VERSION,
      };
    } catch (error) {
      if (stagingCreated) {
        await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
      if (error instanceof ConfigurationProjectError) {
        throw error;
      }
      if (isTargetConflict(error)) {
        throw new ConfigurationProjectError(
          'CONFIGURATION_PROJECT_PATH_CONFLICT',
          'Папка проекта уже существует.',
        );
      }
      if (error instanceof PathBoundaryError) {
        throw invalidTargetError();
      }
      throw new ConfigurationProjectError(
        'CONFIGURATION_PROJECT_WRITE_FAILED',
        'Не удалось создать проект конфигурации.',
      );
    }
  }

  private async createScaffold(
    name: string,
    language: LanguageProfile,
  ): Promise<{ configurationXml: string; languageXml: string; dumpInfoXml: string }> {
    const templateDirectory = this.options.templateDirectory ?? DEFAULT_TEMPLATE_DIRECTORY;
    let configurationXml: string;
    let languageXml: string;
    let dumpInfoXml: string;
    try {
      [configurationXml, languageXml, dumpInfoXml] = await Promise.all([
        fs.promises.readFile(path.join(templateDirectory, 'Configuration.xml'), 'utf8'),
        fs.promises.readFile(path.join(templateDirectory, 'Languages', 'Русский.xml'), 'utf8'),
        fs.promises.readFile(path.join(templateDirectory, 'ConfigDumpInfo.xml'), 'utf8'),
      ]);
    } catch {
      throw new ConfigurationProjectError(
        'CONFIGURATION_PROJECT_WRITE_FAILED',
        'Не удалось загрузить встроенный профиль пустой конфигурации.',
      );
    }

    configurationXml = replaceOnce(
      configurationXml,
      '<Name>Конфигурация</Name>',
      `<Name>${name}</Name>`,
    );
    configurationXml = replaceOnce(
      configurationXml,
      'Language.Русский',
      `Language.${language.name}`,
    ).replace('<Language>Русский</Language>', `<Language>${language.name}</Language>`);
    configurationXml = replaceOnce(
      configurationXml,
      '<ScriptVariant>Russian</ScriptVariant>',
      `<ScriptVariant>${language.code === 'en' ? 'English' : 'Russian'}</ScriptVariant>`,
    );
    configurationXml = replaceUuidAttribute(configurationXml, 'Configuration', randomUUID());
    configurationXml = configurationXml.replace(
      /(<xr:ObjectId>)[0-9a-f-]+(<\/xr:ObjectId>)/gi,
      (_match, start: string, end: string) => `${start}${randomUUID()}${end}`,
    );

    languageXml = replaceUuidAttribute(languageXml, 'Language', randomUUID());
    languageXml = replaceOnce(languageXml, '<Name>Русский</Name>', `<Name>${language.name}</Name>`);
    languageXml = replaceOnce(languageXml, '<v8:lang>ru</v8:lang>', `<v8:lang>${language.code}</v8:lang>`);
    languageXml = replaceOnce(
      languageXml,
      '<v8:content>Русский</v8:content>',
      `<v8:content>${language.languageLabel}</v8:content>`,
    );
    languageXml = replaceOnce(languageXml, '<LanguageCode>ru</LanguageCode>', `<LanguageCode>${language.code}</LanguageCode>`);

    return { configurationXml, languageXml, dumpInfoXml };
  }

  private async writeScaffold(
    staging: string,
    scaffold: { configurationXml: string; languageXml: string; dumpInfoXml: string },
    languageName: string,
  ): Promise<void> {
    const languagesDirectory = path.join(staging, 'Languages');
    await fs.promises.mkdir(languagesDirectory);
    const writeTextFile = this.options.writeTextFile
      ?? (async (filePath: string, contents: string) => fs.promises.writeFile(filePath, contents, 'utf8'));
    await writeTextFile(path.join(staging, 'Configuration.xml'), scaffold.configurationXml);
    await writeTextFile(path.join(languagesDirectory, `${languageName}.xml`), scaffold.languageXml);
    await writeTextFile(path.join(staging, 'ConfigDumpInfo.xml'), scaffold.dumpInfoXml);
  }
}

function validateRequest(request: ConfigurationProjectRequest): {
  workspaceRoot: string;
  targetRelativePath: string;
  name: string;
  language: LanguageProfile;
} {
  if (!request || typeof request !== 'object'
    || typeof request.workspaceRoot !== 'string'
    || !request.workspaceRoot.trim()
    || !path.isAbsolute(request.workspaceRoot)
    || typeof request.targetRelativePath !== 'string'
    || typeof request.name !== 'string') {
    throw new ConfigurationProjectError(
      'CONFIGURATION_PROJECT_INVALID_REQUEST',
      'Нужно указать абсолютный корень workspace, целевой путь и имя проекта.',
    );
  }
  const name = request.name.trim();
  if (validateElementName(name, []) !== null) {
    throw new ConfigurationProjectError(
      'CONFIGURATION_PROJECT_INVALID_REQUEST',
      'Имя проекта содержит недопустимые символы.',
    );
  }
  const languageCode = request.language ?? 'ru';
  if (languageCode !== 'ru' && languageCode !== 'en') {
    throw new ConfigurationProjectError(
      'CONFIGURATION_PROJECT_INVALID_REQUEST',
      'Выбран неподдерживаемый язык конфигурации.',
    );
  }
  return {
    workspaceRoot: path.resolve(request.workspaceRoot),
    targetRelativePath: request.targetRelativePath,
    name,
    language: LANGUAGE_PROFILES[languageCode],
  };
}

function validateRelativeTarget(value: string): string {
  try {
    return validateWorkspaceRelativePath(value);
  } catch {
    throw invalidTargetError();
  }
}

async function resolveSafeTarget(workspaceRoot: string, target: string): Promise<string> {
  try {
    const resolved = await assertPathWithinRoot(workspaceRoot, target);
    await assertNoSymlinkSegments(resolved.canonicalRoot, resolved.canonicalTarget);
    return resolved.canonicalTarget;
  } catch {
    throw invalidTargetError();
  }
}

async function assertTargetDoesNotExist(target: string): Promise<void> {
  try {
    await fs.promises.lstat(target);
    throw new ConfigurationProjectError(
      'CONFIGURATION_PROJECT_PATH_CONFLICT',
      'Папка проекта уже существует.',
    );
  } catch (error) {
    if (error instanceof ConfigurationProjectError) {
      throw error;
    }
    if (!isMissingPath(error)) {
      throw new ConfigurationProjectError(
        'CONFIGURATION_PROJECT_WRITE_FAILED',
        'Не удалось проверить целевой путь проекта.',
      );
    }
  }
}

async function validateScaffold(
  staging: string,
  scaffold: { configurationXml: string; languageXml: string; dumpInfoXml: string },
  name: string,
  language: LanguageProfile,
): Promise<void> {
  const [configurationXml, languageXml, dumpInfoXml] = await Promise.all([
    fs.promises.readFile(path.join(staging, 'Configuration.xml'), 'utf8'),
    fs.promises.readFile(path.join(staging, 'Languages', `${language.name}.xml`), 'utf8'),
    fs.promises.readFile(path.join(staging, 'ConfigDumpInfo.xml'), 'utf8'),
  ]);
  const classIds = [...configurationXml.matchAll(/<xr:ClassId>([^<]+)<\/xr:ClassId>/g)].map((match) => match[1]);
  const objectIds = [...configurationXml.matchAll(/<xr:ObjectId>([^<]+)<\/xr:ObjectId>/g)].map((match) => match[1]);
  const hasCfeProperties = /<ConfigurationExtensionPurpose>|<ExtendedConfigurationObject>|<ObjectBelonging>/.test(configurationXml);
  const valid = [configurationXml, languageXml, dumpInfoXml].every((xml) => XMLValidator.validate(xml) === true)
    && getFormatVersion(configurationXml) === CONFIGURATION_PROJECT_FORMAT_VERSION
    && getFormatVersion(languageXml) === CONFIGURATION_PROJECT_FORMAT_VERSION
    && getDumpInfoVersion(dumpInfoXml) === CONFIGURATION_PROJECT_FORMAT_VERSION
    && configurationXml.includes(`<Name>${name}</Name>`)
    && configurationXml.includes(`<DefaultLanguage>Language.${language.name}</DefaultLanguage>`)
    && configurationXml.includes(`<Language>${language.name}</Language>`)
    && languageXml.includes(`<Name>${language.name}</Name>`)
    && languageXml.includes(`<LanguageCode>${language.code}</LanguageCode>`)
    && classIds.length === CONTAINED_OBJECT_CLASS_IDS.length
    && classIds.every((classId, index) => classId === CONTAINED_OBJECT_CLASS_IDS[index])
    && objectIds.length === CONTAINED_OBJECT_CLASS_IDS.length
    && objectIds.every((objectId) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(objectId))
    && !hasCfeProperties
    && /<ConfigVersions\s*\/>/.test(dumpInfoXml)
    && !/<Metadata\b|\bconfigVersion=/.test(dumpInfoXml)
    && configurationXml === scaffold.configurationXml
    && languageXml === scaffold.languageXml
    && dumpInfoXml === scaffold.dumpInfoXml;
  if (!valid) {
    throw new ConfigurationProjectError(
      'CONFIGURATION_PROJECT_WRITE_FAILED',
      'Сгенерированный проект не прошёл проверку Designer XML 2.20.',
    );
  }
}

function replaceUuidAttribute(xml: string, element: string, value: string): string {
  const expression = new RegExp(`(<${element} uuid=")[^"]+("[ >])`);
  const next = xml.replace(expression, (_match, start: string, end: string) => `${start}${value}${end}`);
  if (next === xml) {
    throw new ConfigurationProjectError(
      'CONFIGURATION_PROJECT_WRITE_FAILED',
      `В профиле отсутствует UUID элемента ${element}.`,
    );
  }
  return next;
}

function replaceOnce(source: string, search: string, replacement: string): string {
  const index = source.indexOf(search);
  if (index < 0 || source.indexOf(search, index + search.length) >= 0) {
    throw new ConfigurationProjectError(
      'CONFIGURATION_PROJECT_WRITE_FAILED',
      'Встроенный профиль пустой конфигурации повреждён.',
    );
  }
  return `${source.slice(0, index)}${replacement}${source.slice(index + search.length)}`;
}

function getFormatVersion(xml: string): string | undefined {
  return xml.match(/<MetaDataObject\b[^>]*\bversion="([^"]+)"/)?.[1];
}

function getDumpInfoVersion(xml: string): string | undefined {
  return xml.match(/<ConfigDumpInfo\b[^>]*\bversion="([^"]+)"/)?.[1];
}

function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isTargetConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EISDIR';
}

function invalidTargetError(): ConfigurationProjectError {
  return new ConfigurationProjectError(
    'CONFIGURATION_PROJECT_INVALID_REQUEST',
    'Целевой путь должен находиться внутри workspace и не содержать символических ссылок.',
  );
}
