import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getMetadataTypeDescriptorByRootTag } from '../../constants/metadataTypeDescriptors';
import { CONFIGURATION_XML } from '../../constants/fileNames';
import { isRootObjectRegisteredInConfiguration } from '../../services/configurationXmlUpdater';
import { hashContent } from '../../services/configurationSession/atomicFileStorage';
import type { MutationExpectation, MutationPlan, MutationStep } from '../../services/configurationSession/mutationPlan';
import { assertNoSymlinkSegments, assertPathWithinRoot } from '../../services/configurationSession/pathBoundary';
import { validateElementName } from '../../utils/elementNameValidator';
import { parseCfeObjectIdentity, type CfeObjectIdentity } from './ownership';
import type { CfeProjectRegistry } from './registry';
import type { CfeProjectContext } from './types';
import {
  collectCfeFormDependencies,
  collectSourceFormCommandNames,
  collectUnsupportedCfeFormDependencies,
  type CfeFormDependency,
} from './formDependencies';
import {
  CfeFormError,
  type CfeBorrowFormRequest,
  type CfeCreateOwnFormRequest,
  type CfeExtendFormRequest,
  type CfeFormCallType,
  type CfeFormFormatVersion,
  type CfeFormMutationOutcome,
  type CfeFormOperation,
  type CfeFormOwnerType,
} from './formTypes';
import {
  allocateExtensionFormId,
  appendOrVerifyAction,
  appendOrVerifyEvent,
  cloneXmlElement,
  createXmlElement,
  createXmlText,
  directChildren,
  ensureBaseFormLast,
  ensureSectionBeforeAny,
  firstDirectChild,
  localName,
  parseCfeFormXml,
  parseCfeOrderedXml,
  sanitizeBorrowedBasePart,
  serializeCfeFormXml,
  setTextContent,
  stripBaseFormMutations,
  textContent,
  type CfeFormXmlElement,
} from './formXml';

interface OwnerRule {
  readonly type: CfeFormOwnerType;
  readonly folder: string;
}

interface ResolvedOwner {
  readonly type: CfeFormOwnerType;
  readonly folder: string;
  readonly identity: CfeObjectIdentity;
  readonly metadataPath: string;
  readonly metadataContent: string;
  readonly metadataHash: string;
}

interface ResolvedSourceForm {
  readonly owner: ResolvedOwner;
  readonly identity: CfeObjectIdentity;
  readonly formType: 'Managed';
  readonly metadataPath: string;
  readonly metadataContent: string;
  readonly metadataHash: string;
  readonly formPath: string;
  readonly formContent: string;
  readonly formHash: string;
  readonly formRoot: CfeFormXmlElement;
}

interface ResolvedExtensionForm {
  readonly extensionRoot: string;
  readonly owner: ResolvedOwner;
  readonly identity: CfeObjectIdentity;
  readonly metadataPath: string;
  readonly metadataContent: string;
  readonly formPath: string;
  readonly modulePath: string;
}

const OWNER_RULES: readonly OwnerRule[] = Object.freeze([
  { type: 'Catalog', folder: 'Catalogs' },
  { type: 'Document', folder: 'Documents' },
]);

const BASE_PART_EXCLUDED = new Set(['Events', 'Attributes', 'Commands', 'Parameters', 'CommandInterface', 'BaseForm']);
const BASE_PART_ATTRIBUTE_PROPERTIES = new Set(['ReportResult', 'DetailsData', 'VariantAppearance', 'GroupList']);
const STANDARD_STYLE_ITEMS = new Set([
  'NormalTextFont', 'AccentColor', 'FormBackColor', 'FormTextColor', 'FormBorder', 'FormTitleFont',
]);

/**
 * Isolated CFE application service for own/adopted forms. UI, Agent and MCP are
 * deliberately absent here; later adapters call these methods only.
 */
export class CfeFormService {
  constructor(private readonly projects: CfeProjectRegistry) {}

  async createOwnForm(request: CfeCreateOwnFormRequest): Promise<CfeFormMutationOutcome> {
    assertCreateOwnRequest(request);
    const context = await this.projects.getByExtension(String(request.extensionConfigurationId));
    assertFormat(context.formatVersion);
    assertOwnFormName(request.formName, context.namePrefix);
    return this.runInExtension(context, 'cfe.createOwnForm', async () => {
      const owner = await this.resolveExtensionOwnerByDotPath(context, request.ownerDotPath);
      const existing = await this.findExtensionFormByName(context, owner, request.formName);
      if (existing) {
        if (existing.identity.ownership !== 'own') {
          throw validation(`Имя формы «${request.formName}» уже занято заимствованной формой.`);
        }
        return outcomeFromExtensionForm('already-created', existing);
      }
      return context.extensionSession.mutations.execute(
        await this.buildOwnFormPlan(context, owner, request.formName, request.formType ?? 'Managed'),
      );
    });
  }

  async borrowForm(request: CfeBorrowFormRequest): Promise<CfeFormMutationOutcome> {
    assertBorrowRequest(request);
    const context = await this.projects.getByExtension(String(request.extensionConfigurationId));
    assertFormat(context.formatVersion);
    const owner = await this.resolveExtensionOwnerBySourceUuid(context, normalizeUuid(request.ownerSourceUuid, 'ownerSourceUuid'));
    const baseOwner = await this.resolveBaseOwnerBySourceUuid(context, owner.identity.sourceUuid!);
    const source = await this.resolveSourceForm(context, baseOwner, request.sourceFormUuid, request.sourceFormName);
    await this.assertSourceUnchanged(context, source);
    await this.assertFormDependencies(context, source.formRoot);

    return this.runInExtension(context, 'cfe.borrowForm', async () => {
      await this.assertSourceUnchanged(context, source);
      const currentOwner = await this.resolveExtensionOwnerBySourceUuid(context, owner.identity.sourceUuid!);
      const existing = await this.findExtensionFormBySourceUuid(context, source.identity.uuid);
      if (existing) {
        if (existing.owner.identity.sourceUuid !== currentOwner.identity.sourceUuid) {
          throw ownershipInvalid('Заимствованная форма привязана к другому владельцу CFE.');
        }
        return outcomeFromExtensionForm('already-borrowed', existing);
      }
      await this.assertFormDependencies(context, source.formRoot);
      await this.assertSourceUnchanged(context, source);
      return context.extensionSession.mutations.execute(
        await this.buildBorrowFormPlan(context, currentOwner, source),
      );
    });
  }

  async extendForm(request: CfeExtendFormRequest): Promise<CfeFormMutationOutcome> {
    assertExtendRequest(request);
    const context = await this.projects.getByExtension(String(request.extensionConfigurationId));
    assertFormat(context.formatVersion);
    const sourceFormUuid = normalizeUuid(request.sourceFormUuid, 'sourceFormUuid');
    const extensionForm = await this.findExtensionFormBySourceUuid(context, sourceFormUuid);
    if (!extensionForm) {
      throw new CfeFormError('CFE_SOURCE_OBJECT_NOT_FOUND', 'Заимствованная форма с указанным UUID не найдена в CFE.');
    }
    const ownerSourceUuid = extensionForm.owner.identity.sourceUuid;
    if (!ownerSourceUuid) {
      throw ownershipInvalid('Заимствованная форма находится у владельца без UUID источника.');
    }
    const baseOwner = await this.resolveBaseOwnerBySourceUuid(context, ownerSourceUuid);
    const source = await this.resolveSourceForm(context, baseOwner, sourceFormUuid);
    if (request.expectedFormHash.toLocaleLowerCase() !== source.formHash.toLocaleLowerCase()) {
      throw new CfeFormError('CFE_SOURCE_CHANGED', 'Ожидаемый hash исходной формы не совпадает с текущим состоянием.');
    }
    await this.assertFormDependencies(context, source.formRoot);
    await this.assertOperationDependencies(context, request.operations);

    return this.runInExtension(context, 'cfe.extendForm', async () => {
      await this.assertSourceUnchanged(context, source);
      const current = await this.findExtensionFormBySourceUuid(context, sourceFormUuid);
      if (!current) {
        throw new CfeFormError('CFE_SOURCE_OBJECT_NOT_FOUND', 'Заимствованная форма исчезла до начала изменения.');
      }
      if (current.owner.identity.sourceUuid !== ownerSourceUuid) {
        throw ownershipInvalid('Владелец заимствованной формы изменился до commit.');
      }
      await this.assertFormDependencies(context, source.formRoot);
      await this.assertOperationDependencies(context, request.operations);
      const existingContent = await readFile(current.formPath, 'Не удалось прочитать Form.xml CFE.');
      const form = parseCfeFormXml(existingContent).root;
      assertAdoptedFormShape(form, context.formatVersion);
      const changed = applyOperations(form, request.operations, collectSourceFormCommandNames(source.formRoot));
      if (!changed) {
        return outcomeFromExtensionForm('unchanged', current);
      }
      await this.assertSourceUnchanged(context, source);
      const plan: MutationPlan<CfeFormMutationOutcome> = {
        kind: 'cfe.extendForm',
        steps: [{
          type: 'writeFile',
          targetPath: current.formPath,
          content: serializeCfeFormXml({ root: form }),
          encoding: 'utf8',
          expected: { state: 'file', hash: hashContent(existingContent) },
        }],
        result: outcomeFromExtensionForm('extended', current),
      };
      return context.extensionSession.mutations.execute(plan);
    });
  }

  private async buildOwnFormPlan(
    context: CfeProjectContext,
    owner: ResolvedOwner,
    formName: string,
    formType: 'Managed',
  ): Promise<MutationPlan<CfeFormMutationOutcome>> {
    const paths = await formPaths(context.extensionRoot, owner, formName);
    const [metadataExpected, formExpected, moduleExpected] = await Promise.all([
      expectationForPath(paths.metadataPath), expectationForPath(paths.formPath), expectationForPath(paths.modulePath),
    ]);
    if (metadataExpected.state !== 'missing' || formExpected.state !== 'missing') {
      throw validation(`Форма «${formName}» уже существует в CFE.`);
    }
    if (moduleExpected.state === 'directory') {
      throw ownershipInvalid('Путь Module.bsl занят каталогом.');
    }
    const localUuid = randomUUID();
    const extensionOwner = updateOwnerWithForm(owner.metadataContent, owner.type, owner.identity.name, formName);
    const result: CfeFormMutationOutcome = {
      status: 'created', ownerType: owner.type, ownerName: owner.identity.name,
      ownerSourceUuid: owner.identity.sourceUuid, formName,
      metadataPath: relativePath(context.extensionRoot, paths.metadataPath),
      formPath: relativePath(context.extensionRoot, paths.formPath),
      modulePath: relativePath(context.extensionRoot, paths.modulePath), localUuid,
    };
    const steps: MutationStep[] = [
      { type: 'ensureDirectory', targetPath: paths.formsDirectory },
      { type: 'ensureDirectory', targetPath: paths.formDirectory },
      { type: 'ensureDirectory', targetPath: paths.extDirectory },
      { type: 'ensureDirectory', targetPath: paths.moduleDirectory },
      {
        type: 'writeFile', targetPath: paths.metadataPath,
        content: buildFormMetadataXml(context.formatVersion as CfeFormFormatVersion, localUuid, formName, formType, 'own'),
        encoding: 'utf8', expected: metadataExpected,
      },
      {
        type: 'writeFile', targetPath: paths.formPath,
        content: serializeCfeFormXml({ root: createOwnFormXml(context.formatVersion as CfeFormFormatVersion) }),
        encoding: 'utf8', expected: formExpected,
      },
      {
        type: 'writeFile', targetPath: owner.metadataPath, content: extensionOwner,
        encoding: 'utf8', expected: { state: 'file', hash: owner.metadataHash },
      },
    ];
    if (moduleExpected.state === 'missing') {
      steps.splice(6, 0, {
        type: 'writeFile', targetPath: paths.modulePath, content: '\uFEFF', encoding: 'utf8', expected: moduleExpected,
      });
    }
    return { kind: 'cfe.createOwnForm', steps, result };
  }

  private async buildBorrowFormPlan(
    context: CfeProjectContext,
    owner: ResolvedOwner,
    source: ResolvedSourceForm,
  ): Promise<MutationPlan<CfeFormMutationOutcome>> {
    const paths = await formPaths(context.extensionRoot, owner, source.identity.name);
    const [metadataExpected, formExpected, moduleExpected] = await Promise.all([
      expectationForPath(paths.metadataPath), expectationForPath(paths.formPath), expectationForPath(paths.modulePath),
    ]);
    if (metadataExpected.state !== 'missing' || formExpected.state !== 'missing') {
      throw validation(`Форма «${source.identity.name}» уже существует в CFE.`);
    }
    if (moduleExpected.state === 'directory') {
      throw ownershipInvalid('Путь Module.bsl занят каталогом.');
    }
    const localUuid = randomUUID();
    const ownerContent = updateOwnerWithForm(owner.metadataContent, owner.type, owner.identity.name, source.identity.name);
    const result: CfeFormMutationOutcome = {
      status: 'borrowed', ownerType: owner.type, ownerName: owner.identity.name,
      ownerSourceUuid: owner.identity.sourceUuid, formName: source.identity.name, sourceFormUuid: source.identity.uuid,
      metadataPath: relativePath(context.extensionRoot, paths.metadataPath),
      formPath: relativePath(context.extensionRoot, paths.formPath),
      modulePath: relativePath(context.extensionRoot, paths.modulePath), localUuid,
    };
    const steps: MutationStep[] = [
      { type: 'ensureDirectory', targetPath: paths.formsDirectory },
      { type: 'ensureDirectory', targetPath: paths.formDirectory },
      { type: 'ensureDirectory', targetPath: paths.extDirectory },
      { type: 'ensureDirectory', targetPath: paths.moduleDirectory },
      {
        type: 'writeFile', targetPath: paths.metadataPath,
        content: buildFormMetadataXml(context.formatVersion as CfeFormFormatVersion, localUuid, source.identity.name, source.formType, 'adopted', source.identity.uuid),
        encoding: 'utf8', expected: metadataExpected,
      },
      {
        type: 'writeFile', targetPath: paths.formPath,
        content: serializeCfeFormXml({ root: buildBorrowedFormXml(source.formRoot, context.formatVersion as CfeFormFormatVersion) }),
        encoding: 'utf8', expected: formExpected,
      },
      {
        type: 'writeFile', targetPath: owner.metadataPath, content: ownerContent,
        encoding: 'utf8', expected: { state: 'file', hash: owner.metadataHash },
      },
    ];
    if (moduleExpected.state === 'missing') {
      steps.splice(6, 0, {
        type: 'writeFile', targetPath: paths.modulePath, content: '\uFEFF', encoding: 'utf8', expected: moduleExpected,
      });
    }
    return { kind: 'cfe.borrowForm', steps, result };
  }

  private async resolveExtensionOwnerByDotPath(context: CfeProjectContext, dotPath: string): Promise<ResolvedOwner> {
    const [type, name] = parseOwnerDotPath(dotPath);
    return this.readRootOwner(context.extensionRoot, type, name, true);
  }

  private async resolveExtensionOwnerBySourceUuid(context: CfeProjectContext, sourceUuid: string): Promise<ResolvedOwner> {
    const matches = (await this.listRootOwners(context.extensionRoot, true))
      .filter((owner) => owner.identity.ownership === 'adopted' && owner.identity.sourceUuid?.toLocaleLowerCase() === sourceUuid);
    if (matches.length === 0) {
      throw new CfeFormError('CFE_ADOPTED_OPERATION_REQUIRED', 'Сначала необходимо заимствовать владельца формы в CFE.');
    }
    if (matches.length > 1) {
      throw ownershipInvalid('UUID владельца формы связан с несколькими объектами CFE.');
    }
    return matches[0]!;
  }

  private async resolveBaseOwnerBySourceUuid(context: CfeProjectContext, sourceUuid: string): Promise<ResolvedOwner> {
    const matches = (await this.listRootOwners(context.baseRoot, false))
      .filter((owner) => owner.identity.ownership === 'own' && owner.identity.uuid.toLocaleLowerCase() === sourceUuid);
    if (matches.length === 0) {
      throw new CfeFormError('CFE_SOURCE_OBJECT_NOT_FOUND', 'В связанной основной конфигурации не найден владелец формы.');
    }
    if (matches.length > 1) {
      throw ownershipInvalid('UUID владельца формы неоднозначен в основной конфигурации.');
    }
    return matches[0]!;
  }

  private async listRootOwners(rootPath: string, extension: boolean): Promise<ResolvedOwner[]> {
    const result: ResolvedOwner[] = [];
    for (const rule of OWNER_RULES) {
      const folder = await resolveInside(rootPath, rule.folder);
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(folder, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) {
          continue;
        }
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLocaleLowerCase().endsWith('.xml')) {
          continue;
        }
        const name = path.basename(entry.name, path.extname(entry.name));
        try {
          result.push(await this.readRootOwner(rootPath, rule.type, name, extension));
        } catch (error) {
          if (error instanceof CfeFormError) {
            throw error;
          }
          throw ownershipInvalid(`Не удалось проверить владельца формы: ${message(error)}`);
        }
      }
    }
    return result;
  }

  private async readRootOwner(
    rootPath: string,
    type: CfeFormOwnerType,
    name: string,
    requireRegistered: boolean,
  ): Promise<ResolvedOwner> {
    const rule = ownerRule(type);
    assertIdentifier(name, 'Имя владельца формы');
    const metadataPath = await resolveInside(rootPath, path.join(rule.folder, `${name}.xml`));
    const metadataContent = await readFile(metadataPath, 'Не удалось прочитать XML владельца формы.');
    let identity: CfeObjectIdentity;
    try {
      identity = parseCfeObjectIdentity(metadataContent, relativePath(rootPath, metadataPath));
    } catch (error) {
      throw ownershipInvalid(`Некорректный XML владельца формы: ${message(error)}`);
    }
    if (identity.type !== type || identity.name !== name) {
      throw ownershipInvalid('Путь владельца формы не совпадает с XML-идентичностью объекта.');
    }
    if (!(await isRootObjectRegisteredInConfiguration(rootPath, type, name))) {
      throw new CfeFormError(
        requireRegistered ? 'CFE_OWNERSHIP_INVALID' : 'CFE_SOURCE_OBJECT_NOT_FOUND',
        requireRegistered
          ? 'Владелец формы не зарегистрирован в ChildObjects CFE.'
          : 'Владелец формы не зарегистрирован в ChildObjects основной конфигурации.',
      );
    }
    return { type, folder: rule.folder, identity, metadataPath, metadataContent, metadataHash: hashContent(metadataContent) };
  }

  private async resolveSourceForm(
    context: CfeProjectContext,
    owner: ResolvedOwner,
    sourceFormUuid?: string,
    sourceFormName?: string,
  ): Promise<ResolvedSourceForm> {
    const formsDirectory = await resolveInside(context.baseRoot, path.join(owner.folder, owner.identity.name, 'Forms'));
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(formsDirectory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) {
        throw new CfeFormError('CFE_SOURCE_OBJECT_NOT_FOUND', 'У владельца нет каталога Forms в основной конфигурации.');
      }
      throw error;
    }
    const normalizedUuid = sourceFormUuid === undefined ? undefined : normalizeUuid(sourceFormUuid, 'sourceFormUuid');
    const matches: ResolvedSourceForm[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLocaleLowerCase().endsWith('.xml')) {
        continue;
      }
      const metadataPath = await resolveInside(context.baseRoot, path.join(owner.folder, owner.identity.name, 'Forms', entry.name));
      const metadataContent = await readFile(metadataPath, 'Не удалось прочитать метаданные исходной формы.');
      let identity: CfeObjectIdentity;
      try {
        identity = parseCfeObjectIdentity(metadataContent, relativePath(context.baseRoot, metadataPath));
      } catch (error) {
        throw ownershipInvalid(`Некорректные метаданные исходной формы: ${message(error)}`);
      }
      if (identity.type !== 'Form' || identity.ownership !== 'own') {
        throw ownershipInvalid('Форма основной конфигурации должна быть собственным объектом Form.');
      }
      if ((normalizedUuid !== undefined && identity.uuid.toLocaleLowerCase() !== normalizedUuid)
        || (sourceFormName !== undefined && identity.name !== sourceFormName)) {
        continue;
      }
      const formPath = await resolveInside(context.baseRoot, path.join(owner.folder, owner.identity.name, 'Forms', identity.name, 'Ext', 'Form.xml'));
      const formContent = await readFile(formPath, 'Не удалось прочитать Ext/Form.xml исходной формы.');
      const formRoot = parseCfeFormXml(formContent).root;
      matches.push({
        owner, identity, formType: readFormType(metadataContent), metadataPath, metadataContent,
        metadataHash: hashContent(metadataContent), formPath, formContent, formHash: hashContent(formContent), formRoot,
      });
    }
    if (matches.length === 0) {
      throw new CfeFormError('CFE_SOURCE_OBJECT_NOT_FOUND', 'Исходная форма не найдена в связанной основной конфигурации.');
    }
    if (matches.length > 1) {
      throw ownershipInvalid('Селектор исходной формы неоднозначен.');
    }
    return matches[0]!;
  }

  private async findExtensionFormByName(
    context: CfeProjectContext,
    owner: ResolvedOwner,
    formName: string,
  ): Promise<ResolvedExtensionForm | undefined> {
    const forms = await this.listExtensionForms(context, owner);
    const matches = forms.filter((form) => form.identity.name === formName);
    if (matches.length > 1) {
      throw ownershipInvalid('Одно имя формы представлено несколькими XML-файлами CFE.');
    }
    return matches[0];
  }

  private async findExtensionFormBySourceUuid(
    context: CfeProjectContext,
    sourceUuid: string,
  ): Promise<ResolvedExtensionForm | undefined> {
    const matches: ResolvedExtensionForm[] = [];
    for (const owner of await this.listRootOwners(context.extensionRoot, true)) {
      for (const form of await this.listExtensionForms(context, owner)) {
        if (form.identity.ownership === 'adopted' && form.identity.sourceUuid?.toLocaleLowerCase() === sourceUuid) {
          matches.push(form);
        }
      }
    }
    if (matches.length > 1) {
      throw ownershipInvalid('UUID исходной формы связан с несколькими формами CFE.');
    }
    return matches[0];
  }

  private async listExtensionForms(context: CfeProjectContext, owner: ResolvedOwner): Promise<ResolvedExtensionForm[]> {
    const formsDirectory = await resolveInside(context.extensionRoot, path.join(owner.folder, owner.identity.name, 'Forms'));
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(formsDirectory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    }
    const forms: ResolvedExtensionForm[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLocaleLowerCase().endsWith('.xml')) {
        continue;
      }
      const metadataPath = await resolveInside(context.extensionRoot, path.join(owner.folder, owner.identity.name, 'Forms', entry.name));
      const metadataContent = await readFile(metadataPath, 'Не удалось прочитать метаданные формы CFE.');
      let identity: CfeObjectIdentity;
      try {
        identity = parseCfeObjectIdentity(metadataContent, relativePath(context.extensionRoot, metadataPath));
      } catch (error) {
        throw ownershipInvalid(`Некорректные метаданные формы CFE: ${message(error)}`);
      }
      if (identity.type !== 'Form') {
        throw ownershipInvalid('В каталоге Forms найден XML не формы.');
      }
      const paths = await formPaths(context.extensionRoot, owner, identity.name);
      forms.push({ extensionRoot: context.extensionRoot, owner, identity, metadataPath, metadataContent, formPath: paths.formPath, modulePath: paths.modulePath });
    }
    return forms;
  }

  private async assertSourceUnchanged(context: CfeProjectContext, source: ResolvedSourceForm): Promise<void> {
    let current: readonly string[];
    try {
      current = await Promise.all([
        fs.promises.readFile(path.join(context.baseRoot, CONFIGURATION_XML), 'utf8'),
        fs.promises.readFile(source.owner.metadataPath, 'utf8'),
        fs.promises.readFile(source.metadataPath, 'utf8'),
        fs.promises.readFile(source.formPath, 'utf8'),
      ]);
    } catch (error) {
      throw new CfeFormError('CFE_SOURCE_CHANGED', `Исходные файлы формы стали недоступны: ${message(error)}`);
    }
    if (hashContent(current[0]!) !== context.baseFingerprint
      || hashContent(current[1]!) !== source.owner.metadataHash
      || hashContent(current[2]!) !== source.metadataHash
      || hashContent(current[3]!) !== source.formHash) {
      throw new CfeFormError('CFE_SOURCE_CHANGED', 'Основная конфигурация, владелец или исходная форма изменились до commit.');
    }
  }

  private async assertDependencies(context: CfeProjectContext, dependencies: readonly CfeFormDependency[]): Promise<void> {
    for (const dependency of dependencies) {
      if (dependency.kind === 'StyleItem' && STANDARD_STYLE_ITEMS.has(dependency.name)) {
        continue;
      }
      const rootType = dependency.kind === 'EnumValue' ? 'Enum' : dependency.kind;
      const descriptor = getMetadataTypeDescriptorByRootTag(rootType);
      if (!descriptor) {
        throw dependencyUnsupported(`Тип зависимости «${rootType}» не входит в подтверждённую матрицу CFE.`);
      }
      let source: ResolvedRootDependency;
      try {
        source = await readRootDependency(context.baseRoot, rootType, descriptor.designerFolder, dependency.name, false);
      } catch (error) {
        throw dependencyUnsupported(`Зависимость ${rootType}.${dependency.name} не найдена в связанной основной конфигурации: ${message(error)}`);
      }
      let extension: ResolvedRootDependency;
      try {
        extension = await readRootDependency(context.extensionRoot, rootType, descriptor.designerFolder, dependency.name, true);
      } catch (error) {
        throw dependencyUnsupported(`Зависимость ${rootType}.${dependency.name} должна быть заранее безопасно заимствована в CFE.`);
      }
      if (extension.identity.ownership !== 'adopted' || extension.identity.sourceUuid?.toLocaleLowerCase() !== source.identity.uuid.toLocaleLowerCase()) {
        throw dependencyUnsupported(`Зависимость ${rootType}.${dependency.name} в CFE не связана с объектом основной конфигурации.`);
      }
      if (dependency.kind === 'EnumValue') {
        const valueUuid = sourceEnumValueUuid(source.content, dependency.valueName!);
        if (!valueUuid || !hasAdoptedEnumValue(extension.content, valueUuid)) {
          throw dependencyUnsupported(`Значение Enum.${dependency.name}.EnumValue.${dependency.valueName} не представлено в CFE.`);
        }
      }
    }
  }

  private async assertFormDependencies(context: CfeProjectContext, form: CfeFormXmlElement): Promise<void> {
    const unsupported = collectUnsupportedCfeFormDependencies(form);
    if (unsupported.length > 0) {
      throw dependencyUnsupported(`Неподдерживаемая ссылка метаданных в форме: ${unsupported[0]!.value}.`);
    }
    await this.assertDependencies(context, collectCfeFormDependencies(form));
  }

  private async assertOperationDependencies(context: CfeProjectContext, operations: readonly CfeFormOperation[]): Promise<void> {
    const dependencies: CfeFormDependency[] = [];
    for (const operation of operations) {
      if (operation.kind !== 'addAttribute') {
        continue;
      }
      const match = /^cfg:(Catalog|Document|Enum)Ref\.([\p{L}_][\p{L}\p{N}_]*)$/u.exec(operation.type.typeName);
      if (match) {
        dependencies.push({ kind: match[1]! as 'Catalog' | 'Document' | 'Enum', name: match[2]! });
      }
    }
    await this.assertDependencies(context, dependencies);
  }

  private async runInExtension<T>(
    context: CfeProjectContext,
    kind: string,
    execute: () => Promise<T>,
  ): Promise<T> {
    const outcome = await context.extensionSession.runExclusive({ kind, execute });
    if (outcome.status === 'committed') {
      return outcome.value;
    }
    const error = outcome.status === 'failed' || outcome.status === 'conflict' ? outcome.error : undefined;
    if (error instanceof CfeFormError) {
      throw error;
    }
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code.startsWith('CFE_')) {
      throw error;
    }
    throw new CfeFormError(
      'CFE_VALIDATION_FAILED',
      outcome.status === 'conflict'
        ? 'Состояние CFE-проекта изменилось до commit формы.'
        : error?.message ?? 'Операция с формой CFE была отменена.',
    );
  }
}

function applyOperations(
  form: CfeFormXmlElement,
  operations: readonly CfeFormOperation[],
  sourceCommandNames: ReadonlySet<string>,
): boolean {
  let changed = false;
  for (const operation of operations) {
    switch (operation.kind) {
      case 'addAttribute':
        changed = addAttribute(form, operation.name, operation.type.typeName, operation.title) || changed;
        break;
      case 'addCommand':
        changed = addCommand(form, operation.name, operation.title, operation.actions ?? [], sourceCommandNames) || changed;
        break;
      case 'addElement':
        changed = addElement(form, operation, sourceCommandNames) || changed;
        break;
      case 'setFormEvent':
        assertHandler(operation.handler);
        assertCallType(operation.callType);
        changed = appendOrVerifyEvent(form, operation.eventName, operation.handler, operation.callType) === 'added' || changed;
        break;
      case 'setElementEvent': {
        assertHandler(operation.handler);
        assertCallType(operation.callType);
        const element = findVisualElement(form, operation.elementName);
        if (!element) {
          throw validation(`Элемент формы «${operation.elementName}» не найден.`);
        }
        changed = appendOrVerifyEvent(element, operation.eventName, operation.handler, operation.callType) === 'added' || changed;
        break;
      }
      case 'addCommandAction': {
        assertHandler(operation.handler);
        assertCallType(operation.callType);
        const command = ensureActionCommand(form, operation.commandName, sourceCommandNames);
        changed = appendOrVerifyAction(command.element, operation.handler, operation.callType) === 'added' || command.created || changed;
        break;
      }
    }
  }
  return changed;
}

function addAttribute(form: CfeFormXmlElement, name: string, typeName: string, title?: string): boolean {
  assertIdentifier(name, 'Имя реквизита формы');
  assertAttributeType(typeName);
  const attributes = ensureSectionBeforeAny(form, 'Attributes', ['Commands', 'Parameters', 'CommandInterface', 'BaseForm']);
  const existing = directChildren(attributes, 'Attribute').find((attribute) => attribute.attributes.name === name);
  if (existing) {
    if (existing.attributes.id && Number(existing.attributes.id) >= 1_000_000
      && attributeMatches(existing, typeName, title)) {
      return false;
    }
    throw validation(`Реквизит формы «${name}» уже существует с другим содержимым.`);
  }
  const children: CfeFormXmlElement[] = [];
  if (title !== undefined) {
    children.push(titleElement(title));
  }
  children.push(createXmlElement('Type', {}, [createXmlElement('v8:Type', {}, [createXmlText(typeName)])]));
  attributes.children.push(createXmlElement('Attribute', { name, id: allocateExtensionFormId(form) }, children));
  return true;
}

function addCommand(
  form: CfeFormXmlElement,
  name: string,
  title: string | undefined,
  actions: readonly { readonly handler: string; readonly callType: CfeFormCallType }[],
  sourceCommandNames: ReadonlySet<string>,
): boolean {
  assertIdentifier(name, 'Имя команды формы');
  if (sourceCommandNames.has(name)) {
    throw validation(`Команда «${name}» уже существует в базовой форме; используйте addCommandAction.`);
  }
  const commands = ensureSectionBeforeAny(form, 'Commands', ['Parameters', 'CommandInterface', 'BaseForm']);
  const existing = directChildren(commands, 'Command').find((command) => command.attributes.name === name);
  if (existing) {
    if (!existing.attributes.id || Number(existing.attributes.id) < 1_000_000 || !commandMatches(existing, title, actions)) {
      throw validation(`Команда формы «${name}» уже существует с другим содержимым.`);
    }
    return false;
  }
  const command = createXmlElement('Command', { name, id: allocateExtensionFormId(form) });
  if (title !== undefined) {
    command.children.push(titleElement(title));
  }
  for (const action of actions) {
    assertHandler(action.handler);
    assertCallType(action.callType);
    appendOrVerifyAction(command, action.handler, action.callType);
  }
  commands.children.push(command);
  return true;
}

function addElement(
  form: CfeFormXmlElement,
  operation: Extract<CfeFormOperation, { readonly kind: 'addElement' }>,
  sourceCommandNames: ReadonlySet<string>,
): boolean {
  assertIdentifier(operation.name, 'Имя элемента формы');
  const existing = findVisualElement(form, operation.name);
  if (existing) {
    if (Number(existing.attributes.id ?? '0') >= 1_000_000 && elementMatches(existing, operation)) {
      return false;
    }
    throw validation(`Элемент формы «${operation.name}» уже существует с другим содержимым.`);
  }
  let container: CfeFormXmlElement;
  if (operation.parentName === undefined) {
    container = ensureSectionBeforeAny(form, 'ChildItems', ['Attributes', 'Commands', 'Parameters', 'CommandInterface', 'BaseForm']);
  } else {
    const parent = findVisualElement(form, operation.parentName);
    if (!parent || localName(parent.name) !== 'UsualGroup') {
      throw validation(`Родитель «${operation.parentName}» должен быть существующей группой UsualGroup.`);
    }
    container = firstDirectChild(parent, 'ChildItems') ?? createChildItems(parent);
  }
  const element = createXmlElement(operation.elementType, { name: operation.name, id: allocateExtensionFormId(form) });
  if (operation.title !== undefined) {
    element.children.push(titleElement(operation.title));
  }
  switch (operation.elementType) {
    case 'UsualGroup':
      element.children.push(createXmlElement('ChildItems'));
      break;
    case 'InputField':
      if (!operation.attributeName || !hasExtensionAttribute(form, operation.attributeName)) {
        throw validation('InputField должен ссылаться на существующий реквизит расширения.');
      }
      element.children.push(createXmlElement('DataPath', {}, [createXmlText(operation.attributeName)]));
      break;
    case 'Button':
      if (!operation.commandName || (!hasExtensionCommand(form, operation.commandName) && !sourceCommandNames.has(operation.commandName))) {
        throw validation('Button должен ссылаться на существующую команду формы.');
      }
      element.children.push(createXmlElement('CommandName', {}, [createXmlText(formCommandReference(operation.commandName))]));
      break;
  }
  container.children.push(element);
  return true;
}

function ensureActionCommand(
  form: CfeFormXmlElement,
  commandName: string,
  sourceCommandNames: ReadonlySet<string>,
): { readonly element: CfeFormXmlElement; readonly created: boolean } {
  assertIdentifier(commandName, 'Имя команды формы');
  const commands = ensureSectionBeforeAny(form, 'Commands', ['Parameters', 'CommandInterface', 'BaseForm']);
  const existing = directChildren(commands, 'Command').find((command) => command.attributes.name === commandName);
  if (existing) {
    return { element: existing, created: false };
  }
  if (!sourceCommandNames.has(commandName)) {
    throw validation(`Команда базовой формы «${commandName}» не найдена.`);
  }
  const wrapper = createXmlElement('Command', { name: commandName, id: allocateExtensionFormId(form) });
  commands.children.push(wrapper);
  return { element: wrapper, created: true };
}

function buildBorrowedFormXml(source: CfeFormXmlElement, version: CfeFormFormatVersion): CfeFormXmlElement {
  const result = cloneXmlElement(source);
  result.name = 'Form';
  normalizeFormNamespaces(result, version);
  const partChildren: CfeFormXmlElement[] = [];
  for (const child of directChildren(source)) {
    const name = localName(child.name);
    if (BASE_PART_EXCLUDED.has(name) || BASE_PART_ATTRIBUTE_PROPERTIES.has(name)) {
      continue;
    }
    if (name === 'AutoCommandBar') {
      partChildren.push(sanitizeAutoCommandBar(child));
      continue;
    }
    const copied = cloneXmlElement(child);
    if (name === 'ChildItems') {
      sanitizeBorrowedBasePart(copied, new Set<string>());
    }
    partChildren.push(copied);
  }
  if (!partChildren.some((child) => localName(child.name) === 'AutoCommandBar')) {
    partChildren.push(createAutoCommandBar());
  }
  if (!partChildren.some((child) => localName(child.name) === 'Attributes')) {
    partChildren.push(createXmlElement('Attributes'));
  }
  const base = createXmlElement('BaseForm', { version }, partChildren.map(cloneXmlElement));
  stripBaseFormMutations(base);
  result.children = [...partChildren, base];
  ensureBaseFormLast(result, version);
  return result;
}

function createOwnFormXml(version: CfeFormFormatVersion): CfeFormXmlElement {
  const root = createXmlElement('Form', formNamespaces(version), [createAutoCommandBar(), createXmlElement('Attributes')]);
  return root;
}

function sanitizeAutoCommandBar(source: CfeFormXmlElement): CfeFormXmlElement {
  const result = cloneXmlElement(source);
  result.attributes.name = result.attributes.name || 'ФормаКоманднаяПанель';
  result.attributes.id = '-1';
  result.children = result.children.filter((child) => child.kind !== 'element' || (
    localName(child.name) !== 'ChildItems' && localName(child.name) !== 'CommandSet'
  ));
  const autofill = firstDirectChild(result, 'Autofill');
  if (autofill) {
    setTextContent(autofill, 'false');
  } else {
    result.children.push(createXmlElement('Autofill', {}, [createXmlText('false')]));
  }
  return result;
}

function createAutoCommandBar(): CfeFormXmlElement {
  return createXmlElement('AutoCommandBar', { name: 'ФормаКоманднаяПанель', id: '-1' }, [
    createXmlElement('Autofill', {}, [createXmlText('false')]),
  ]);
}

function normalizeFormNamespaces(form: CfeFormXmlElement, version: CfeFormFormatVersion): void {
  form.attributes = { ...formNamespaces(version), ...form.attributes, version };
  if (version !== '2.21') {
    delete form.attributes['xmlns:pal'];
  }
  if (version === '2.21') {
    form.attributes['xmlns:pal'] = 'http://v8.1c.ru/8.1/data/ui/colors/palette';
  }
}

function formNamespaces(version: CfeFormFormatVersion): Record<string, string> {
  const result: Record<string, string> = {
    xmlns: 'http://v8.1c.ru/8.3/xcf/logform',
    'xmlns:app': 'http://v8.1c.ru/8.2/managed-application/core',
    'xmlns:cfg': 'http://v8.1c.ru/8.1/data/enterprise/current-config',
    'xmlns:ent': 'http://v8.1c.ru/8.1/data/enterprise',
    'xmlns:lf': 'http://v8.1c.ru/8.2/managed-application/logform',
    'xmlns:style': 'http://v8.1c.ru/8.1/data/ui/style',
    'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    'xmlns:xr': 'http://v8.1c.ru/8.3/xcf/readable',
    'xmlns:xs': 'http://www.w3.org/2001/XMLSchema',
    'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    version,
  };
  if (version === '2.21') {
    result['xmlns:pal'] = 'http://v8.1c.ru/8.1/data/ui/colors/palette';
  }
  return result;
}

function buildFormMetadataXml(
  version: CfeFormFormatVersion,
  localUuid: string,
  name: string,
  formType: 'Managed',
  ownership: 'own' | 'adopted',
  sourceUuid?: string,
): string {
  const formChildren: CfeFormXmlElement[] = [];
  if (ownership === 'adopted' && formatRank(version) >= 219) {
    formChildren.push(createXmlElement('InternalInfo', {}, [
      createXmlElement('xr:PropertyState', {}, [
        createXmlElement('xr:Property', {}, [createXmlText('Form')]),
        createXmlElement('xr:State', {}, [createXmlText('Extended')]),
      ]),
    ]));
  } else {
    formChildren.push(createXmlElement('InternalInfo'));
  }
  const properties: CfeFormXmlElement[] = [];
  if (ownership === 'adopted') {
    properties.push(createXmlElement('ObjectBelonging', {}, [createXmlText('Adopted')]));
  }
  properties.push(createXmlElement('Name', {}, [createXmlText(name)]));
  properties.push(createXmlElement('Comment'));
  if (ownership === 'adopted') {
    properties.push(createXmlElement('ExtendedConfigurationObject', {}, [createXmlText(sourceUuid!)]));
  }
  properties.push(createXmlElement('FormType', {}, [createXmlText(formType)]));
  formChildren.push(createXmlElement('Properties', {}, properties));
  const root = createXmlElement('MetaDataObject', metadataNamespaces(version), [
    createXmlElement('Form', { uuid: localUuid }, formChildren),
  ]);
  return serializeCfeFormXml({ root });
}

function metadataNamespaces(version: CfeFormFormatVersion): Record<string, string> {
  const result: Record<string, string> = {
    xmlns: 'http://v8.1c.ru/8.3/MDClasses',
    'xmlns:app': 'http://v8.1c.ru/8.2/managed-application/core',
    'xmlns:cfg': 'http://v8.1c.ru/8.1/data/enterprise/current-config',
    'xmlns:ent': 'http://v8.1c.ru/8.1/data/enterprise',
    'xmlns:lf': 'http://v8.1c.ru/8.2/managed-application/logform',
    'xmlns:style': 'http://v8.1c.ru/8.1/data/ui/style',
    'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    'xmlns:v8ui': 'http://v8.1c.ru/8.1/data/ui',
    'xmlns:xr': 'http://v8.1c.ru/8.3/xcf/readable',
    'xmlns:xs': 'http://www.w3.org/2001/XMLSchema',
    'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    version,
  };
  if (version === '2.21') {
    result['xmlns:pal'] = 'http://v8.1c.ru/8.1/data/ui/colors/palette';
  }
  return result;
}

function updateOwnerWithForm(content: string, type: CfeFormOwnerType, ownerName: string, formName: string): string {
  const document = parseCfeOrderedXml(content, 'MetaDataObject');
  const owner = directChildren(document.root).find((candidate) => localName(candidate.name) === type);
  if (!owner) {
    throw ownershipInvalid('В метаданных владельца отсутствует ожидаемый объект.');
  }
  const properties = firstDirectChild(owner, 'Properties');
  if (!properties || textContent(firstDirectChild(properties, 'Name') ?? createXmlElement('Name')) !== ownerName) {
    throw ownershipInvalid('Имя владельца в метаданных не совпадает с путём.');
  }
  const childObjects = firstDirectChild(owner, 'ChildObjects') ?? createChildObjects(owner);
  const registered = directChildren(childObjects, 'Form').some((form) => textContent(form) === formName);
  if (!registered) {
    childObjects.children.push(createXmlElement('Form', {}, [createXmlText(formName)]));
  }
  return serializeCfeFormXml(document);
}

function createChildObjects(owner: CfeFormXmlElement): CfeFormXmlElement {
  const childObjects = createXmlElement('ChildObjects');
  owner.children.push(childObjects);
  return childObjects;
}

function createChildItems(parent: CfeFormXmlElement): CfeFormXmlElement {
  const childItems = createXmlElement('ChildItems');
  parent.children.push(childItems);
  return childItems;
}

function assertAdoptedFormShape(form: CfeFormXmlElement, version: string): void {
  if (localName(form.name) !== 'Form') {
    throw ownershipInvalid('Файл Ext/Form.xml не содержит Form.');
  }
  const baseForms = directChildren(form, 'BaseForm');
  if (baseForms.length !== 1) {
    throw ownershipInvalid('Заимствованная форма обязана содержать ровно один BaseForm.');
  }
  const direct = directChildren(form);
  if (direct[direct.length - 1] !== baseForms[0]) {
    throw ownershipInvalid('BaseForm заимствованной формы должен быть последним элементом.');
  }
  if (baseForms[0]!.attributes.version !== version) {
    throw ownershipInvalid('Версия BaseForm не совпадает с форматом CFE.');
  }
  const invalid = ['Events', 'Commands', 'Parameters', 'CommandInterface']
    .some((name) => firstDirectChild(baseForms[0]!, name) !== undefined);
  if (invalid) {
    throw ownershipInvalid('BaseForm не может содержать Events, Commands, Parameters или CommandInterface.');
  }
}

function outcomeFromExtensionForm(
  status: CfeFormMutationOutcome['status'],
  form: ResolvedExtensionForm,
): CfeFormMutationOutcome {
  return {
    status,
    ownerType: form.owner.type,
    ownerName: form.owner.identity.name,
    ownerSourceUuid: form.owner.identity.sourceUuid,
    formName: form.identity.name,
    sourceFormUuid: form.identity.sourceUuid,
    metadataPath: relativePath(form.extensionRoot, form.metadataPath),
    formPath: relativePath(form.extensionRoot, form.formPath),
    modulePath: relativePath(form.extensionRoot, form.modulePath),
    localUuid: form.identity.uuid,
  };
}

interface FormPaths {
  readonly formsDirectory: string;
  readonly formDirectory: string;
  readonly extDirectory: string;
  readonly moduleDirectory: string;
  readonly metadataPath: string;
  readonly formPath: string;
  readonly modulePath: string;
}

async function formPaths(rootPath: string, owner: ResolvedOwner, formName: string): Promise<FormPaths> {
  const formsDirectory = await resolveInside(rootPath, path.join(owner.folder, owner.identity.name, 'Forms'));
  const formDirectory = await resolveInside(rootPath, path.join(owner.folder, owner.identity.name, 'Forms', formName));
  const extDirectory = await resolveInside(rootPath, path.join(owner.folder, owner.identity.name, 'Forms', formName, 'Ext'));
  const moduleDirectory = await resolveInside(rootPath, path.join(owner.folder, owner.identity.name, 'Forms', formName, 'Ext', 'Form'));
  return {
    formsDirectory, formDirectory, extDirectory, moduleDirectory,
    metadataPath: await resolveInside(rootPath, path.join(owner.folder, owner.identity.name, 'Forms', `${formName}.xml`)),
    formPath: await resolveInside(rootPath, path.join(owner.folder, owner.identity.name, 'Forms', formName, 'Ext', 'Form.xml')),
    modulePath: await resolveInside(rootPath, path.join(owner.folder, owner.identity.name, 'Forms', formName, 'Ext', 'Form', 'Module.bsl')),
  };
}

interface ResolvedRootDependency {
  readonly identity: CfeObjectIdentity;
  readonly content: string;
}

async function readRootDependency(
  rootPath: string,
  type: string,
  folder: string,
  name: string,
  requireRegistered: boolean,
): Promise<ResolvedRootDependency> {
  const target = await resolveInside(rootPath, path.join(folder, `${name}.xml`));
  const content = await readFile(target, 'Не удалось прочитать XML зависимости формы.');
  const identity = parseCfeObjectIdentity(content, relativePath(rootPath, target));
  if (identity.type !== type || identity.name !== name) {
    throw ownershipInvalid('Путь зависимости не совпадает с XML-идентичностью.');
  }
  if (requireRegistered && !(await isRootObjectRegisteredInConfiguration(rootPath, type, name))) {
    throw ownershipInvalid('Зависимость не зарегистрирована в ChildObjects CFE.');
  }
  return { identity, content };
}

function sourceEnumValueUuid(enumXml: string, valueName: string): string | undefined {
  const document = parseCfeOrderedXml(enumXml, 'MetaDataObject');
  const root = firstDirectChild(document.root, 'Enum');
  const childObjects = root ? firstDirectChild(root, 'ChildObjects') : undefined;
  for (const value of childObjects ? directChildren(childObjects, 'EnumValue') : []) {
    const properties = firstDirectChild(value, 'Properties');
    if (properties && textContent(firstDirectChild(properties, 'Name') ?? createXmlElement('Name')) === valueName) {
      return value.attributes.uuid;
    }
  }
  return undefined;
}

function hasAdoptedEnumValue(enumXml: string, sourceUuid: string): boolean {
  const document = parseCfeOrderedXml(enumXml, 'MetaDataObject');
  const root = firstDirectChild(document.root, 'Enum');
  const childObjects = root ? firstDirectChild(root, 'ChildObjects') : undefined;
  return (childObjects ? directChildren(childObjects, 'EnumValue') : []).some((value) => {
    const properties = firstDirectChild(value, 'Properties');
    return textContent(firstDirectChild(properties ?? createXmlElement('Properties'), 'ObjectBelonging') ?? createXmlElement('ObjectBelonging')) === 'Adopted'
      && textContent(firstDirectChild(properties ?? createXmlElement('Properties'), 'ExtendedConfigurationObject') ?? createXmlElement('ExtendedConfigurationObject')).toLocaleLowerCase() === sourceUuid.toLocaleLowerCase();
  });
}

function findVisualElement(form: CfeFormXmlElement, name: string): CfeFormXmlElement | undefined {
  const rootItems = firstDirectChild(form, 'ChildItems');
  if (!rootItems) {
    return undefined;
  }
  return findVisualInContainer(rootItems, name);
}

function findVisualInContainer(container: CfeFormXmlElement, name: string): CfeFormXmlElement | undefined {
  for (const child of directChildren(container)) {
    if (child.attributes.name === name) {
      return child;
    }
    const nested = firstDirectChild(child, 'ChildItems');
    if (nested) {
      const found = findVisualInContainer(nested, name);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

function hasExtensionAttribute(form: CfeFormXmlElement, name: string): boolean {
  const attributes = firstDirectChild(form, 'Attributes');
  return Boolean(attributes && directChildren(attributes, 'Attribute').some((attribute) => attribute.attributes.name === name));
}

function hasExtensionCommand(form: CfeFormXmlElement, name: string): boolean {
  const commands = firstDirectChild(form, 'Commands');
  return Boolean(commands && directChildren(commands, 'Command').some((command) => command.attributes.name === name));
}

function attributeMatches(attribute: CfeFormXmlElement, typeName: string, title: string | undefined): boolean {
  const type = firstDirectChild(attribute, 'Type');
  const scalar = type ? firstDirectChild(type, 'Type') ?? firstDirectChild(type, 'v8:Type') : undefined;
  const actualTitle = firstDirectChild(attribute, 'Title');
  return textContent(scalar ?? createXmlElement('Type')) === typeName
    && (title === undefined ? actualTitle === undefined : titleContent(actualTitle ?? createXmlElement('Title')) === title);
}

function commandMatches(
  command: CfeFormXmlElement,
  title: string | undefined,
  actions: readonly { readonly handler: string; readonly callType: CfeFormCallType }[],
): boolean {
  const actualTitle = firstDirectChild(command, 'Title');
  if ((title === undefined ? actualTitle !== undefined : titleContent(actualTitle ?? createXmlElement('Title')) !== title)) {
    return false;
  }
  const actualActions = directChildren(command, 'Action');
  return actualActions.length === actions.length && actions.every((expected) => actualActions.some((actual) => (
    actual.attributes.callType === expected.callType && textContent(actual) === expected.handler
  )));
}

function elementMatches(
  element: CfeFormXmlElement,
  operation: Extract<CfeFormOperation, { readonly kind: 'addElement' }>,
): boolean {
  if (localName(element.name) !== operation.elementType) {
    return false;
  }
  if (operation.title !== undefined && titleContent(firstDirectChild(element, 'Title') ?? createXmlElement('Title')) !== operation.title) {
    return false;
  }
  if (operation.elementType === 'InputField') {
    return textContent(firstDirectChild(element, 'DataPath') ?? createXmlElement('DataPath')) === operation.attributeName;
  }
  if (operation.elementType === 'Button') {
    return textContent(firstDirectChild(element, 'CommandName') ?? createXmlElement('CommandName')) === formCommandReference(operation.commandName ?? '');
  }
  return true;
}

function formCommandReference(commandName: string): string {
  return `Form.Command.${commandName}`;
}

function titleElement(title: string): CfeFormXmlElement {
  return createXmlElement('Title', {}, [
    createXmlElement('v8:item', {}, [
      createXmlElement('v8:lang', {}, [createXmlText('ru')]),
      createXmlElement('v8:content', {}, [createXmlText(title)]),
    ]),
  ]);
}

function titleContent(element: CfeFormXmlElement): string {
  return findTitleContent(element) ?? textContent(element);
}

function findTitleContent(element: CfeFormXmlElement): string | undefined {
  if (localName(element.name) === 'content') {
    return textContent(element);
  }
  for (const child of directChildren(element)) {
    const deeper = findTitleContent(child);
    if (deeper !== undefined) {
      return deeper;
    }
  }
  return undefined;
}

function assertCreateOwnRequest(request: CfeCreateOwnFormRequest): void {
  if (!request || typeof request.extensionConfigurationId !== 'string' || !request.extensionConfigurationId.trim()) {
    throw validation('extensionConfigurationId обязателен.');
  }
  parseOwnerDotPath(request.ownerDotPath);
  assertIdentifier(request.formName, 'Имя собственной формы');
  if (request.formType !== undefined && request.formType !== 'Managed') {
    throw validation('Поддерживается только управляемая форма.');
  }
}

function assertBorrowRequest(request: CfeBorrowFormRequest): void {
  if (!request || typeof request.extensionConfigurationId !== 'string' || !request.extensionConfigurationId.trim()) {
    throw validation('extensionConfigurationId обязателен.');
  }
  normalizeUuid(request.ownerSourceUuid, 'ownerSourceUuid');
  const hasUuid = typeof request.sourceFormUuid === 'string' && request.sourceFormUuid.trim() !== '';
  const hasName = typeof request.sourceFormName === 'string' && request.sourceFormName.trim() !== '';
  if (hasUuid === hasName) {
    throw validation('Нужно указать ровно один из sourceFormUuid или sourceFormName.');
  }
  if (hasUuid) {
    normalizeUuid(request.sourceFormUuid!, 'sourceFormUuid');
  } else {
    assertIdentifier(request.sourceFormName!, 'Имя исходной формы');
  }
}

function assertExtendRequest(request: CfeExtendFormRequest): void {
  if (!request || typeof request.extensionConfigurationId !== 'string' || !request.extensionConfigurationId.trim()) {
    throw validation('extensionConfigurationId обязателен.');
  }
  normalizeUuid(request.sourceFormUuid, 'sourceFormUuid');
  if (!/^[0-9a-f]{64}$/iu.test(request.expectedFormHash ?? '')) {
    throw validation('expectedFormHash должен быть SHA-256 исходной Form.xml.');
  }
  if (!Array.isArray(request.operations) || request.operations.length === 0) {
    throw validation('Для extendForm нужен непустой список аддитивных операций.');
  }
}

function parseOwnerDotPath(value: string): [CfeFormOwnerType, string] {
  if (typeof value !== 'string') {
    throw validation('ownerDotPath должен иметь вид Catalog.Name или Document.Name.');
  }
  const parts = value.trim().split('.');
  if (parts.length !== 2 || (parts[0] !== 'Catalog' && parts[0] !== 'Document') || !parts[1]) {
    throw validation('ownerDotPath должен иметь вид Catalog.Name или Document.Name.');
  }
  assertIdentifier(parts[1]!, 'Имя владельца формы');
  return [parts[0], parts[1]!];
}

function ownerRule(type: CfeFormOwnerType): OwnerRule {
  const result = OWNER_RULES.find((rule) => rule.type === type);
  if (!result) {
    throw validation(`Тип владельца «${type}» не поддержан.`);
  }
  return result;
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== 'string' || validateElementName(value.trim(), []) !== null) {
    throw validation(`${label} должно быть корректным идентификатором 1С.`);
  }
}

function assertOwnFormName(name: string, namePrefix: string): void {
  const prefix = namePrefix.trim();
  if (prefix !== '' && !name.startsWith(prefix)) {
    throw new CfeFormError('CFE_OWNERSHIP_INVALID', 'Имя собственной формы должно начинаться с NamePrefix CFE.');
  }
}

function assertAttributeType(typeName: string): void {
  if (typeof typeName !== 'string' || !/^(?:xs:(?:string|boolean|dateTime|decimal|integer)|cfg:(?:Catalog|Document|Enum)Ref\.[\p{L}_][\p{L}\p{N}_]*)$/u.test(typeName)) {
    throw validation('Тип реквизита формы должен быть scalar xs:* или cfg:CatalogRef/DocumentRef/EnumRef.');
  }
}

function assertHandler(value: string): void {
  assertIdentifier(value, 'Имя обработчика');
}

function assertCallType(value: CfeFormCallType): void {
  if (value !== 'Before' && value !== 'After' && value !== 'Override') {
    throw validation('callType должен быть Before, After или Override.');
  }
}

function assertFormat(value: string): asserts value is CfeFormFormatVersion {
  if (!['2.17', '2.18', '2.19', '2.20', '2.21'].includes(value)) {
    throw new CfeFormError('CFE_UNSUPPORTED_FORMAT', `Формат CFE ${value} не поддержан для форм.`);
  }
}

function formatRank(value: CfeFormFormatVersion): number {
  const [major, minor] = value.split('.').map(Number);
  return major! * 100 + minor!;
}

function normalizeUuid(value: string, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.trim())
    || value.trim().toLocaleLowerCase() === '00000000-0000-0000-0000-000000000000') {
    throw validation(`${label} должен быть ненулевым UUID.`);
  }
  return value.trim().toLocaleLowerCase();
}

async function expectationForPath(targetPath: string): Promise<MutationExpectation> {
  try {
    const stat = await fs.promises.lstat(targetPath);
    if (stat.isFile()) {
      return { state: 'file', hash: hashContent(await fs.promises.readFile(targetPath)) };
    }
    if (stat.isDirectory()) {
      return { state: 'directory' };
    }
    throw ownershipInvalid('В пути формы CFE обнаружен недопустимый файловый объект.');
  } catch (error) {
    if (isMissing(error)) {
      return { state: 'missing' };
    }
    throw error;
  }
}

async function resolveInside(rootPath: string, candidatePath: string): Promise<string> {
  const { canonicalRoot, canonicalTarget } = await assertPathWithinRoot(rootPath, path.resolve(rootPath, candidatePath));
  await assertNoSymlinkSegments(canonicalRoot, canonicalTarget);
  return canonicalTarget;
}

async function readFile(targetPath: string, errorPrefix: string): Promise<string> {
  try {
    return await fs.promises.readFile(targetPath, 'utf8');
  } catch (error) {
    throw new CfeFormError('CFE_SOURCE_OBJECT_NOT_FOUND', `${errorPrefix} ${message(error)}`);
  }
}

function readFormType(metadataContent: string): 'Managed' {
  const document = parseCfeOrderedXml(metadataContent, 'MetaDataObject');
  const form = firstDirectChild(document.root, 'Form');
  const properties = form ? firstDirectChild(form, 'Properties') : undefined;
  const formType = properties ? textContent(firstDirectChild(properties, 'FormType') ?? createXmlElement('FormType')) : '';
  if (formType !== 'Managed') {
    throw dependencyUnsupported('Поддерживаются только управляемые формы Catalog и Document.');
  }
  return 'Managed';
}

function relativePath(rootPath: string, targetPath: string): string {
  return path.relative(rootPath, targetPath).replace(/\\/g, '/');
}

function validation(messageText: string): CfeFormError {
  return new CfeFormError('CFE_VALIDATION_FAILED', messageText);
}

function ownershipInvalid(messageText: string): CfeFormError {
  return new CfeFormError('CFE_OWNERSHIP_INVALID', messageText);
}

function dependencyUnsupported(messageText: string): CfeFormError {
  return new CfeFormError('CFE_DEPENDENCY_UNSUPPORTED', messageText);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
