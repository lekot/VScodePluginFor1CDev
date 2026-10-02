import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { AgentResult, ConfigurationScopedParams } from './types';
import { AtomicFileStorage, type StorageOutcome } from '../services/configurationSession/atomicFileStorage';
import {
  assertNoSymlinkSegments,
  assertPathWithinRoot,
  PathBoundaryError,
  validateWorkspaceRelativePath,
} from '../services/configurationSession/pathBoundary';
import { parseBslRoutines } from '../bsl/routineRangeProvider';
import { applyFormXmlEdits, FormXmlEditError, type FormXmlEdit } from '../formEditor/formXmlTextEditor';
import { assertGenericFormMutationAllowed } from '../formEditor/cfeAdoptedFormGuard';
import { CfeProjectError } from '../extensionSupport/cfeProject/types';

// Form validation rules are adapted from cc-1c-skills form-validate under MIT; see docs/third-party-notices.md.

export const FORM_FORMAT_VERSIONS = ['2.17', '2.18', '2.19', '2.20', '2.21'] as const;
export type FormFormatVersion = typeof FORM_FORMAT_VERSIONS[number];

export interface StaticFormSelector extends ConfigurationScopedParams {
  /** Workspace-relative path to Forms/<name>/Ext/Form.xml or CommonForms/<name>/Ext/Form.xml. */
  formPath: string;
}

export interface StaticFormValidateParams extends StaticFormSelector {
  /** Optional expected metadata dump version to compare with the Form root version. */
  formatVersion?: FormFormatVersion;
}

export interface StaticFormEditParams extends StaticFormSelector {
  operations: FormXmlEdit[];
  dryRun?: boolean;
  /** SHA-256 revision returned by inspect or dryRun; required for commit. */
  ifRev?: string;
}

export interface FormJsonObject {
  [key: string]: FormJsonValue;
}

export type FormJsonValue = string | null | FormJsonObject | FormJsonValue[];

export interface FormEventDto {
  name: string;
  handler: string;
  callType?: string;
}

export interface FormTreeNode {
  tag: string;
  name: string;
  id?: string;
  properties: FormJsonObject;
  children: FormTreeNode[];
  events: FormEventDto[];
}

export interface FormAttributeDto {
  name: string;
  id?: string;
  mainAttribute: boolean;
  properties: FormJsonObject;
}

export interface FormCommandDto {
  name: string;
  id?: string;
  properties: FormJsonObject;
}

export interface FormInspectResult {
  formPath: string;
  /** SHA-256 hex digest of the exact Form.xml source bytes. */
  rev: string;
  tree: FormTreeNode[];
  attributes: FormAttributeDto[];
  commands: FormCommandDto[];
}

export interface FormValidationIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  /** Relative XML element path or sibling filename; never an absolute filesystem path. */
  path?: string;
}

export interface FormValidateResult {
  formPath: string;
  /** SHA-256 hex digest of the exact Form.xml source bytes. */
  rev: string;
  valid: boolean;
  issues: FormValidationIssue[];
}

export interface FormEditPlannedChanges {
  files: string[];
  summary: string;
  diff: string;
}

export interface FormEditResult {
  formPath: string;
  dryRun: boolean;
  rev: string;
  previousRev?: string;
  plannedChanges?: FormEditPlannedChanges;
  issues: FormValidationIssue[];
}

export interface FormEditFailureData {
  formPath?: string;
  currentRev?: string;
  issues?: FormValidationIssue[];
}

type FormEditAgentResult = AgentResult<FormEditResult | FormEditFailureData>;

type ReplaceStorage = Pick<AtomicFileStorage, 'replace'>;

interface XmlElement {
  tag: string;
  attributes: Record<string, string>;
  text: string;
  children: XmlElement[];
}

interface ReadFormResult {
  formPath: string;
  bytes: Buffer;
  xml: string;
}

class StaticFormError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'StaticFormError';
  }
}

const orderedParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  preserveOrder: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

const BINDING_TAGS = new Set([
  'DataPath', 'TitleDataPath', 'FooterDataPath', 'HeaderDataPath',
  'MultipleValueDataPath', 'MultipleValuePresentDataPath', 'RowPictureDataPath',
  'MultipleValuePictureDataPath',
]);

const SKIP_BINDING_TAGS = new Set([
  'ContextMenu', 'ExtendedTooltip', 'AutoCommandBar', 'SearchStringAddition',
  'ViewStatusAddition', 'SearchControlAddition',
]);

const COMPANION_RULES: Readonly<Record<string, readonly string[]>> = {
  InputField: ['ContextMenu', 'ExtendedTooltip'],
  CheckBoxField: ['ContextMenu', 'ExtendedTooltip'],
  LabelDecoration: ['ContextMenu', 'ExtendedTooltip'],
  LabelField: ['ContextMenu', 'ExtendedTooltip'],
  PictureDecoration: ['ContextMenu', 'ExtendedTooltip'],
  PictureField: ['ContextMenu', 'ExtendedTooltip'],
  CalendarField: ['ContextMenu', 'ExtendedTooltip'],
  UsualGroup: ['ExtendedTooltip'],
  Pages: ['ExtendedTooltip'],
  Page: ['ExtendedTooltip'],
  Button: ['ExtendedTooltip'],
  Table: ['ContextMenu', 'AutoCommandBar', 'SearchStringAddition', 'ViewStatusAddition', 'SearchControlAddition'],
};

const FORMAT_RANK: Readonly<Record<FormFormatVersion, number>> = {
  '2.17': 217,
  '2.18': 218,
  '2.19': 219,
  '2.20': 220,
  '2.21': 221,
};

export class AgentStaticFormOperations {
  constructor(
    private readonly configRoot: string,
    private readonly storage: ReplaceStorage = new AtomicFileStorage(configRoot),
  ) {}

  async inspect(params: StaticFormSelector): Promise<AgentResult<FormInspectResult>> {
    try {
      const source = await readFormXml(this.configRoot, params?.formPath);
      const document = parseFormXml(source.xml);
      const root = document.root;
      if (root.tag !== 'Form') {
        throw new StaticFormError('FORM_XML_INVALID', 'Корневой XML-элемент должен называться Form.');
      }
      return {
        success: true,
        data: {
          formPath: source.formPath,
          rev: hashBytes(source.bytes),
          tree: [buildFormTree(root, getFormName(source.formPath))],
          attributes: parseAttributes(root),
          commands: parseCommands(root),
        },
      };
    } catch (error) {
      return operationFailure(error);
    }
  }

  async validate(params: StaticFormValidateParams): Promise<AgentResult<FormValidateResult>> {
    try {
      if (params?.formatVersion && !FORM_FORMAT_VERSIONS.includes(params.formatVersion)) {
        throw new StaticFormError('FORM_FORMAT_VERSION_INVALID', 'formatVersion должен быть одной из версий 2.17–2.21.');
      }
      const source = await readFormXml(this.configRoot, params?.formPath);
      const document = parseFormXml(source.xml);
      const module = await readFormModule(this.configRoot, source.formPath);
      const issues = validateDocument(document, params?.formatVersion, module);
      return {
        success: true,
        data: {
          formPath: source.formPath,
          rev: hashBytes(source.bytes),
          valid: issues.every((issue) => issue.severity !== 'error'),
          issues,
        },
      };
    } catch (error) {
      return operationFailure(error);
    }
  }

  async edit(params: StaticFormEditParams): Promise<FormEditAgentResult> {
    try {
      if (!Array.isArray(params?.operations) || params.operations.length === 0) {
        throw new StaticFormError('FORM_EDIT_OPERATIONS_REQUIRED', 'Укажите хотя бы одну операцию изменения формы.');
      }
      if (params.dryRun !== undefined && typeof params.dryRun !== 'boolean') {
        throw new StaticFormError('FORM_DRY_RUN_INVALID', 'dryRun должен быть логическим значением.');
      }
      const dryRun = params.dryRun === true;
      if (!dryRun && !params.ifRev) {
        throw new StaticFormError('FORM_REV_REQUIRED', 'Для сохранения укажите ifRev из результата inspect или dryRun.');
      }
      if (params.ifRev !== undefined && !/^[a-f0-9]{64}$/.test(params.ifRev)) {
        throw new StaticFormError('FORM_REV_INVALID', 'ifRev должен быть SHA-256 ревизией из 64 строчных hex-символов.');
      }

      const source = await readFormXml(this.configRoot, params.formPath);
      try {
        await assertGenericFormMutationAllowed(path.resolve(this.configRoot, ...source.formPath.split('/')));
      } catch (error) {
        if (error instanceof CfeProjectError) { throw error; }
        throw new StaticFormError('FORM_OWNERSHIP_CHECK_FAILED', 'Не удалось безопасно проверить принадлежность формы; изменение отменено.');
      }
      const previousRev = hashBytes(source.bytes);
      if (!dryRun && params.ifRev !== previousRev) {
        return {
          success: false,
          code: 'CONCURRENT_MODIFICATION_ERROR',
          error: 'Form.xml изменился после получения ревизии; запись отменена.',
          data: { formPath: source.formPath, currentRev: previousRev },
        };
      }

      const originalText = decodeUtf8(source.bytes);
      const hadBom = originalText.startsWith('\uFEFF');
      const originalXml = hadBom ? originalText.slice(1) : originalText;
      const sourceDocument = parseFormXml(originalXml);
      if (sourceDocument.root.tag !== 'Form') {
        throw new StaticFormError('FORM_XML_INVALID', 'Корневой XML-элемент должен называться Form.');
      }
      const moduleText = await readFormModule(this.configRoot, source.formPath);
      const beforeIssues = validateDocument(sourceDocument, undefined, moduleText);

      let patchedXml: string;
      try {
        patchedXml = applyFormXmlEdits(originalXml, params.operations);
      } catch (error) {
        if (error instanceof FormXmlEditError) {
          throw new StaticFormError(error.code, error.message);
        }
        throw error;
      }
      const patchedDocument = parseFormXml(patchedXml);
      if (patchedDocument.root.tag !== 'Form') {
        throw new StaticFormError('FORM_XML_INVALID', 'После изменения корневой XML-элемент должен называться Form.');
      }
      const afterIssues = validateDocument(patchedDocument, undefined, moduleText);
      const newErrors = findNewValidationErrors(beforeIssues, afterIssues);
      if (newErrors.length > 0) {
        return {
          success: false,
          code: 'FORM_VALIDATION_FAILED',
          error: 'Операции создают новые ошибки проверки формы; файл не изменён.',
          data: { formPath: source.formPath, issues: newErrors },
        };
      }

      const patchedBytes = hadBom
        ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(patchedXml, 'utf8')])
        : Buffer.from(patchedXml, 'utf8');
      const changes = describeFormChanges(source.formPath, originalXml, patchedXml, params.operations.length);
      if (dryRun) {
        return {
          success: true,
          data: {
            formPath: source.formPath,
            dryRun: true,
            rev: previousRev,
            plannedChanges: changes,
            issues: afterIssues,
          },
        };
      }

      const targetPath = path.resolve(this.configRoot, ...source.formPath.split('/'));
      let outcome: StorageOutcome;
      try {
        outcome = await this.storage.replace(targetPath, patchedBytes, params.ifRev!);
      } catch {
        throw new StaticFormError('FORM_WRITE_FAILED', 'Не удалось сохранить Form.xml; исходный файл не был подтверждён как заменённый.');
      }
      if (outcome.status === 'conflict' && outcome.code === 'STALE_TARGET_HASH') {
        let currentRev: string | undefined;
        try { currentRev = hashBytes((await readFormXml(this.configRoot, source.formPath)).bytes); } catch { /* the target may have been removed or replaced */ }
        return {
          success: false,
          code: 'CONCURRENT_MODIFICATION_ERROR',
          error: 'Form.xml изменился непосредственно перед записью; изменения не применены.',
          data: { formPath: source.formPath, ...(currentRev ? { currentRev } : {}) },
        };
      }
      if (outcome.status === 'conflict') {
        return {
          success: false,
          code: 'FORM_PATH_OUTSIDE_CONFIGURATION',
          error: 'Путь формы изменился или вышел за границы конфигурации; запись отменена.',
        };
      }
      if (outcome.status === 'rolledBack') {
        return { success: false, code: 'FORM_WRITE_FAILED', error: 'Не удалось сохранить Form.xml; изменения отменены.' };
      }
      if (outcome.status === 'recoveryRequired') {
        return { success: false, code: 'FORM_WRITE_RECOVERY_REQUIRED', error: 'Не удалось подтвердить итог сохранения Form.xml; требуется восстановление файла.' };
      }
      return {
        success: true,
        data: {
          formPath: source.formPath,
          dryRun: false,
          rev: outcome.newHash,
          previousRev,
          issues: afterIssues,
        },
      };
    } catch (error) {
      return operationFailure(error);
    }
  }
}

/** Parses a 1C form document while preserving element order and XML attributes. */
function parseFormXml(xml: string): { root: XmlElement } {
  if (xml.trim() === '') {
    throw new StaticFormError('FORM_XML_INVALID', 'Form.xml пуст.');
  }
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new StaticFormError('FORM_XML_INVALID', `Некорректный XML Form.xml: ${validation.err.msg}`);
  }
  let parsed: unknown;
  try {
    parsed = orderedParser.parse(xml.replace(/^\uFEFF/, ''));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new StaticFormError('FORM_XML_INVALID', `Не удалось разобрать Form.xml: ${detail}`);
  }
  const elements = parseOrderedElements(parsed);
  if (elements.length !== 1) {
    throw new StaticFormError('FORM_XML_INVALID', 'Form.xml должен содержать один корневой XML-элемент.');
  }
  return { root: elements[0]! };
}

function parseOrderedElements(value: unknown): XmlElement[] {
  if (!Array.isArray(value)) { return []; }
  const result: XmlElement[] = [];
  for (const item of value) {
    if (!isRecord(item)) { continue; }
    const attributes = normalizeAttributes(item[':@']);
    for (const [tag, childValue] of Object.entries(item)) {
      if (tag === ':@' || tag === '#text' || tag === '#comment' || tag.startsWith('?')) { continue; }
      if (tag.startsWith('!')) { continue; }
      const children = parseOrderedElements(childValue);
      const textParts = Array.isArray(childValue)
        ? childValue.filter(isRecord).flatMap((child) => typeof child['#text'] === 'string' ? [child['#text'] as string] : [])
        : [];
      result.push({
        tag,
        attributes,
        text: textParts.join('').trim(),
        children,
      });
      break;
    }
  }
  return result;
}

function normalizeAttributes(value: unknown): Record<string, string> {
  if (!isRecord(value)) { return {}; }
  const attrs: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key.startsWith('@_')) { continue; }
    const name = localName(key.slice(2));
    if (name.toLowerCase().startsWith('xmlns')) { continue; }
    attrs[name] = String(item);
  }
  return attrs;
}

function validateDocument(
  document: { root: XmlElement },
  expectedVersion: FormFormatVersion | undefined,
  moduleText: string | undefined,
): FormValidationIssue[] {
  const root = document.root;
  const issues: FormValidationIssue[] = [];
  const add = (code: string, severity: FormValidationIssue['severity'], message: string, issuePath?: string): void => {
    issues.push({ code, severity, message, ...(issuePath ? { path: issuePath } : {}) });
  };
  if (root.tag !== 'Form') {
    add('FORM_ROOT_INVALID', 'error', `Корневой элемент «${root.tag}», ожидался «Form».`, root.tag);
  }

  const version = root.attributes.version;
  if (!version) {
    add('FORM_VERSION_MISSING', 'warning', 'В корневом элементе Form не указана версия формата.', 'Form');
  } else if (!/^\d+\.\d+$/.test(version)) {
    add('FORM_VERSION_INVALID', 'error', `Неверная версия формата формы «${version}».`, 'Form');
  } else {
    const versionRank = rankVersion(version);
    if (versionRank === undefined) {
      add('FORM_VERSION_UNVERIFIED', 'warning', `Версия «${version}» вне проверенного диапазона 2.17–2.21.`, 'Form');
    } else if (expectedVersion && version !== expectedVersion) {
      add(
        'FORM_VERSION_MISMATCH',
        'error',
        `Версия формы ${version} не совпадает с версией выгрузки ${expectedVersion}.`,
        'Form',
      );
    }
  }

  const autoCommandBar = firstChild(root, 'AutoCommandBar');
  if (!autoCommandBar) {
    add('FORM_AUTOCOMMANDBAR_MISSING', 'warning', 'В форме отсутствует AutoCommandBar.', 'Form/AutoCommandBar');
  } else {
    const autoId = autoCommandBar.attributes.id ?? '';
    if (!/^-?\d+$/.test(autoId)) {
      add('FORM_AUTOCOMMANDBAR_ID_INVALID', 'error', 'AutoCommandBar должен иметь числовой id.', 'Form/AutoCommandBar');
    } else if (autoId !== '-1') {
      add('FORM_AUTOCOMMANDBAR_ID_UNUSUAL', 'warning', `AutoCommandBar имеет id ${autoId}; обычно используется -1.`, 'Form/AutoCommandBar');
    }
  }

  const elements = collectFormElements(root);
  for (const element of elements) {
    checkNumericId(element.node, element.path, add);
  }
  checkUnique(
    elements.filter((element) => element.node.attributes.id && element.node.attributes.id !== '-1'),
    (element) => element.node.attributes.id!,
    (element) => element.node.attributes.name ?? '',
    'FORM_DUPLICATE_ELEMENT_ID',
    'FORM_DUPLICATE_ELEMENT_NAME',
    'Элемент',
    add,
  );

  const attributesNode = firstChild(root, 'Attributes');
  const attributes = childrenNamed(attributesNode, 'Attribute');
  for (const attribute of attributes) {
    checkNumericId(attribute, `Form/Attributes/Attribute[name=${attribute.attributes.name ?? ''}]`, add);
  }
  checkUnique(
    attributes.map((node) => ({ node, path: `Form/Attributes/Attribute[name=${node.attributes.name ?? ''}]` })),
    (entry) => entry.node.attributes.id ?? '',
    (entry) => entry.node.attributes.name ?? '',
    'FORM_DUPLICATE_ATTRIBUTE_ID',
    'FORM_DUPLICATE_ATTRIBUTE_NAME',
    'Реквизит',
    add,
  );

  for (const attribute of attributes) {
    const attrName = attribute.attributes.name ?? '';
    const columns = childrenNamed(firstChild(attribute, 'Columns'), 'Column');
    for (const column of columns) {
      checkNumericId(column, `Form/Attributes/Attribute[name=${attrName}]/Column[name=${column.attributes.name ?? ''}]`, add);
    }
    checkUnique(
      columns.map((node) => ({ node, path: `Form/Attributes/Attribute[name=${attrName}]/Column[name=${node.attributes.name ?? ''}]` })),
      (entry) => entry.node.attributes.id ?? '',
      (entry) => entry.node.attributes.name ?? '',
      'FORM_DUPLICATE_COLUMN_ID',
      'FORM_DUPLICATE_COLUMN_NAME',
      'Колонка',
      add,
    );
  }

  const commandsNode = firstChild(root, 'Commands');
  const commands = childrenNamed(commandsNode, 'Command');
  for (const command of commands) {
    checkNumericId(command, `Form/Commands/Command[name=${command.attributes.name ?? ''}]`, add);
  }
  checkUnique(
    commands.map((node) => ({ node, path: `Form/Commands/Command[name=${node.attributes.name ?? ''}]` })),
    (entry) => entry.node.attributes.id ?? '',
    (entry) => entry.node.attributes.name ?? '',
    'FORM_DUPLICATE_COMMAND_ID',
    'FORM_DUPLICATE_COMMAND_NAME',
    'Команда',
    add,
  );

  const parameterNames = new Set<string>();
  for (const parameter of childrenNamed(firstChild(root, 'Parameters'), 'Parameter')) {
    const name = parameter.attributes.name ?? '';
    if (name && parameterNames.has(name)) {
      add('FORM_DUPLICATE_PARAMETER_NAME', 'error', `Имя параметра «${name}» повторяется.`, `Form/Parameters/Parameter[name=${name}]`);
    }
    if (name) { parameterNames.add(name); }
  }

  for (const element of elements) {
    const tag = element.node.tag;
    const name = element.node.attributes.name ?? '';
    for (const companion of COMPANION_RULES[tag] ?? []) {
      if (!firstChild(element.node, companion)) {
        add(
          'FORM_COMPANION_MISSING',
          'warning',
          `[${tag}] «${name}»: отсутствует обязательный элемент ${companion}.`,
          element.path,
        );
      }
    }
  }

  const attributeNames = new Set(attributes.map((node) => node.attributes.name).filter((name): name is string => Boolean(name)));
  for (const element of elements) {
    if (SKIP_BINDING_TAGS.has(element.node.tag)) { continue; }
    const elementId = element.node.attributes.id;
    if (firstChild(root, 'BaseForm') && elementId && /^\d+$/.test(elementId) && Number(elementId) < 1000000) { continue; }
    for (const bindingTag of BINDING_TAGS) {
      const binding = firstChild(element.node, bindingTag);
      const dataPath = binding ? textContent(binding) : '';
      if (!dataPath || /^\d+$/.test(dataPath) || /^\d+\/\d+:[0-9a-f-]+$/i.test(dataPath)) { continue; }
      const segments = dataPath.replace(/\[\d+\]/g, '').replace(/^~/, '').split('.');
      let rootAttribute = segments[0] ?? '';
      let itemHops = 0;
      let itemsUnresolved = false;
      while (rootAttribute === 'Items') {
        if (++itemHops > 10 || segments.length < 3 || segments[2] !== 'CurrentData') {
          add(
            'FORM_DATAPATH_ITEMS_SHAPE_UNKNOWN',
            'warning',
            `[${element.node.tag}] «${element.node.attributes.name ?? ''}»: неизвестная структура Items.* в DataPath «${dataPath}».`,
            element.path,
          );
          itemsUnresolved = true;
          break;
        }
        const table = elements.find((candidate) => candidate.node.tag === 'Table' && candidate.node.attributes.name === segments[1]);
        if (!table) {
          add(
            'FORM_DATAPATH_TABLE_NOT_FOUND',
            'error',
            `[${element.node.tag}] «${element.node.attributes.name ?? ''}»: таблица «${segments[1]}» из DataPath не найдена.`,
            element.path,
          );
          itemsUnresolved = true;
          break;
        }
        const tablePath = textContent(firstChild(table.node, 'DataPath') ?? emptyNode());
        if (!tablePath) { itemsUnresolved = true; break; }
        segments.splice(0, segments.length, ...tablePath.replace(/\[\d+\]/g, '').replace(/^~/, '').split('.'));
        rootAttribute = segments[0] ?? '';
      }
      if (!itemsUnresolved && rootAttribute && !attributeNames.has(rootAttribute)) {
        add(
          'FORM_DATAPATH_ATTRIBUTE_NOT_FOUND',
          'error',
          `[${element.node.tag}] «${element.node.attributes.name ?? ''}»: реквизит «${rootAttribute}» из DataPath «${dataPath}» не найден.`,
          element.path,
        );
      }
    }
  }

  const commandNames = new Set(commands.map((node) => node.attributes.name).filter((name): name is string => Boolean(name)));
  for (const element of elements) {
    if (element.node.tag !== 'Button') { continue; }
    const commandRef = textContent(firstChild(element.node, 'CommandName') ?? emptyNode());
    const match = /^Form\.Command\.(.+)$/.exec(commandRef);
    if (match && !commandNames.has(match[1]!)) {
      add(
        'FORM_COMMAND_REFERENCE_NOT_FOUND',
        'error',
        `Кнопка «${element.node.attributes.name ?? ''}» ссылается на отсутствующую команду «${match[1]}».`,
        element.path,
      );
    }
  }

  const mainAttributeCount = attributes.filter((attribute) => textContent(firstChild(attribute, 'MainAttribute') ?? emptyNode()) === 'true').length;
  if (mainAttributeCount > 1) {
    add('FORM_MULTIPLE_MAIN_ATTRIBUTES', 'error', `В форме отмечено основных реквизитов: ${mainAttributeCount}; допустимо не больше одного.`, 'Form/Attributes');
  }

  const declaredHandlers = moduleText === undefined ? undefined : collectBslHandlers(moduleText);
  if (declaredHandlers === undefined) {
    add(
      'MODULE_CHECK_SKIPPED',
      'warning',
      'Соседний Ext/Form/Module.bsl отсутствует; проверка существования обработчиков пропущена.',
      'Ext/Form/Module.bsl',
    );
  }
  for (const event of collectEventReferences(root, elements)) {
    if (!event.handler) {
      add('FORM_EVENT_HANDLER_EMPTY', 'error', `Для события «${event.name}» не задан обработчик.`, event.path);
    } else if (declaredHandlers && !declaredHandlers.has(event.handler.toLocaleLowerCase('ru-RU'))) {
      add('FORM_EVENT_HANDLER_NOT_FOUND', 'error', `Обработчик события «${event.handler}» не найден в Module.bsl.`, event.path);
    }
  }

  for (const command of commands) {
    const action = firstChild(command, 'Action');
    const handler = action ? textContent(action) : '';
    const commandName = command.attributes.name ?? '';
    if (!handler) {
      add(
        'FORM_COMMAND_ACTION_MISSING',
        'warning',
        `У команды «${commandName}» не задан Action; он может назначаться при выполнении формы.`,
        `Form/Commands/Command[name=${commandName}]`,
      );
    } else if (declaredHandlers && !declaredHandlers.has(handler.toLocaleLowerCase('ru-RU'))) {
      add(
        'FORM_COMMAND_ACTION_NOT_FOUND',
        'error',
        `Обработчик команды «${handler}» не найден в Module.bsl.`,
        `Form/Commands/Command[name=${commandName}]/Action`,
      );
    }
  }

  return issues;
}

function checkUnique<T>(
  entries: readonly T[],
  getId: (entry: T) => string,
  getName: (entry: T) => string,
  duplicateIdCode: string,
  duplicateNameCode: string,
  label: string,
  add: (code: string, severity: 'error' | 'warning', message: string, path?: string) => void,
): void {
  const ids = new Map<string, T>();
  const names = new Map<string, T>();
  for (const entry of entries) {
    const id = getId(entry);
    const name = getName(entry);
    const issuePath = isRecord(entry) && typeof entry.path === 'string' ? entry.path : undefined;
    if (id && ids.has(id)) {
      add(duplicateIdCode, 'error', `${label} с id «${id}» повторяется.`, issuePath);
    } else if (id) {
      ids.set(id, entry);
    }
    if (name && names.has(name)) {
      add(duplicateNameCode, 'error', `Имя ${label.toLocaleLowerCase('ru-RU')} «${name}» повторяется.`, issuePath);
    } else if (name) {
      names.set(name, entry);
    }
  }
}

function collectFormElements(root: XmlElement): Array<{ node: XmlElement; path: string }> {
  const result: Array<{ node: XmlElement; path: string }> = [];
  const collect = (container: XmlElement | undefined, basePath: string): void => {
    if (!container) { return; }
    for (const child of childrenNamed(container, undefined)) {
      const name = child.attributes.name ?? '';
      const elementPath = `${basePath}/${child.tag}[name=${name}]`;
      result.push({ node: child, path: elementPath });
      collect(firstChild(child, 'ChildItems'), elementPath + '/ChildItems');
    }
  };
  collect(firstChild(root, 'ChildItems'), 'Form/ChildItems');
  const autoCommandBar = firstChild(root, 'AutoCommandBar');
  collect(firstChild(autoCommandBar, 'ChildItems'), 'Form/AutoCommandBar/ChildItems');
  return result;
}

function collectEventReferences(
  root: XmlElement,
  elements: readonly { node: XmlElement; path: string }[],
): Array<{ name: string; handler: string; path: string }> {
  const result: Array<{ name: string; handler: string; path: string }> = [];
  const collect = (owner: XmlElement, ownerPath: string): void => {
    const events = firstChild(owner, 'Events');
    for (const event of childrenNamed(events, 'Event')) {
      const name = event.attributes.name ?? '';
      result.push({
        name,
        handler: textContent(event),
        path: `${ownerPath}/Events/Event[name=${name}]`,
      });
    }
  };
  collect(root, 'Form');
  for (const element of elements) { collect(element.node, element.path); }
  return result;
}

function buildFormTree(root: XmlElement, formName: string): FormTreeNode {
  const structuralNames = new Set(['ChildItems', 'Attributes', 'Commands', 'Parameters', 'Events', 'CommandSet', 'BaseForm']);
  const childItems = firstChild(root, 'ChildItems');
  const autoCommandBar = firstChild(root, 'AutoCommandBar');
  const children = [
    ...childrenNamed(childItems, undefined).map(buildTreeNode),
    ...(autoCommandBar ? [buildTreeNode(autoCommandBar)] : []),
  ];
  const properties = propertiesOf(root, structuralNames);
  if (root.attributes.version) { properties.version = root.attributes.version; }
  return {
    tag: 'Form',
    name: formName,
    properties,
    children,
    events: parseEvents(root),
  };
}

function buildTreeNode(node: XmlElement): FormTreeNode {
  const structuralNames = new Set(['ChildItems', 'Events']);
  return {
    tag: node.tag,
    name: node.attributes.name ?? '',
    ...(node.attributes.id !== undefined ? { id: node.attributes.id } : {}),
    properties: propertiesOf(node, structuralNames),
    children: childrenNamed(firstChild(node, 'ChildItems'), undefined).map(buildTreeNode),
    events: parseEvents(node),
  };
}

function parseAttributes(root: XmlElement): FormAttributeDto[] {
  return childrenNamed(firstChild(root, 'Attributes'), 'Attribute').map((node) => ({
    name: node.attributes.name ?? '',
    ...(node.attributes.id !== undefined ? { id: node.attributes.id } : {}),
    mainAttribute: textContent(firstChild(node, 'MainAttribute') ?? emptyNode()) === 'true',
    properties: propertiesOf(node, new Set(['MainAttribute'])),
  }));
}

function parseCommands(root: XmlElement): FormCommandDto[] {
  return childrenNamed(firstChild(root, 'Commands'), 'Command').map((node) => ({
    name: node.attributes.name ?? '',
    ...(node.attributes.id !== undefined ? { id: node.attributes.id } : {}),
    properties: propertiesOf(node, new Set()),
  }));
}

function parseEvents(owner: XmlElement): FormEventDto[] {
  return childrenNamed(firstChild(owner, 'Events'), 'Event').map((event) => ({
    name: event.attributes.name ?? '',
    handler: textContent(event),
    ...(event.attributes.callType !== undefined ? { callType: event.attributes.callType } : {}),
  }));
}

function propertiesOf(node: XmlElement, excluded: ReadonlySet<string>): FormJsonObject {
  const grouped = new Map<string, XmlElement[]>();
  for (const child of node.children) {
    if (excluded.has(child.tag)) { continue; }
    const group = grouped.get(child.tag) ?? [];
    group.push(child);
    grouped.set(child.tag, group);
  }
  const result: FormJsonObject = {};
  for (const [tag, values] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    result[tag] = values.length === 1 ? toJsonValue(values[0]!) : values.map(toJsonValue);
  }
  return result;
}

function toJsonValue(node: XmlElement): FormJsonValue {
  if (node.children.length === 0 && Object.keys(node.attributes).length === 0) {
    return node.text || null;
  }
  const result: FormJsonObject = {};
  if (Object.keys(node.attributes).length > 0) {
    const attributes: FormJsonObject = {};
    for (const [key, value] of Object.entries(node.attributes).sort(([left], [right]) => left.localeCompare(right))) {
      attributes[key] = value;
    }
    result.$attributes = attributes;
  }
  if (node.text) { result.$text = node.text; }
  Object.assign(result, propertiesOf(node, new Set()));
  return result;
}

function childrenNamed(node: XmlElement | undefined, name: string | undefined): XmlElement[] {
  return (node?.children ?? []).filter((child) => name === undefined || child.tag === name);
}

function firstChild(node: XmlElement | undefined, name: string): XmlElement | undefined {
  return node?.children.find((child) => child.tag === name);
}

function textContent(node: XmlElement): string {
  return [node.text, ...node.children.map(textContent)].filter(Boolean).join('').trim();
}

function emptyNode(): XmlElement {
  return { tag: '', attributes: {}, text: '', children: [] };
}

function localName(value: string): string {
  const colon = value.lastIndexOf(':');
  return colon < 0 ? value : value.slice(colon + 1);
}

function rankVersion(version: string): number | undefined {
  const match = /^(\d+)\.(\d+)$/.exec(version);
  if (!match) { return undefined; }
  const rank = Number(match[1]) * 100 + Number(match[2]);
  return rank >= FORMAT_RANK['2.17'] && rank <= FORMAT_RANK['2.21'] ? rank : undefined;
}

function collectBslHandlers(moduleText: string): Set<string> {
  return new Set(parseBslRoutines(moduleText).routines.map((routine) => routine.name.toLocaleLowerCase('ru-RU')));
}

async function readFormXml(configRoot: string, requestedPath: unknown): Promise<ReadFormResult> {
  const formPath = normalizeFormPath(requestedPath);
  const absolutePath = path.resolve(configRoot, ...formPath.split('/'));
  return readContainedFile(configRoot, absolutePath, formPath);
}

function normalizeFormPath(requestedPath: unknown): string {
  if (typeof requestedPath !== 'string') {
    throw new StaticFormError('FORM_PATH_REQUIRED', 'Укажите workspace-relative путь к Ext/Form.xml.');
  }
  let formPath: string;
  try {
    formPath = validateWorkspaceRelativePath(requestedPath);
  } catch (error) {
    if (error instanceof PathBoundaryError) {
      const code = error.code === 'PATH_OUTSIDE_ROOT' ? 'FORM_PATH_OUTSIDE_CONFIGURATION' : 'FORM_PATH_INVALID';
      throw new StaticFormError(code, 'Путь формы должен быть относительным и не выходить за границы конфигурации.');
    }
    throw error;
  }
  const parts = formPath.split('/');
  const category = parts[parts.length - 4];
  const name = parts[parts.length - 3];
  const ext = parts[parts.length - 2];
  const file = parts[parts.length - 1];
  if (
    parts.length < 4
    || (category?.toLowerCase() !== 'forms' && category?.toLowerCase() !== 'commonforms')
    || !name
    || ext?.toLowerCase() !== 'ext'
    || file?.toLowerCase() !== 'form.xml'
  ) {
    throw new StaticFormError(
      'FORM_PATH_INVALID',
      'Путь должен вести к Forms/<имя>/Ext/Form.xml или CommonForms/<имя>/Ext/Form.xml.',
    );
  }
  return formPath;
}

async function readFormModule(configRoot: string, formXmlRelativePath: string): Promise<string | undefined> {
  // Build from the same lexical root/path spelling used by inspect: on Windows,
  // realpath may expand an 8.3 root alias and make subsequent relative checks fail.
  const modulePath = path.resolve(configRoot, ...formXmlRelativePath.split('/').slice(0, -1), 'Form', 'Module.bsl');
  const relativeModulePath = path.posix.join(path.posix.dirname(formXmlRelativePath), 'Form', 'Module.bsl');
  try {
    const module = await readContainedFile(configRoot, modulePath, relativeModulePath);
    return module.bytes.toString('utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    if (error instanceof StaticFormError && error.code === 'FORM_FILE_NOT_FOUND') { return undefined; }
    if (error instanceof StaticFormError && error.code === 'FORM_PATH_OUTSIDE_CONFIGURATION') {
      throw new StaticFormError(error.code, `Не удалось безопасно прочитать соседний модуль ${relativeModulePath}.`);
    }
    throw error;
  }
}

async function readContainedFile(configRoot: string, absolutePath: string, relativePath: string): Promise<ReadFormResult> {
  let boundary: { canonicalRoot: string; canonicalTarget: string };
  try {
    boundary = await assertPathWithinRoot(configRoot, absolutePath);
    await assertNoSymlinkSegments(boundary.canonicalRoot, boundary.canonicalTarget);
  } catch (error) {
    if (error instanceof PathBoundaryError) {
      throw new StaticFormError(
        'FORM_PATH_OUTSIDE_CONFIGURATION',
        `Путь ${relativePath} выходит за границы конфигурации или содержит небезопасную ссылку (${error.code}).`,
      );
    }
    throw new StaticFormError('FORM_FILE_UNAVAILABLE', 'Не удалось проверить путь к файлу формы.');
  }

  const lexicalSegments = path.relative(path.resolve(configRoot), path.resolve(absolutePath)).split(path.sep).filter(Boolean);
  let cursor = boundary.canonicalRoot;
  for (let index = 0; index < lexicalSegments.length; index++) {
    cursor = path.join(cursor, lexicalSegments[index]!);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(cursor);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        throw new StaticFormError('FORM_FILE_NOT_FOUND', `Файл не найден: ${relativePath}`);
      }
      throw new StaticFormError('FORM_FILE_UNAVAILABLE', `Не удалось безопасно прочитать ${relativePath}.`);
    }
    if (stat.isSymbolicLink()) {
      throw new StaticFormError('FORM_PATH_OUTSIDE_CONFIGURATION', `Путь ${relativePath} содержит символическую ссылку.`);
    }
    const finalSegment = index === lexicalSegments.length - 1;
    if (finalSegment ? !stat.isFile() : !stat.isDirectory()) {
      throw new StaticFormError('FORM_FILE_INVALID', `Путь ${relativePath} не указывает на обычный файл.`);
    }
  }

  try {
    const bytes = await fs.promises.readFile(cursor);
    return {
      formPath: relativePath,
      bytes,
      xml: bytes.toString('utf8').replace(/^\uFEFF/, ''),
    };
  } catch {
    throw new StaticFormError('FORM_FILE_UNAVAILABLE', `Не удалось прочитать ${relativePath}.`);
  }
}

function checkNumericId(
  node: XmlElement,
  issuePath: string,
  add: (code: string, severity: 'error' | 'warning', message: string, path?: string) => void,
): void {
  const id = node.attributes.id;
  if (id !== undefined && !/^\d+$/.test(id)) {
    add('FORM_ID_NOT_NUMERIC', 'error', `Элемент ${node.tag} имеет нечисловой id «${id}».`, issuePath);
  }
}

function decodeUtf8(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new StaticFormError('FORM_XML_ENCODING_INVALID', 'Form.xml не является корректным UTF-8; файл не изменён.');
  }
  return text;
}

function findNewValidationErrors(
  before: readonly FormValidationIssue[],
  after: readonly FormValidationIssue[],
): FormValidationIssue[] {
  const remaining = new Map<string, number>();
  for (const issue of before) {
    if (issue.severity !== 'error') { continue; }
    const key = `${issue.code}\0${issue.path ?? ''}`;
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const introduced: FormValidationIssue[] = [];
  for (const issue of after) {
    if (issue.severity !== 'error') { continue; }
    const key = `${issue.code}\0${issue.path ?? ''}`;
    const count = remaining.get(key) ?? 0;
    if (count === 0) {
      introduced.push(issue);
    } else if (count === 1) {
      remaining.delete(key);
    } else {
      remaining.set(key, count - 1);
    }
  }
  return introduced;
}

function describeFormChanges(
  formPath: string,
  beforeText: string,
  afterText: string,
  operationCount: number,
): FormEditPlannedChanges {
  const oldLines = beforeText.split(/\r?\n/);
  const newLines = afterText.split(/\r?\n/);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) { prefix++; }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) { suffix++; }

  const oldChangeEnd = oldLines.length - suffix;
  const newChangeEnd = newLines.length - suffix;
  const removed = oldChangeEnd - prefix;
  const added = newChangeEnd - prefix;
  let diff = '';
  if (removed > 0 || added > 0) {
    const contextStart = Math.max(0, prefix - 1);
    const hasTrailingContext = suffix > 0;
    const oldCount = oldChangeEnd - contextStart + (hasTrailingContext ? 1 : 0);
    const newCount = newChangeEnd - contextStart + (hasTrailingContext ? 1 : 0);
    const lines = [
      `--- ${formPath}`,
      `+++ ${formPath}`,
      `@@ -${contextStart + 1},${oldCount} +${contextStart + 1},${newCount} @@`,
      ...oldLines.slice(contextStart, prefix).map((line) => ` ${line}`),
      ...oldLines.slice(prefix, oldChangeEnd).map((line) => `-${line}`),
      ...newLines.slice(prefix, newChangeEnd).map((line) => `+${line}`),
      ...(hasTrailingContext ? [` ${oldLines[oldChangeEnd] ?? ''}`] : []),
    ];
    diff = lines.join('\n');
  }
  return {
    files: [formPath],
    summary: `${operationCount} операций; строк удалено: ${removed}, добавлено: ${added}.`,
    diff,
  };
}

function hashBytes(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function getFormName(formPath: string): string {
  const segments = formPath.split('/');
  return segments[segments.length - 3] ?? 'Form';
}

function operationFailure(error: unknown): AgentResult<never> {
  if (error instanceof StaticFormError) {
    return { success: false, code: error.code, error: error.message };
  }
  if (error instanceof CfeProjectError) {
    return { success: false, code: error.code, error: error.message };
  }
  if (error instanceof FormXmlEditError) {
    return { success: false, code: error.code, error: error.message };
  }
  return {
    success: false,
    code: 'FORM_OPERATION_FAILED',
    error: error instanceof Error ? error.message : String(error),
  };
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
