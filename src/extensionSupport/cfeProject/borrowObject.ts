import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  getMetadataTypeDescriptorByRootTag,
  METADATA_TYPE_DESCRIPTORS,
  type MetadataTypeDescriptor,
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
import { buildBorrowedObjectShellFromSource } from './borrowObjectBuilder';
import type { CfeProjectRegistry } from './registry';
import {
  CfeProjectError,
  type CfeBorrowObjectOutcome,
  type CfeBorrowObjectRequest,
  type CfeProjectContext,
} from './types';

interface ResolvedBorrowSource {
  readonly identity: CfeObjectIdentity;
  readonly descriptor: MetadataTypeDescriptor;
  readonly path: string;
  readonly contentHash: string;
  readonly sourceXml: string;
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
      const descriptor = requireSupportedType(rootTag);
      const sourcePath = await resolveInside(context.baseRoot, path.join(descriptor.designerFolder, `${name}.xml`));
      return this.readSource(context, sourcePath, descriptor, name);
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
          const descriptor = requireSupportedType(identity.type);
          if (descriptor.designerRootTag !== rootTag) {
            continue;
          }
          matches.push(await this.readSource(context, candidatePath, descriptor));
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
    expectedDescriptor: MetadataTypeDescriptor,
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
    const identityDescriptor = getMetadataTypeDescriptorByRootTag(identity.type);
    if (identityDescriptor !== expectedDescriptor || (expectedName !== undefined && identity.name !== expectedName)) {
      throw new CfeProjectError('CFE_SOURCE_OBJECT_NOT_FOUND', 'Исходный dot-path не совпадает с XML-идентичностью объекта.');
    }
    const canonicalIdentity = { ...identity, type: expectedDescriptor.designerRootTag };
    const registered = await isRegisteredByDescriptor(context.baseRoot, expectedDescriptor, identity.name);
    if (!registered) {
      throw new CfeProjectError('CFE_SOURCE_OBJECT_NOT_FOUND', 'Исходный объект не зарегистрирован в ChildObjects связанной основной конфигурации.');
    }
    return {
      identity: canonicalIdentity,
      descriptor: expectedDescriptor,
      path: canonicalPath,
      contentHash: hashContent(content),
      sourceXml: content,
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

    const objectPath = path.join(context.extensionRoot, source.descriptor.designerFolder, `${source.identity.name}.xml`);
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
    if (await isRegisteredByDescriptor(context.extensionRoot, source.descriptor, source.identity.name)) {
      throw new CfeProjectError('CFE_OWNERSHIP_INVALID', 'ChildObjects CFE уже содержит объект без соответствующей UUID-связи.');
    }

    const localUuid = randomUUID();
    const projection = buildBorrowedObjectShellFromSource({
      sourceXml: source.sourceXml,
      identity: source.identity,
      formatVersion: context.formatVersion,
      localUuid,
    });
    if (!projection.ok) {
      throw new CfeProjectError('CFE_OWNERSHIP_INVALID', projection.reason);
    }
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
        content: projection.xml,
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

function requireSupportedType(rootTag: string): MetadataTypeDescriptor {
  const descriptor = getMetadataTypeDescriptorByRootTag(rootTag);
  if (!descriptor || !descriptor.structure.designerRootObject) {
    throw new CfeProjectError(
      'CFE_DEPENDENCY_UNSUPPORTED',
      `Заимствование корневого типа «${rootTag}» не поддерживается реестром метаданных.`,
    );
  }
  return descriptor;
}

async function isRegisteredByDescriptor(
  rootPath: string,
  descriptor: MetadataTypeDescriptor,
  objectName: string,
): Promise<boolean> {
  const rootTags = [descriptor.designerRootTag, ...(descriptor.designerRootTagAliases ?? [])];
  for (const rootTag of rootTags) {
    if (await isRootObjectRegisteredInConfiguration(rootPath, rootTag, objectName)) {
      return true;
    }
  }
  return false;
}

function normalizeUuid(value: string): string {
  const uuid = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(uuid)
    || uuid.toLocaleLowerCase() === '00000000-0000-0000-0000-000000000000') {
    throw new CfeProjectError('CFE_VALIDATION_FAILED', 'sourceUuid должен быть ненулевым UUID корневого объекта.');
  }
  return uuid.toLocaleLowerCase();
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

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
