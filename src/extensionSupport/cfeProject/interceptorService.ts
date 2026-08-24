import * as fs from 'fs';
import * as path from 'path';
import { getMetadataTypeDescriptorByRootTag, METADATA_TYPE_DESCRIPTORS } from '../../constants/metadataTypeDescriptors';
import { CONFIGURATION_XML } from '../../constants/fileNames';
import { hashContent } from '../../services/configurationSession/atomicFileStorage';
import type { MutationExpectation, MutationPlan, MutationStep } from '../../services/configurationSession/mutationPlan';
import { assertNoSymlinkSegments, assertPathWithinRoot } from '../../services/configurationSession/pathBoundary';
import { isRootObjectRegisteredInConfiguration } from '../../services/configurationXmlUpdater';
import { validateElementName } from '../../utils/elementNameValidator';
import {
  BslStructuralError,
  buildCanonicalInterceptorBlock,
  findBslMethod,
  normalizeBslEol,
  scanBslInterceptorBlocks,
  scanBslMethods,
  wrapInterceptorBlock,
  type BslMethod,
} from './bslInterceptorScanner';
import {
  CfeInterceptorError,
  type CfeCreateInterceptorOutcome,
  type CfeCreateInterceptorRequest,
  type CfeInterceptorKind,
  type CfeModuleKind,
} from './interceptorTypes';
import { parseCfeObjectIdentity, type CfeObjectIdentity } from './ownership';
import type { CfeProjectRegistry } from './registry';
import { CfeProjectError, type CfeProjectContext } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256_RE = /^[0-9a-f]{64}$/iu;

const MODULE_COMPATIBILITY: Readonly<Record<string, readonly CfeModuleKind[]>> = Object.freeze({
  Catalog: Object.freeze(['ObjectModule', 'ManagerModule'] as const),
  Document: Object.freeze(['ObjectModule', 'ManagerModule'] as const),
  CommonModule: Object.freeze(['Module'] as const),
});

const MODULE_FILE_NAMES: Readonly<Record<CfeModuleKind, string>> = Object.freeze({
  Module: 'Module.bsl',
  ObjectModule: 'ObjectModule.bsl',
  ManagerModule: 'ManagerModule.bsl',
  RecordSetModule: 'RecordSetModule.bsl',
  ValueManagerModule: 'ValueManagerModule.bsl',
});

const INTERCEPTOR_SUFFIX: Readonly<Record<CfeInterceptorKind, string>> = Object.freeze({
  before: 'Перед',
  after: 'После',
  instead: 'Вместо',
  changeAndValidate: 'ИзменениеИКонтроль',
});

interface MetadataRecord {
  readonly identity: CfeObjectIdentity;
  readonly filePath: string;
  readonly content: string;
  readonly contentHash: string;
}

interface ResolvedInterceptorTarget {
  readonly extensionObject: MetadataRecord;
  readonly baseObject: MetadataRecord;
  readonly sourceModulePath: string;
  readonly sourceModuleContent: string;
  readonly sourceModuleHash: string;
  readonly method: BslMethod;
  readonly extensionModulePath: string;
}

interface ExistingFile {
  readonly path: string;
  readonly content: string;
  readonly expected: MutationExpectation;
}

/**
 * Structural CFE interceptor domain service. It has no Agent/UI knowledge and every
 * mutation is a single extension-session MutationPlan guarded by source fingerprints.
 */
export class CfeInterceptorService {
  constructor(private readonly projects: CfeProjectRegistry) {}

  async createInterceptor(request: CfeCreateInterceptorRequest): Promise<CfeCreateInterceptorOutcome> {
    assertRequest(request);
    const context = await this.projects.getByExtension(String(request.extensionConfigurationId));
    const target = await this.resolveTarget(context, request);
    await this.assertSourceUnchanged(context, target, request);

    const operation = await context.extensionSession.runExclusive({
      kind: 'cfe.createInterceptor',
      execute: async () => {
        await this.assertSourceUnchanged(context, target, request);
        const planOrOutcome = await this.buildPlan(context, target, request);
        if (!isMutationPlan(planOrOutcome)) {
          return planOrOutcome;
        }
        await this.assertSourceUnchanged(context, target, request);
        return context.extensionSession.mutations.execute(planOrOutcome);
      },
    });
    if (operation.status === 'committed') {
      return operation.value;
    }
    if ((operation.status === 'failed' || operation.status === 'conflict') && operation.error) {
      if (operation.error instanceof CfeProjectError || operation.error instanceof CfeInterceptorError) {
        throw operation.error;
      }
    }
    throw new CfeProjectError(
      'CFE_VALIDATION_FAILED',
      operation.status === 'conflict'
        ? 'Состояние CFE-проекта изменилось до записи перехватчика.'
        : 'Не удалось создать перехватчик CFE.',
    );
  }

  private async resolveTarget(
    context: CfeProjectContext,
    request: CfeCreateInterceptorRequest,
  ): Promise<ResolvedInterceptorTarget> {
    const sourceUuid = normalizeUuid(request.targetSourceUuid, 'targetSourceUuid');
    const extensionMatches = (await readMetadataRecords(context.extensionRoot))
      .filter((record) => (
        record.identity.ownership === 'adopted'
        && record.identity.sourceUuid?.toLocaleLowerCase() === sourceUuid
      ));
    if (extensionMatches.length === 0) {
      throw new CfeProjectError('CFE_SOURCE_OBJECT_NOT_FOUND', 'Заимствованный объект CFE с указанным UUID не найден.');
    }
    if (extensionMatches.length > 1) {
      throw new CfeProjectError('CFE_OWNERSHIP_INVALID', 'Один UUID основной конфигурации связан с несколькими объектами CFE.');
    }
    const extensionObject = extensionMatches[0]!;
    const baseMatches = (await readMetadataRecords(context.baseRoot))
      .filter((record) => record.identity.uuid.toLocaleLowerCase() === sourceUuid);
    if (baseMatches.length === 0) {
      throw new CfeProjectError('CFE_SOURCE_OBJECT_NOT_FOUND', 'Объект с указанным UUID не найден в связанной основной конфигурации.');
    }
    if (baseMatches.length > 1) {
      throw new CfeProjectError('CFE_OWNERSHIP_INVALID', 'UUID исходного объекта неоднозначен в основной конфигурации.');
    }
    const baseObject = baseMatches[0]!;
    if (baseObject.identity.ownership !== 'own' || baseObject.identity.type !== extensionObject.identity.type) {
      throw new CfeProjectError('CFE_OWNERSHIP_INVALID', 'Заимствованный объект CFE не совпадает с собственным объектом связанной основной конфигурации.');
    }
    assertCompatibleModule(baseObject.identity.type, request.moduleKind);
    const registered = await isRootObjectRegisteredInConfiguration(
      context.baseRoot,
      baseObject.identity.type,
      baseObject.identity.name,
    );
    if (!registered) {
      throw new CfeProjectError('CFE_SOURCE_OBJECT_NOT_FOUND', 'Исходный объект не зарегистрирован в ChildObjects связанной основной конфигурации.');
    }

    const sourceModulePath = await modulePathFor(
      context.baseRoot,
      baseObject.identity.type,
      baseObject.identity.name,
      request.moduleKind,
    );
    const extensionModulePath = await modulePathFor(
      context.extensionRoot,
      extensionObject.identity.type,
      extensionObject.identity.name,
      request.moduleKind,
    );
    const sourceModuleContent = await readRequiredFile(sourceModulePath, 'Исходный модуль для перехвата не найден.');
    const method = parseSourceMethod(sourceModuleContent, request.methodName);
    if ((request.kind === 'before' || request.kind === 'after') && method.kind === 'function') {
      throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Для функции доступны только перехватчики instead и changeAndValidate.');
    }
    assertExpectedHash(request, method.sourceHash);
    return {
      extensionObject,
      baseObject,
      sourceModulePath,
      sourceModuleContent,
      sourceModuleHash: hashContent(sourceModuleContent),
      method,
      extensionModulePath,
    };
  }

  private async assertSourceUnchanged(
    context: CfeProjectContext,
    target: ResolvedInterceptorTarget,
    request: CfeCreateInterceptorRequest,
  ): Promise<void> {
    let configurationContent: string;
    let objectContent: string;
    let moduleContent: string;
    try {
      const baseConfigurationPath = await safePath(context.baseRoot, path.join(context.baseRoot, CONFIGURATION_XML));
      const baseObjectPath = await safePath(context.baseRoot, target.baseObject.filePath);
      const sourceModulePath = await safePath(context.baseRoot, target.sourceModulePath);
      [configurationContent, objectContent, moduleContent] = await Promise.all([
        readRequiredFile(baseConfigurationPath, 'Основная конфигурация недоступна.'),
        readRequiredFile(baseObjectPath, 'Исходный объект изменился или стал недоступен.'),
        readRequiredFile(sourceModulePath, 'Исходный модуль изменился или стал недоступен.'),
      ]);
    } catch (error) {
      if (error instanceof CfeProjectError) {
        throw new CfeProjectError('CFE_SOURCE_CHANGED', 'Исходная конфигурация изменилась или стала недоступна.');
      }
      throw error;
    }
    if (
      hashContent(configurationContent) !== context.baseFingerprint
      || hashContent(objectContent) !== target.baseObject.contentHash
      || hashContent(moduleContent) !== target.sourceModuleHash
    ) {
      throw new CfeProjectError('CFE_SOURCE_CHANGED', 'Исходная конфигурация, объект или модуль изменились до commit.');
    }
    const currentMethod = parseSourceMethod(moduleContent, request.methodName);
    if (currentMethod.sourceHash !== target.method.sourceHash) {
      throw new CfeProjectError('CFE_SOURCE_CHANGED', 'Исходный метод изменился до commit.');
    }
    assertExpectedHash(request, currentMethod.sourceHash);
  }

  private async buildPlan(
    context: CfeProjectContext,
    target: ResolvedInterceptorTarget,
    request: CfeCreateInterceptorRequest,
  ): Promise<MutationPlan<CfeCreateInterceptorOutcome> | CfeCreateInterceptorOutcome> {
    const extensionObjectPath = await safePath(context.extensionRoot, target.extensionObject.filePath);
    const extensionModulePath = await safePath(context.extensionRoot, target.extensionModulePath);
    const objectFile = await readExistingFile(extensionObjectPath);
    const currentIdentity = parseIdentity(objectFile.content, extensionObjectPath);
    if (
      currentIdentity.ownership !== 'adopted'
      || currentIdentity.sourceUuid?.toLocaleLowerCase() !== target.baseObject.identity.uuid.toLocaleLowerCase()
    ) {
      throw new CfeProjectError('CFE_OWNERSHIP_INVALID', 'Целевой объект CFE изменил связь с основной конфигурацией.');
    }
    const moduleFile = await readOptionalFile(extensionModulePath);
    const extensionMethods = parseExtensionMethods(moduleFile.content);
    const existingInterceptors = parseExtensionInterceptors(moduleFile.content)
      .filter((block) => (
        block.interceptorKind === request.kind
        && block.targetMethodName.toLocaleLowerCase() === target.method.normalizedName
      ));
    if (existingInterceptors.length > 1) {
      throw new CfeInterceptorError('CFE_INTERCEPTOR_CONFLICT', 'Для одного метода уже существует несколько перехватчиков этого типа.');
    }

    const propertyState = ensureModulePropertyState(
      objectFile.content,
      request.moduleKind,
      context.formatVersion,
    );
    let outcomeStatus: CfeCreateInterceptorOutcome['status'];
    let interceptorName: string;
    let moduleContent: string | undefined;
    if (existingInterceptors.length === 1) {
      const existing = existingInterceptors[0]!;
      interceptorName = existing.method.name;
      const expectedCore = buildCanonicalInterceptorBlock(target.method, request.kind, interceptorName);
      if (normalizeBslEol(existing.coreText) !== normalizeBslEol(expectedCore)) {
        throw new CfeInterceptorError(
          'CFE_INTERCEPTOR_CONFLICT',
          'Существующий перехватчик отличается от канонического тела и не будет перезаписан.',
        );
      }
      outcomeStatus = 'already-exists';
    } else {
      interceptorName = chooseInterceptorName(context.namePrefix, target.method.name, request.kind, extensionMethods);
      const core = buildCanonicalInterceptorBlock(target.method, request.kind, interceptorName);
      const wrapped = wrapInterceptorBlock(target.method.wrappers, core);
      moduleContent = appendInterceptorBlock(moduleFile.content, wrapped);
      outcomeStatus = 'created';
    }

    const outcome: CfeCreateInterceptorOutcome = {
      status: outcomeStatus,
      targetType: target.extensionObject.identity.type,
      targetName: target.extensionObject.identity.name,
      targetSourceUuid: target.baseObject.identity.uuid,
      moduleKind: request.moduleKind,
      methodName: target.method.name,
      interceptorName,
      modulePath: path.relative(context.extensionRoot, extensionModulePath).replace(/\\/gu, '/'),
      sourceHash: target.method.sourceHash,
      propertyStateUpdated: propertyState.changed,
    };
    const steps: MutationStep[] = [];
    if (moduleContent !== undefined) {
      steps.push({ type: 'ensureDirectory', targetPath: path.dirname(extensionModulePath) });
      steps.push({
        type: 'writeFile',
        targetPath: extensionModulePath,
        content: moduleContent,
        encoding: 'utf8',
        expected: moduleFile.expected,
      });
    }
    if (propertyState.changed) {
      steps.push({
        type: 'writeFile',
        targetPath: extensionObjectPath,
        content: propertyState.content,
        encoding: 'utf8',
        expected: objectFile.expected,
      });
    }
    if (steps.length === 0) {
      return outcome;
    }
    return { kind: 'cfe.createInterceptor', steps, result: outcome };
  }
}

function assertRequest(request: CfeCreateInterceptorRequest): void {
  normalizeUuid(request.targetSourceUuid, 'targetSourceUuid');
  if (!isModuleKind(request.moduleKind)) {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Указан неподдерживаемый вид модуля CFE.');
  }
  if (!isInterceptorKind(request.kind)) {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Указан неподдерживаемый вид перехватчика CFE.');
  }
  if (typeof request.methodName !== 'string' || validateElementName(request.methodName.trim(), []) !== null) {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Имя метода должно быть корректным идентификатором 1С.');
  }
  if (request.expectedSourceHash !== undefined && !SHA256_RE.test(request.expectedSourceHash)) {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'expectedSourceHash должен быть SHA-256 хэшем исходного метода.');
  }
  if (request.kind === 'changeAndValidate' && request.expectedSourceHash === undefined) {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Для changeAndValidate требуется expectedSourceHash исходного метода.');
  }
}

function assertCompatibleModule(type: string, moduleKind: CfeModuleKind): void {
  if (!MODULE_COMPATIBILITY[type]?.includes(moduleKind)) {
    throw new CfeProjectError(
      'CFE_DEPENDENCY_UNSUPPORTED',
      `Перехват модуля «${moduleKind}» объекта «${type}» пока не подтверждён матрицей CFE.`,
    );
  }
}

async function readMetadataRecords(root: string): Promise<readonly MetadataRecord[]> {
  const records: MetadataRecord[] = [];
  for (const descriptor of METADATA_TYPE_DESCRIPTORS) {
    const folder = await safePath(root, path.join(root, descriptor.designerFolder));
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(folder, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) {
        continue;
      }
      throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Не удалось прочитать каталог объектов CFE.');
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Символьные ссылки в каталоге объектов CFE запрещены.');
      }
      if (!entry.isFile() || !entry.name.toLocaleLowerCase().endsWith('.xml')) {
        continue;
      }
      const filePath = await safePath(root, path.join(folder, entry.name));
      const content = await readRequiredFile(filePath, 'Файл объекта CFE стал недоступен.');
      const identity = parseIdentity(content, path.relative(root, filePath).replace(/\\/gu, '/'));
      if (identity.type !== descriptor.designerRootTag) {
        throw new CfeProjectError('CFE_OWNERSHIP_INVALID', 'Тип XML-объекта не соответствует каталогу Designer.');
      }
      records.push({ identity, filePath, content, contentHash: hashContent(content) });
    }
  }
  return records;
}

async function modulePathFor(
  root: string,
  type: string,
  name: string,
  moduleKind: CfeModuleKind,
): Promise<string> {
  const descriptor = getMetadataTypeDescriptorByRootTag(type);
  if (!descriptor) {
    throw new CfeProjectError('CFE_DEPENDENCY_UNSUPPORTED', `Тип объекта «${type}» не поддержан для перехватов CFE.`);
  }
  return safePath(root, path.join(root, descriptor.designerFolder, name, 'Ext', MODULE_FILE_NAMES[moduleKind]));
}

async function safePath(root: string, candidate: string): Promise<string> {
  try {
    const boundary = await assertPathWithinRoot(root, candidate);
    await assertNoSymlinkSegments(boundary.canonicalRoot, boundary.canonicalTarget);
    return boundary.canonicalTarget;
  } catch {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Путь объекта CFE не прошёл проверку границ workspace.');
  }
}

async function readRequiredFile(filePath: string, missingMessage: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissing(error)) {
      throw new CfeProjectError('CFE_SOURCE_OBJECT_NOT_FOUND', missingMessage);
    }
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Не удалось прочитать файл CFE.');
  }
}

async function readExistingFile(filePath: string): Promise<ExistingFile> {
  const content = await readRequiredFile(filePath, 'Файл объекта CFE не найден.');
  return { path: filePath, content, expected: { state: 'file', hash: hashContent(content) } };
}

async function readOptionalFile(filePath: string): Promise<ExistingFile> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    return { path: filePath, content, expected: { state: 'file', hash: hashContent(content) } };
  } catch (error) {
    if (isMissing(error)) {
      return { path: filePath, content: '', expected: { state: 'missing' } };
    }
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Не удалось прочитать модуль CFE.');
  }
}

function parseIdentity(content: string, location: string): CfeObjectIdentity {
  try {
    return parseCfeObjectIdentity(content, location);
  } catch (error) {
    if (error instanceof CfeProjectError) {
      throw error;
    }
    throw new CfeProjectError('CFE_OWNERSHIP_INVALID', 'Не удалось проверить идентичность объекта CFE.');
  }
}

function parseSourceMethod(content: string, methodName: string): BslMethod {
  try {
    const method = findBslMethod(content, methodName.trim());
    if (!method) {
      throw new CfeProjectError('CFE_SOURCE_OBJECT_NOT_FOUND', 'Метод не найден в исходном модуле.');
    }
    return method;
  } catch (error) {
    if (error instanceof CfeProjectError) {
      throw error;
    }
    if (error instanceof BslStructuralError) {
      throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Не удалось структурно разобрать исходный BSL-модуль.');
    }
    throw error;
  }
}

function parseExtensionMethods(content: string): readonly BslMethod[] {
  if (content.trim() === '') {
    return [];
  }
  try {
    return scanBslMethods(content);
  } catch (error) {
    if (error instanceof BslStructuralError) {
      throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Не удалось структурно разобрать модуль CFE.');
    }
    throw error;
  }
}

function parseExtensionInterceptors(content: string) {
  if (content.trim() === '') {
    return [];
  }
  try {
    return scanBslInterceptorBlocks(content);
  } catch (error) {
    if (error instanceof BslStructuralError) {
      throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Не удалось структурно разобрать перехватчики модуля CFE.');
    }
    throw error;
  }
}

function chooseInterceptorName(
  namePrefix: string,
  sourceMethodName: string,
  interceptorKind: CfeInterceptorKind,
  existingMethods: readonly BslMethod[],
): string {
  const candidate = `${namePrefix}${sourceMethodName}`;
  if (validateElementName(candidate, []) !== null) {
    throw new CfeProjectError('CFE_OWNERSHIP_INVALID', 'NamePrefix CFE не позволяет сформировать корректное имя перехватчика.');
  }
  const taken = new Set(existingMethods.map((method) => method.normalizedName));
  if (!taken.has(candidate.toLocaleLowerCase())) {
    return candidate;
  }
  const withKind = `${candidate}_${INTERCEPTOR_SUFFIX[interceptorKind]}`;
  if (!taken.has(withKind.toLocaleLowerCase())) {
    return withKind;
  }
  for (let index = 2; index < Number.MAX_SAFE_INTEGER; index++) {
    const numbered = `${withKind}_${index}`;
    if (!taken.has(numbered.toLocaleLowerCase())) {
      return numbered;
    }
  }
  throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Не удалось подобрать уникальное имя перехватчика CFE.');
}

function appendInterceptorBlock(existing: string, block: string): string {
  const hasBom = existing.startsWith('\uFEFF');
  const body = existing.replace(/^\uFEFF/u, '');
  const prefix = hasBom || body.trim() === '' ? '\uFEFF' : '';
  if (body.trim() === '') {
    return `${prefix}${block}\r\n`;
  }
  const separator = body.endsWith('\n') ? '\r\n' : '\r\n\r\n';
  return `${prefix}${body}${separator}${block}\r\n`;
}

function ensureModulePropertyState(
  objectXml: string,
  moduleKind: CfeModuleKind,
  formatVersion: string,
): { readonly content: string; readonly changed: boolean } {
  if (formatRank(formatVersion) < 219) {
    return { content: objectXml, changed: false };
  }
  const property = moduleKind;
  const escapedProperty = escapeRegExp(property);
  const existing = new RegExp(
    `<xr:PropertyState>\\s*<xr:Property>\\s*${escapedProperty}\\s*</xr:Property>[\\s\\S]*?</xr:PropertyState>`,
    'iu',
  );
  if (existing.test(objectXml)) {
    return { content: objectXml, changed: false };
  }
  const newline = objectXml.includes('\r\n') ? '\r\n' : '\n';
  const empty = /([ \t]*)<InternalInfo\s*\/>/iu.exec(objectXml);
  if (empty) {
    const indent = empty[1]!;
    const propertyState = propertyStateXml(property, `${indent}\t`, newline);
    const replacement = `${indent}<InternalInfo>${newline}${propertyState}${newline}${indent}</InternalInfo>`;
    return {
      content: objectXml.slice(0, empty.index) + replacement + objectXml.slice(empty.index! + empty[0].length),
      changed: true,
    };
  }
  const internalInfo = /([ \t]*)<InternalInfo\b[^>]*>[\s\S]*?<\/InternalInfo>/iu.exec(objectXml);
  if (!internalInfo || internalInfo.index === undefined) {
    throw new CfeProjectError('CFE_OWNERSHIP_INVALID', 'У заимствованного объекта CFE отсутствует InternalInfo для PropertyState.');
  }
  const closingOffset = internalInfo.index + internalInfo[0].lastIndexOf('</InternalInfo>');
  const closingLineStart = objectXml.lastIndexOf('\n', closingOffset) + 1;
  const closingIndent = objectXml.slice(closingLineStart, closingOffset);
  const propertyState = propertyStateXml(property, `${closingIndent}\t`, newline);
  return {
    content: objectXml.slice(0, closingLineStart) + propertyState + newline + closingIndent + objectXml.slice(closingOffset),
    changed: true,
  };
}

function propertyStateXml(property: string, indent: string, newline: string): string {
  return [
    `${indent}<xr:PropertyState>`,
    `${indent}\t<xr:Property>${property}</xr:Property>`,
    `${indent}\t<xr:State>Extended</xr:State>`,
    `${indent}</xr:PropertyState>`,
  ].join(newline);
}

function formatRank(value: string): number {
  const match = /^(\d+)\.(\d+)$/u.exec(value);
  return match ? Number(match[1]) * 100 + Number(match[2]) : 0;
}

function assertExpectedHash(request: CfeCreateInterceptorRequest, sourceHash: string): void {
  if (request.expectedSourceHash !== undefined && request.expectedSourceHash.toLocaleLowerCase() !== sourceHash) {
    throw new CfeProjectError('CFE_SOURCE_CHANGED', 'Хэш исходного метода не совпадает с ожидаемым значением.');
  }
}

function normalizeUuid(value: unknown, parameterName: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value.trim()) || value.trim().toLocaleLowerCase() === '00000000-0000-0000-0000-000000000000') {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', `${parameterName} должен быть ненулевым UUID.`);
  }
  return value.trim().toLocaleLowerCase();
}

function isModuleKind(value: unknown): value is CfeModuleKind {
  return value === 'Module'
    || value === 'ObjectModule'
    || value === 'ManagerModule'
    || value === 'RecordSetModule'
    || value === 'ValueManagerModule';
}

function isInterceptorKind(value: unknown): value is CfeInterceptorKind {
  return value === 'before' || value === 'after' || value === 'instead' || value === 'changeAndValidate';
}

function isMutationPlan(
  value: MutationPlan<CfeCreateInterceptorOutcome> | CfeCreateInterceptorOutcome,
): value is MutationPlan<CfeCreateInterceptorOutcome> {
  return 'steps' in value;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
