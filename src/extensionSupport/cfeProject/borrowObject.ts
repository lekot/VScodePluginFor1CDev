import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  getMetadataTypeDescriptorByRootTag,
  METADATA_TYPE_DESCRIPTORS,
} from '../../constants/metadataTypeDescriptors';
import { CONFIGURATION_XML } from '../../constants/fileNames';
import {
  buildRootObjectConfigurationContent,
  isRootObjectRegisteredInConfiguration,
} from '../../services/configurationXmlUpdater';
import { hashContent } from '../../services/configurationSession/atomicFileStorage';
import type { MutationExpectation, MutationPlan, MutationStep } from '../../services/configurationSession/mutationPlan';
import { assertNoSymlinkSegments, assertPathWithinRoot } from '../../services/configurationSession/pathBoundary';
import { validateElementName } from '../../utils/elementNameValidator';
import { parseCfeObjectIdentity, type CfeObjectIdentity } from './ownership';
import type { CfeProjectRegistry } from './registry';
import {
  CfeProjectError,
  type CfeBorrowObjectOutcome,
  type CfeBorrowObjectRequest,
  type CfeProjectContext,
} from './types';

interface GeneratedTypeDefinition {
  readonly prefix: string;
  readonly category: string;
}

interface CfeBorrowTypeRule {
  readonly designerFolder: string;
  readonly generatedTypes: readonly GeneratedTypeDefinition[];
  readonly requiresChildObjects: boolean;
  readonly copiedBooleanProperties?: readonly string[];
}

/**
 * The first borrow vertical deliberately supports only root types whose shell and
 * dependency closure are backed by the CFE oracle. New types must be added here
 * together with their required properties and dependency test cases.
 */
export const CFE_BORROW_TYPE_MATRIX: Readonly<Record<string, CfeBorrowTypeRule>> = Object.freeze({
  Catalog: Object.freeze({
    designerFolder: 'Catalogs',
    generatedTypes: Object.freeze([
      { prefix: 'CatalogObject', category: 'Object' },
      { prefix: 'CatalogRef', category: 'Ref' },
      { prefix: 'CatalogSelection', category: 'Selection' },
      { prefix: 'CatalogList', category: 'List' },
      { prefix: 'CatalogManager', category: 'Manager' },
    ]),
    requiresChildObjects: true,
  }),
  Document: Object.freeze({
    designerFolder: 'Documents',
    generatedTypes: Object.freeze([
      { prefix: 'DocumentObject', category: 'Object' },
      { prefix: 'DocumentRef', category: 'Ref' },
      { prefix: 'DocumentSelection', category: 'Selection' },
      { prefix: 'DocumentList', category: 'List' },
      { prefix: 'DocumentManager', category: 'Manager' },
    ]),
    requiresChildObjects: true,
  }),
  Enum: Object.freeze({
    designerFolder: 'Enums',
    generatedTypes: Object.freeze([
      { prefix: 'EnumRef', category: 'Ref' },
      { prefix: 'EnumManager', category: 'Manager' },
      { prefix: 'EnumList', category: 'List' },
    ]),
    requiresChildObjects: true,
  }),
  CommonModule: Object.freeze({
    designerFolder: 'CommonModules',
    generatedTypes: Object.freeze([]),
    requiresChildObjects: false,
    copiedBooleanProperties: Object.freeze([
      'Global',
      'ClientManagedApplication',
      'Server',
      'ExternalConnection',
      'ClientOrdinaryApplication',
      'ServerCall',
    ]),
  }),
});

interface ResolvedBorrowSource {
  readonly identity: CfeObjectIdentity;
  readonly rule: CfeBorrowTypeRule;
  readonly path: string;
  readonly contentHash: string;
  readonly copiedProperties: Readonly<Record<string, string>>;
}

/** CFE domain service for transactional root-object borrowing. */
export class CfeBorrowService {
  constructor(private readonly projects: CfeProjectRegistry) {}

  async borrowObject(request: CfeBorrowObjectRequest): Promise<CfeBorrowObjectOutcome> {
    assertBorrowRequest(request);
    const context = await this.projects.getByExtension(String(request.extensionConfigurationId));
    const source = await this.resolveSource(context, request);
    await this.assertBaseUnchanged(context, source);

    const outcome = await context.extensionSession.runExclusive({
      kind: 'cfe.borrowObject',
      execute: async () => {
        // The extension FIFO can delay this operation behind another mutation. Re-read
        // the source fence after admission and once again immediately before plan commit.
        await this.assertBaseUnchanged(context, source);
        const planOrOutcome = await this.buildPlan(context, source);
        if ('status' in planOrOutcome) {
          return planOrOutcome;
        }
        await this.assertBaseUnchanged(context, source);
        return context.extensionSession.mutations.execute(planOrOutcome);
      },
    });

    if (outcome.status === 'committed') {
      return outcome.value;
    }
    if (outcome.status === 'failed' || outcome.status === 'conflict') {
      if (outcome.error instanceof CfeProjectError) {
        throw outcome.error;
      }
      throw new CfeProjectError(
        'CFE_VALIDATION_FAILED',
        outcome.status === 'conflict'
          ? 'Состояние CFE-проекта изменилось до заимствования объекта.'
          : outcome.error?.message ?? 'Не удалось заимствовать объект в CFE-проект.',
      );
    }
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Операция заимствования была отменена.');
  }

  private async resolveSource(
    context: CfeProjectContext,
    request: CfeBorrowObjectRequest,
  ): Promise<ResolvedBorrowSource> {
    if (request.sourceDotPath !== undefined) {
      const { rootTag, name } = parseDotPath(request.sourceDotPath);
      const rule = requireSupportedType(rootTag);
      const sourcePath = await resolveInside(context.baseRoot, path.join(rule.designerFolder, `${name}.xml`));
      return this.readSource(context, sourcePath, rootTag, name);
    }

    const sourceUuid = normalizeUuid(request.sourceUuid!);
    const matches: ResolvedBorrowSource[] = [];
    for (const descriptor of METADATA_TYPE_DESCRIPTORS) {
      const rootTag = descriptor.designerRootTag;
      const folder = await resolveInside(context.baseRoot, descriptor.designerFolder);
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
        const candidatePath = path.join(folder, entry.name);
        const content = await fs.promises.readFile(candidatePath, 'utf8');
        const identity = parseCfeObjectIdentity(content, path.relative(context.baseRoot, candidatePath).replace(/\\/g, '/'));
        if (identity.uuid.toLocaleLowerCase() === sourceUuid) {
          requireSupportedType(identity.type);
          matches.push(await this.readSource(context, candidatePath, rootTag));
        }
      }
    }
    if (matches.length === 0) {
      throw new CfeProjectError('CFE_SOURCE_OBJECT_NOT_FOUND', 'Объект с указанным UUID не найден в связанной основной конфигурации.');
    }
    if (matches.length > 1) {
      throw new CfeProjectError('CFE_OWNERSHIP_INVALID', 'UUID исходного объекта неоднозначен в основной конфигурации.');
    }
    return matches[0]!;
  }

  private async readSource(
    context: CfeProjectContext,
    sourcePath: string,
    expectedRootTag: string,
    expectedName?: string,
  ): Promise<ResolvedBorrowSource> {
    const canonicalPath = await resolveInside(context.baseRoot, sourcePath);
    let content: string;
    try {
      content = await fs.promises.readFile(canonicalPath, 'utf8');
    } catch (error) {
      if (isMissing(error)) {
        throw new CfeProjectError('CFE_SOURCE_OBJECT_NOT_FOUND', 'Исходный объект не найден в связанной основной конфигурации.');
      }
      throw error;
    }
    const identity = parseCfeObjectIdentity(content, path.relative(context.baseRoot, canonicalPath).replace(/\\/g, '/'));
    if (identity.ownership !== 'own') {
      throw new CfeProjectError('CFE_OWNERSHIP_INVALID', 'Исходный объект должен быть собственным объектом связанной основной конфигурации.');
    }
    if (identity.type !== expectedRootTag || (expectedName !== undefined && identity.name !== expectedName)) {
      throw new CfeProjectError('CFE_SOURCE_OBJECT_NOT_FOUND', 'Исходный dot-path не совпадает с XML-идентичностью объекта.');
    }
    const rule = requireSupportedType(identity.type);
    const registered = await isRootObjectRegisteredInConfiguration(context.baseRoot, identity.type, identity.name);
    if (!registered) {
      throw new CfeProjectError('CFE_SOURCE_OBJECT_NOT_FOUND', 'Исходный объект не зарегистрирован в ChildObjects связанной основной конфигурации.');
    }
    return {
      identity,
      rule,
      path: canonicalPath,
      contentHash: hashContent(content),
      copiedProperties: readCopiedProperties(content, rule),
    };
  }

  private async assertBaseUnchanged(context: CfeProjectContext, source: ResolvedBorrowSource): Promise<void> {
    const [baseXml, sourceXml] = await Promise.all([
      fs.promises.readFile(path.join(context.baseRoot, CONFIGURATION_XML), 'utf8'),
      fs.promises.readFile(source.path, 'utf8'),
    ]).catch((error: unknown) => {
      throw new CfeProjectError('CFE_SOURCE_CHANGED', `Исходная конфигурация изменилась или стала недоступна: ${message(error)}`);
    });
    if (hashContent(baseXml) !== context.baseFingerprint || hashContent(sourceXml) !== source.contentHash) {
      throw new CfeProjectError('CFE_SOURCE_CHANGED', 'Исходная конфигурация или заимствуемый объект изменились до commit.');
    }
  }

  private async buildPlan(
    context: CfeProjectContext,
    source: ResolvedBorrowSource,
  ): Promise<MutationPlan<CfeBorrowObjectOutcome> | CfeBorrowObjectOutcome> {
    const existing = await this.findExtensionObjectBySourceUuid(context, source.identity.uuid);
    if (existing) {
      if (existing.type !== source.identity.type) {
        throw new CfeProjectError('CFE_OWNERSHIP_INVALID', 'UUID исходного объекта уже связан с несовместимым объектом CFE.');
      }
      return outcomeFromIdentity('already-borrowed', existing);
    }

    const objectPath = path.join(context.extensionRoot, source.rule.designerFolder, `${source.identity.name}.xml`);
    const configurationPath = path.join(context.extensionRoot, CONFIGURATION_XML);
    const [objectExpected, configurationContent] = await Promise.all([
      expectationForPath(objectPath),
      fs.promises.readFile(configurationPath, 'utf8'),
    ]);
    if (objectExpected.state !== 'missing') {
      throw new CfeProjectError(
        'CFE_OWNERSHIP_INVALID',
        `Имя «${source.identity.type}.${source.identity.name}» уже занято другим объектом CFE.`,
      );
    }
    if (await isRootObjectRegisteredInConfiguration(context.extensionRoot, source.identity.type, source.identity.name)) {
      throw new CfeProjectError('CFE_OWNERSHIP_INVALID', 'ChildObjects CFE уже содержит объект без соответствующей UUID-связи.');
    }

    const localUuid = randomUUID();
    const relativeObjectPath = path.relative(context.extensionRoot, objectPath).replace(/\\/g, '/');
    const result: CfeBorrowObjectOutcome = {
      status: 'borrowed',
      type: source.identity.type,
      name: source.identity.name,
      sourceUuid: source.identity.uuid,
      objectPath: relativeObjectPath,
      localUuid,
    };
    const folderPath = path.dirname(objectPath);
    const steps: MutationStep[] = [
      { type: 'ensureDirectory', targetPath: folderPath },
      {
        type: 'writeFile',
        targetPath: objectPath,
        content: buildAdoptedObjectXml(source, context.formatVersion, localUuid),
        encoding: 'utf8',
        expected: objectExpected,
      },
      {
        type: 'writeFile',
        targetPath: configurationPath,
        content: buildRootObjectConfigurationContent(configurationContent, {
          type: 'add', rootTag: source.identity.type, objectName: source.identity.name,
        }),
        encoding: 'utf8',
        expected: { state: 'file', hash: hashContent(configurationContent) },
      },
    ];
    return { kind: 'cfe.borrowObject', steps, result };
  }

  private async findExtensionObjectBySourceUuid(
    context: CfeProjectContext,
    sourceUuid: string,
  ): Promise<CfeObjectIdentity | undefined> {
    const normalizedSourceUuid = sourceUuid.toLocaleLowerCase();
    const matches: CfeObjectIdentity[] = [];
    for (const descriptor of METADATA_TYPE_DESCRIPTORS) {
      const folder = path.join(context.extensionRoot, descriptor.designerFolder);
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
        const objectPath = path.join(folder, entry.name);
        let identity: CfeObjectIdentity;
        try {
          identity = parseCfeObjectIdentity(
            await fs.promises.readFile(objectPath, 'utf8'),
            path.relative(context.extensionRoot, objectPath).replace(/\\/g, '/'),
          );
        } catch (error) {
          throw new CfeProjectError('CFE_OWNERSHIP_INVALID', `Не удалось проверить объект CFE: ${message(error)}`);
        }
        if (identity.ownership === 'adopted' && identity.sourceUuid?.toLocaleLowerCase() === normalizedSourceUuid) {
          matches.push(identity);
        }
      }
    }
    if (matches.length > 1) {
      throw new CfeProjectError('CFE_OWNERSHIP_INVALID', 'Один UUID исходного объекта связан с несколькими объектами CFE.');
    }
    return matches[0];
  }
}

function assertBorrowRequest(request: CfeBorrowObjectRequest): void {
  const hasDotPath = typeof request.sourceDotPath === 'string' && request.sourceDotPath.trim() !== '';
  const hasUuid = typeof request.sourceUuid === 'string' && request.sourceUuid.trim() !== '';
  if (hasDotPath === hasUuid) {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Нужно указать ровно один из sourceDotPath или sourceUuid.');
  }
  if ((!hasDotPath && request.sourceDotPath !== undefined) || (!hasUuid && request.sourceUuid !== undefined)) {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'Параметр источника должен быть непустой строкой.');
  }
}

function parseDotPath(value: string): { rootTag: string; name: string } {
  const parts = value.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1] || validateElementName(parts[0], []) !== null || validateElementName(parts[1], []) !== null) {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'sourceDotPath должен иметь вид Type.Name корневого объекта.');
  }
  return { rootTag: parts[0]!, name: parts[1]! };
}

function requireSupportedType(rootTag: string): CfeBorrowTypeRule {
  const descriptor = getMetadataTypeDescriptorByRootTag(rootTag);
  if (!descriptor || descriptor.designerRootTag !== rootTag || !CFE_BORROW_TYPE_MATRIX[rootTag]) {
    throw new CfeProjectError(
      'CFE_DEPENDENCY_UNSUPPORTED',
      `Заимствование типа «${rootTag}» пока не поддержано: его каноническое замыкание зависимостей не подтверждено.`,
    );
  }
  return CFE_BORROW_TYPE_MATRIX[rootTag]!;
}

function normalizeUuid(value: string): string {
  const uuid = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(uuid)
    || uuid.toLocaleLowerCase() === '00000000-0000-0000-0000-000000000000') {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'sourceUuid должен быть ненулевым UUID корневого объекта.');
  }
  return uuid.toLocaleLowerCase();
}

function readCopiedProperties(xml: string, rule: CfeBorrowTypeRule): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const property of rule.copiedBooleanProperties ?? []) {
    const value = scalarElement(xml, property);
    if (value !== undefined && value !== 'true' && value !== 'false') {
      throw new CfeProjectError('CFE_OWNERSHIP_INVALID', `Свойство ${property} исходного общего модуля имеет недопустимое значение.`);
    }
    result[property] = value ?? 'false';
  }
  return result;
}

function buildAdoptedObjectXml(source: ResolvedBorrowSource, formatVersion: string, localUuid: string): string {
  const { identity, rule } = source;
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<MetaDataObject ${xmlNamespaces(formatVersion)} version="${formatVersion}">`,
    `\t<${identity.type} uuid="${localUuid}">`,
  ];
  if (rule.generatedTypes.length === 0) {
    lines.push('\t\t<InternalInfo/>');
  } else {
    lines.push('\t\t<InternalInfo>');
    for (const generatedType of rule.generatedTypes) {
      lines.push(`\t\t\t<xr:GeneratedType name="${generatedType.prefix}.${escapeXml(identity.name)}" category="${generatedType.category}">`);
      lines.push(`\t\t\t\t<xr:TypeId>${randomUUID()}</xr:TypeId>`);
      lines.push(`\t\t\t\t<xr:ValueId>${randomUUID()}</xr:ValueId>`);
      lines.push('\t\t\t</xr:GeneratedType>');
    }
    lines.push('\t\t</InternalInfo>');
  }
  lines.push('\t\t<Properties>');
  lines.push('\t\t\t<ObjectBelonging>Adopted</ObjectBelonging>');
  lines.push(`\t\t\t<Name>${escapeXml(identity.name)}</Name>`);
  lines.push('\t\t\t<Comment/>');
  lines.push(`\t\t\t<ExtendedConfigurationObject>${identity.uuid}</ExtendedConfigurationObject>`);
  for (const property of rule.copiedBooleanProperties ?? []) {
    lines.push(`\t\t\t<${property}>${source.copiedProperties[property] ?? 'false'}</${property}>`);
  }
  lines.push('\t\t</Properties>');
  if (rule.requiresChildObjects) {
    lines.push('\t\t<ChildObjects/>');
  }
  lines.push(`\t</${identity.type}>`);
  lines.push('</MetaDataObject>');
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function xmlNamespaces(formatVersion: string): string {
  const palette = formatVersion === '2.21' ? ' xmlns:pal="http://v8.1c.ru/8.1/data/ui/colors/palette"' : '';
  return `xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform"${palette} xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`;
}

function outcomeFromIdentity(status: CfeBorrowObjectOutcome['status'], identity: CfeObjectIdentity): CfeBorrowObjectOutcome {
  if (!identity.sourceUuid) {
    throw new CfeProjectError('CFE_OWNERSHIP_INVALID', 'Найдена локальная CFE-идентичность без UUID исходного объекта.');
  }
  return {
    status,
    type: identity.type,
    name: identity.name,
    sourceUuid: identity.sourceUuid,
    objectPath: identity.path,
    localUuid: identity.uuid,
  };
}

function scalarElement(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(xml)?.[1]?.trim();
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
    throw new CfeProjectError('CFE_OWNERSHIP_INVALID', `Недопустимый файловый объект CFE: ${targetPath}`);
  } catch (error) {
    if (isMissing(error)) {
      return { state: 'missing' };
    }
    throw error;
  }
}

async function resolveInside(rootPath: string, candidatePath: string): Promise<string> {
  const { canonicalRoot, canonicalTarget } = await assertPathWithinRoot(
    rootPath,
    path.resolve(rootPath, candidatePath),
  );
  await assertNoSymlinkSegments(canonicalRoot, canonicalTarget);
  return canonicalTarget;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
