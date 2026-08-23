import * as fs from 'fs';
import * as path from 'path';
import { getValueByLocalName } from '../../parsers/xmlNavHelpers';
import { XmlParser } from '../../parsers/xmlParser';
import {
  assertNoSymlinkSegments,
  assertPathWithinRoot,
} from '../../services/configurationSession/pathBoundary';
import { CONFIGURATION_XML } from '../../constants/fileNames';
import {
  CfeOwnershipError,
  CfeOwnershipGuard,
  parseCfeObjectIdentity,
  type CfeGenericMutationOperation,
  type CfeObjectIdentity,
} from './ownership';

/** Filesystem-resolved CFE context used by legacy generic mutation entry points. */
export interface CfeFilesystemMutationPolicy {
  readonly rootPath: string;
  readonly namePrefix: string;
}

/**
 * Resolves the closest configuration root that is actually a CFE. The lookup is
 * intentionally filesystem based: generic UI and Agent operations do not have a
 * CFE registry/session at their boundary yet.
 */
export class CfeFilesystemMutationPolicyResolver {
  async resolve(targetPath: string): Promise<CfeFilesystemMutationPolicy | undefined> {
    const absoluteTarget = path.resolve(targetPath);
    let cursor = await initialDirectory(absoluteTarget);
    while (true) {
      const configurationPath = path.join(cursor, CONFIGURATION_XML);
      if (await exists(configurationPath)) {
        const context = await readCfeContext(configurationPath);
        if (context) {
          const { canonicalRoot, canonicalTarget } = await assertPathWithinRoot(cursor, absoluteTarget);
          if ((await fs.promises.lstat(cursor)).isSymbolicLink()) {
            throw new CfeOwnershipError('CFE_OWNERSHIP_INVALID', 'Корень CFE не может быть символической ссылкой.');
          }
          await assertNoSymlinkSegments(canonicalRoot, canonicalTarget);
          return { rootPath: cursor, namePrefix: context.namePrefix };
        }
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return undefined;
      }
      cursor = parent;
    }
  }

  async resolveObjectIdentity(
    policy: CfeFilesystemMutationPolicy,
    metadataXmlPath: string,
  ): Promise<CfeObjectIdentity> {
    const { canonicalRoot, canonicalTarget } = await assertPathWithinRoot(policy.rootPath, metadataXmlPath);
    await assertNoSymlinkSegments(canonicalRoot, canonicalTarget);
    if (path.basename(canonicalTarget).toLocaleLowerCase() === CONFIGURATION_XML.toLocaleLowerCase()) {
      throw new CfeOwnershipError('CFE_OWNERSHIP_INVALID', 'Для generic CFE-операции не указан XML корневого объекта метаданных.');
    }
    let content: string;
    try {
      content = await fs.promises.readFile(canonicalTarget, 'utf8');
    } catch (error) {
      throw new CfeOwnershipError('CFE_OWNERSHIP_INVALID', `Не удалось прочитать XML объекта CFE: ${errorMessage(error)}`);
    }
    return parseCfeObjectIdentity(content, path.relative(policy.rootPath, canonicalTarget));
  }
}

const resolver = new CfeFilesystemMutationPolicyResolver();
const guard = new CfeOwnershipGuard();

/** Rejects a generic mutation of an adopted CFE root or any of its descendants. */
export async function assertCfeGenericMutationAllowed(
  metadataXmlPath: string,
  operation: CfeGenericMutationOperation,
): Promise<void> {
  const policy = await resolver.resolve(metadataXmlPath);
  if (!policy) {
    return;
  }
  guard.assertGenericMutationAllowed(await resolver.resolveObjectIdentity(policy, metadataXmlPath), operation);
}

/** Checks a generic create under a CFE root; root creates additionally require NamePrefix. */
export async function assertCfeGenericCreateAllowed(
  targetPath: string,
  name: string,
  options: { readonly isRootObjectCreate: boolean; readonly ownerMetadataXmlPath?: string },
): Promise<void> {
  const policy = await resolver.resolve(targetPath);
  if (!policy) {
    return;
  }
  if (options.ownerMetadataXmlPath) {
    guard.assertGenericMutationAllowed(
      await resolver.resolveObjectIdentity(policy, options.ownerMetadataXmlPath),
      'create',
    );
  }
  if (options.isRootObjectCreate) {
    guard.assertOwnCreateName(name, policy);
  }
}

/** Duplicate is both a mutation of the source and a root-object create. */
export async function assertCfeGenericDuplicateAllowed(metadataXmlPath: string, name: string): Promise<void> {
  const policy = await resolver.resolve(metadataXmlPath);
  if (!policy) {
    return;
  }
  guard.assertGenericMutationAllowed(
    await resolver.resolveObjectIdentity(policy, metadataXmlPath),
    'duplicate',
  );
  guard.assertOwnCreateName(name, policy);
}

async function initialDirectory(targetPath: string): Promise<string> {
  try {
    return (await fs.promises.lstat(targetPath)).isDirectory() ? targetPath : path.dirname(targetPath);
  } catch (error) {
    if (isMissing(error)) {
      return path.dirname(targetPath);
    }
    throw error;
  }
}

async function readCfeContext(configurationPath: string): Promise<{ namePrefix: string } | undefined> {
  let content: string;
  try {
    content = await fs.promises.readFile(configurationPath, 'utf8');
  } catch (error) {
    throw new CfeOwnershipError('CFE_OWNERSHIP_INVALID', `Не удалось прочитать Configuration.xml: ${errorMessage(error)}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = XmlParser.parseString(content);
  } catch (error) {
    if (containsCfePurpose(content)) {
      throw new CfeOwnershipError('CFE_OWNERSHIP_INVALID', `Не удалось разобрать Configuration.xml расширения: ${errorMessage(error)}`);
    }
    return undefined;
  }
  let purpose: string | undefined;
  let namePrefix: string | undefined;
  try {
    const metaDataObject = singularObject(getValueByLocalName(parsed, 'MetaDataObject'));
    const configuration = singularObject(getValueByLocalName(metaDataObject, 'Configuration'));
    const properties = singularObject(getValueByLocalName(configuration, 'Properties'));
    purpose = singularText(getValueByLocalName(properties, 'ConfigurationExtensionPurpose'));
    namePrefix = singularText(getValueByLocalName(properties, 'NamePrefix'));
  } catch (error) {
    if (containsCfePurpose(content)) {
      throw error;
    }
    return undefined;
  }
  if (purpose === undefined) {
    return undefined;
  }
  if (namePrefix === undefined) {
    throw new CfeOwnershipError('CFE_OWNERSHIP_INVALID', 'В Configuration.xml расширения отсутствует NamePrefix.');
  }
  return { namePrefix };
}

function containsCfePurpose(content: string): boolean {
  return /<\s*(?:[\w.-]+:)?ConfigurationExtensionPurpose\b/i.test(content);
}

function singularObject(value: unknown): Record<string, unknown> {
  const unwrapped = unwrap(value);
  if (!unwrapped || typeof unwrapped !== 'object' || Array.isArray(unwrapped)) {
    throw new CfeOwnershipError('CFE_OWNERSHIP_INVALID', 'Структура Configuration.xml расширения некорректна.');
  }
  return unwrapped as Record<string, unknown>;
}

function singularText(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const unwrapped = unwrap(value);
  if (typeof unwrapped === 'string') {
    return unwrapped.trim();
  }
  if (unwrapped && typeof unwrapped === 'object' && !Array.isArray(unwrapped)) {
    const text = (unwrapped as Record<string, unknown>)['#text'];
    if (typeof text === 'string') {
      return text.trim();
    }
  }
  throw new CfeOwnershipError('CFE_OWNERSHIP_INVALID', 'Текстовое свойство Configuration.xml расширения некорректно.');
}

function unwrap(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  if (value.length !== 1) {
    throw new CfeOwnershipError('CFE_OWNERSHIP_INVALID', 'Повторяющийся XML-элемент в Configuration.xml расширения недопустим.');
  }
  return value[0];
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.promises.access(candidate);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
