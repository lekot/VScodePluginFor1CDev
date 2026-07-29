import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  FileDatabaseStamp,
  PreparedSupportSupplierFile,
  SupportPayloadCacheKey,
} from './supportTypes';

const SCHEMA_VERSION = 1;
const POINTER_FILE = 'current.json';
const MANIFEST_FILE = 'manifest.json';
const SHA256 = /^[0-9a-f]{64}$/;

export interface SupportPayloadCacheRecord {
  readonly key: SupportPayloadCacheKey;
  readonly databaseStamp: FileDatabaseStamp;
  readonly observedSemanticDigest: string;
  readonly supplierFiles: readonly PreparedSupportSupplierFile[];
  readonly acknowledgedGenerationId?: string;
}

export interface SupportPayloadCacheWrite {
  readonly key: SupportPayloadCacheKey;
  readonly databaseStamp: FileDatabaseStamp;
  readonly observedSemanticDigest: string;
  readonly supplierFiles: readonly {
    readonly supplierConfigurationId: string;
    readonly relativePath: string;
    readonly content: Uint8Array;
  }[];
  readonly acknowledgedGenerationId?: string;
}

interface PersistedPointer {
  readonly version: typeof SCHEMA_VERSION;
  readonly versionId: string;
}

interface PersistedSupplierFile {
  readonly supplierConfigurationId: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly storedName: string;
}

interface PersistedManifest {
  readonly version: typeof SCHEMA_VERSION;
  readonly versionId: string;
  readonly key: SupportPayloadCacheKey;
  readonly databaseStamp: FileDatabaseStamp;
  readonly observedSemanticDigest: string;
  readonly supplierFiles: readonly PersistedSupplierFile[];
  readonly acknowledgedGenerationId?: string;
}

export interface SupportPayloadCacheDeps {
  readonly readFile?: typeof fs.readFile;
  readonly mkdir?: typeof fs.mkdir;
  readonly rename?: typeof fs.rename;
  readonly rm?: typeof fs.rm;
  readonly readdir?: typeof fs.readdir;
  readonly realpath?: typeof fs.realpath;
  readonly stat?: typeof fs.stat;
  readonly open?: typeof fs.open;
}

/** Immutable version directories published through one atomic pointer per cache key. */
export class SupportPayloadCache {
  private readonly cacheRoot: string;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    extensionStorageRoot: string,
    private readonly deps: SupportPayloadCacheDeps = {},
  ) {
    this.cacheRoot = path.join(path.resolve(extensionStorageRoot), 'support-payload-cache-v1');
  }

  load(key: SupportPayloadCacheKey, stamp: FileDatabaseStamp): Promise<SupportPayloadCacheRecord | undefined> {
    return this.runKeyExclusive(key, async () => {
      try {
        const hit = await this.loadUnlocked(key);
        if (!sameFileDatabaseStamp(hit.databaseStamp, stamp)) {
          await this.invalidateUnlocked(key);
          return undefined;
        }
        return hit;
      } catch (error) {
        if (!isMissing(error)) {
          await this.invalidateUnlocked(key).catch(() => undefined);
        }
        return undefined;
      }
    });
  }

  store(write: SupportPayloadCacheWrite): Promise<SupportPayloadCacheRecord> {
    return this.runKeyExclusive(write.key, () => this.storeUnlocked(write));
  }

  acknowledge(
    key: SupportPayloadCacheKey,
    expectedStamp: FileDatabaseStamp,
    actualStamp: FileDatabaseStamp,
    generationId: string,
  ): Promise<SupportPayloadCacheRecord | undefined> {
    return this.runKeyExclusive(key, async () => {
      if (!SHA256.test(generationId)) {
        throw new Error('Acknowledged support generation must be a SHA-256 digest.');
      }
      let current: SupportPayloadCacheRecord;
      try {
        current = await this.loadUnlocked(key);
      } catch (error) {
        if (isMissing(error)) { return undefined; }
        throw error;
      }
      if (!sameFileDatabaseStamp(current.databaseStamp, expectedStamp)) {
        await this.invalidateUnlocked(key);
        return undefined;
      }
      const published = await this.storeUnlocked({
        key,
        databaseStamp: actualStamp,
        observedSemanticDigest: current.observedSemanticDigest,
        supplierFiles: current.supplierFiles.map((supplier) => ({
          supplierConfigurationId: supplier.supplierConfigurationId,
          relativePath: supplier.relativePath,
          content: supplier.content,
        })),
        acknowledgedGenerationId: generationId,
      });
      if (published.acknowledgedGenerationId !== generationId) {
        throw new Error('Support payload acknowledgement was not published atomically.');
      }
      return published;
    });
  }

  invalidate(key: SupportPayloadCacheKey): Promise<void> {
    return this.runKeyExclusive(key, () => this.invalidateUnlocked(key));
  }

  private async loadUnlocked(key: SupportPayloadCacheKey): Promise<SupportPayloadCacheRecord> {
    const keyRoot = this.keyRoot(key);
    const pointer = parsePointer(await this.readUtf8(path.join(keyRoot, POINTER_FILE)));
    const versionRoot = path.join(keyRoot, 'versions', pointer.versionId);
    const manifest = parseManifest(await this.readUtf8(path.join(versionRoot, MANIFEST_FILE)));
    if (manifest.versionId !== pointer.versionId || !sameKey(manifest.key, key)) {
      throw new Error('Support payload cache pointer does not match its immutable manifest.');
    }
    validateManifestSupplierSet(manifest);
    const supplierFiles = await Promise.all(manifest.supplierFiles.map(async (supplier) => {
      const content = Buffer.from(await (this.deps.readFile ?? fs.readFile)(
        path.join(versionRoot, supplier.storedName),
      ));
      if (sha256(content) !== supplier.sha256) {
        throw new Error(`Cached supplier payload hash mismatch: ${supplier.relativePath}.`);
      }
      return Object.freeze({
        supplierConfigurationId: supplier.supplierConfigurationId,
        relativePath: supplier.relativePath,
        sha256: supplier.sha256,
        cacheEntryId: manifest.versionId,
        content,
      });
    }));
    return Object.freeze({
      key: freezeKey(manifest.key),
      databaseStamp: Object.freeze({ ...manifest.databaseStamp }),
      observedSemanticDigest: manifest.observedSemanticDigest,
      supplierFiles: Object.freeze(supplierFiles),
      ...(manifest.acknowledgedGenerationId
        ? { acknowledgedGenerationId: manifest.acknowledgedGenerationId }
        : {}),
    });
  }

  private async storeUnlocked(write: SupportPayloadCacheWrite): Promise<SupportPayloadCacheRecord> {
    validateWrite(write);
    const keyRoot = this.keyRoot(write.key);
    const versionsRoot = path.join(keyRoot, 'versions');
    await (this.deps.mkdir ?? fs.mkdir)(versionsRoot, { recursive: true });
    const versionId = randomUUID();
    const temporaryVersionRoot = path.join(versionsRoot, `.tmp-${versionId}`);
    const publishedVersionRoot = path.join(versionsRoot, versionId);
    try {
      await (this.deps.mkdir ?? fs.mkdir)(temporaryVersionRoot, { recursive: false });
      const persistedSuppliers: PersistedSupplierFile[] = [];
      const sortedSuppliers = [...write.supplierFiles].sort((left, right) =>
        left.supplierConfigurationId.localeCompare(right.supplierConfigurationId));
      for (let index = 0; index < sortedSuppliers.length; index += 1) {
        const supplier = sortedSuppliers[index]!;
        const content = Buffer.from(supplier.content);
        const storedName = `supplier-${index}.cf`;
        await writeNewAndSync(path.join(temporaryVersionRoot, storedName), content, this.deps);
        persistedSuppliers.push({
          supplierConfigurationId: supplier.supplierConfigurationId,
          relativePath: normalizeRelativePath(supplier.relativePath),
          sha256: sha256(content),
          storedName,
        });
      }
      const manifest: PersistedManifest = {
        version: SCHEMA_VERSION,
        versionId,
        key: freezeKey(write.key),
        databaseStamp: Object.freeze({ ...write.databaseStamp }),
        observedSemanticDigest: write.observedSemanticDigest,
        supplierFiles: persistedSuppliers,
        ...(write.acknowledgedGenerationId
          ? { acknowledgedGenerationId: write.acknowledgedGenerationId }
          : {}),
      };
      await writeNewAndSync(
        path.join(temporaryVersionRoot, MANIFEST_FILE),
        Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
        this.deps,
      );
      await syncDirectory(temporaryVersionRoot, this.deps);
      await (this.deps.rename ?? fs.rename)(temporaryVersionRoot, publishedVersionRoot);
      await syncDirectory(versionsRoot, this.deps);

      const pointerTemp = path.join(keyRoot, `.pointer-${randomUUID()}.tmp`);
      try {
        const pointer: PersistedPointer = { version: SCHEMA_VERSION, versionId };
        await writeNewAndSync(
          pointerTemp,
          Buffer.from(`${JSON.stringify(pointer)}\n`, 'utf8'),
          this.deps,
        );
        await (this.deps.rename ?? fs.rename)(pointerTemp, path.join(keyRoot, POINTER_FILE));
        await syncDirectory(keyRoot, this.deps);
      } finally {
        await (this.deps.rm ?? fs.rm)(pointerTemp, { force: true }).catch(() => undefined);
      }

      const published = await this.loadUnlocked(write.key);
      await this.removeObsoleteVersions(versionsRoot, versionId);
      return published;
    } finally {
      await (this.deps.rm ?? fs.rm)(temporaryVersionRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async removeObsoleteVersions(versionsRoot: string, currentVersionId: string): Promise<void> {
    try {
      const names = await (this.deps.readdir ?? fs.readdir)(versionsRoot);
      for (const name of names) {
        if (name !== currentVersionId && !name.startsWith('.tmp-')) {
          await (this.deps.rm ?? fs.rm)(path.join(versionsRoot, name), {
            recursive: true,
            force: true,
          }).catch(() => undefined);
        }
      }
    } catch {
      // Immutable obsolete versions are harmless and can be collected by a later publication.
    }
  }

  private async invalidateUnlocked(key: SupportPayloadCacheKey): Promise<void> {
    await (this.deps.rm ?? fs.rm)(this.keyRoot(key), { recursive: true, force: true });
  }

  private runKeyExclusive<T>(key: SupportPayloadCacheKey, operation: () => Promise<T>): Promise<T> {
    const lockKey = canonicalKey(key);
    const predecessor = this.tails.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = predecessor.then(() => gate, () => gate);
    this.tails.set(lockKey, tail);
    return predecessor.catch(() => undefined).then(operation).finally(() => {
      release();
      if (this.tails.get(lockKey) === tail) {
        this.tails.delete(lockKey);
      }
    });
  }

  private keyRoot(key: SupportPayloadCacheKey): string {
    return path.join(this.cacheRoot, sha256(Buffer.from(canonicalKey(key), 'utf8')));
  }

  private readUtf8(filePath: string): Promise<string> {
    return (this.deps.readFile ?? fs.readFile)(filePath, 'utf8');
  }
}

export async function readFileDatabaseStamp(
  databaseFilePath: string,
  deps: Pick<SupportPayloadCacheDeps, 'realpath' | 'stat'> = {},
): Promise<FileDatabaseStamp> {
  const resolvedPath = await (deps.realpath ?? fs.realpath)(databaseFilePath);
  const stat = await (deps.stat ?? fs.stat)(resolvedPath, { bigint: true });
  if (!stat.isFile()) {
    throw new Error(`File database stamp target is not a file: ${resolvedPath}.`);
  }
  return Object.freeze({
    resolvedPath,
    fileId: `${stat.dev.toString(16)}:${stat.ino.toString(16)}`,
    length: Number(stat.size),
    lastWriteTimeUtcTicks: (621355968000000000n + stat.mtimeNs / 100n).toString(),
  });
}

export function sameFileDatabaseStamp(left: FileDatabaseStamp, right: FileDatabaseStamp): boolean {
  return normalizeAbsolutePath(left.resolvedPath) === normalizeAbsolutePath(right.resolvedPath)
    && left.fileId === right.fileId
    && left.length === right.length
    && left.lastWriteTimeUtcTicks === right.lastWriteTimeUtcTicks;
}

function validateWrite(write: SupportPayloadCacheWrite): void {
  if (!SHA256.test(write.observedSemanticDigest)) {
    throw new Error('Observed support semantic digest must be a SHA-256 digest.');
  }
  if (
    write.acknowledgedGenerationId !== undefined
    && !SHA256.test(write.acknowledgedGenerationId)
  ) {
    throw new Error('Acknowledged support generation must be a SHA-256 digest.');
  }
  const keyIds = sortedUnique(write.key.supplierConfigurationIds, 'cache-key supplier IDs');
  const fileIds = sortedUnique(
    write.supplierFiles.map((supplier) => supplier.supplierConfigurationId),
    'supplier payload IDs',
  );
  if (JSON.stringify(keyIds) !== JSON.stringify(fileIds)) {
    throw new Error('Support payload must contain exactly one file per cache-key supplier identity.');
  }
  const paths = write.supplierFiles.map((supplier) => normalizeRelativePath(supplier.relativePath));
  if (new Set(paths).size !== paths.length) {
    throw new Error('Support payload supplier paths must be unique.');
  }
}

function validateManifestSupplierSet(manifest: PersistedManifest): void {
  const keyIds = sortedUnique(manifest.key.supplierConfigurationIds, 'manifest cache-key supplier IDs');
  const supplierIds = sortedUnique(
    manifest.supplierFiles.map((supplier) => supplier.supplierConfigurationId),
    'manifest supplier IDs',
  );
  if (JSON.stringify(keyIds) !== JSON.stringify(supplierIds)) {
    throw new Error('Support cache manifest supplier identities are incomplete.');
  }
  const paths = manifest.supplierFiles.map((supplier) => normalizeRelativePath(supplier.relativePath));
  const storedNames = manifest.supplierFiles.map((supplier) => supplier.storedName);
  if (new Set(paths).size !== paths.length || new Set(storedNames).size !== storedNames.length) {
    throw new Error('Support cache manifest contains duplicate supplier paths or stored names.');
  }
}

function parsePointer(text: string): PersistedPointer {
  const value = JSON.parse(text) as Partial<PersistedPointer>;
  if (
    value.version !== SCHEMA_VERSION
    || typeof value.versionId !== 'string'
    || !/^[0-9a-f-]{36}$/i.test(value.versionId)
    || Object.keys(value).some((key) => key !== 'version' && key !== 'versionId')
  ) {
    throw new Error('Support payload cache pointer is invalid.');
  }
  return value as PersistedPointer;
}

function parseManifest(text: string): PersistedManifest {
  const value = JSON.parse(text) as Partial<PersistedManifest>;
  const exactKeys = new Set([
    'version',
    'versionId',
    'key',
    'databaseStamp',
    'observedSemanticDigest',
    'supplierFiles',
    ...(value.acknowledgedGenerationId === undefined ? [] : ['acknowledgedGenerationId']),
  ]);
  if (
    value.version !== SCHEMA_VERSION
    || typeof value.versionId !== 'string'
    || !/^[0-9a-f-]{36}$/i.test(value.versionId)
    || !isCacheKey(value.key)
    || !isDatabaseStamp(value.databaseStamp)
    || typeof value.observedSemanticDigest !== 'string'
    || !SHA256.test(value.observedSemanticDigest)
    || !Array.isArray(value.supplierFiles)
    || value.supplierFiles.length === 0
    || !value.supplierFiles.every(isPersistedSupplier)
    || (value.acknowledgedGenerationId !== undefined
      && (typeof value.acknowledgedGenerationId !== 'string'
        || !SHA256.test(value.acknowledgedGenerationId)))
    || Object.keys(value).some((key) => !exactKeys.has(key))
    || [...exactKeys].some((key) => !(key in value))
  ) {
    throw new Error('Support payload cache manifest is invalid.');
  }
  return value as PersistedManifest;
}

function isCacheKey(value: unknown): value is SupportPayloadCacheKey {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
  const key = value as Partial<SupportPayloadCacheKey>;
  const exact = ['canonicalTargetId', 'platformVersion', 'configurationId', 'supplierConfigurationIds', 'formatRevision'];
  return typeof key.canonicalTargetId === 'string' && key.canonicalTargetId.length > 0
    && typeof key.platformVersion === 'string' && key.platformVersion.length > 0
    && typeof key.configurationId === 'string' && key.configurationId.length > 0
    && typeof key.formatRevision === 'string' && key.formatRevision.length > 0
    && Array.isArray(key.supplierConfigurationIds)
    && key.supplierConfigurationIds.length > 0
    && key.supplierConfigurationIds.every((id) => typeof id === 'string' && id.length > 0)
    && Object.keys(value).every((candidate) => exact.includes(candidate))
    && exact.every((candidate) => candidate in value);
}

function isDatabaseStamp(value: unknown): value is FileDatabaseStamp {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
  const stamp = value as Partial<FileDatabaseStamp>;
  const exact = ['resolvedPath', 'fileId', 'length', 'lastWriteTimeUtcTicks'];
  return typeof stamp.resolvedPath === 'string' && stamp.resolvedPath.length > 0
    && typeof stamp.fileId === 'string' && stamp.fileId.length > 0
    && typeof stamp.length === 'number' && Number.isSafeInteger(stamp.length) && stamp.length >= 0
    && typeof stamp.lastWriteTimeUtcTicks === 'string' && /^\d+$/.test(stamp.lastWriteTimeUtcTicks)
    && Object.keys(value).every((candidate) => exact.includes(candidate))
    && exact.every((candidate) => candidate in value);
}

function isPersistedSupplier(value: unknown): value is PersistedSupplierFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
  const supplier = value as Partial<PersistedSupplierFile>;
  const exact = ['supplierConfigurationId', 'relativePath', 'sha256', 'storedName'];
  return typeof supplier.supplierConfigurationId === 'string' && supplier.supplierConfigurationId.length > 0
    && typeof supplier.relativePath === 'string' && supplier.relativePath.length > 0
    && typeof supplier.sha256 === 'string' && SHA256.test(supplier.sha256)
    && typeof supplier.storedName === 'string' && /^supplier-\d+\.cf$/.test(supplier.storedName)
    && Object.keys(value).every((candidate) => exact.includes(candidate))
    && exact.every((candidate) => candidate in value);
}

function sameKey(left: SupportPayloadCacheKey, right: SupportPayloadCacheKey): boolean {
  return canonicalKey(left) === canonicalKey(right);
}

function canonicalKey(key: SupportPayloadCacheKey): string {
  return JSON.stringify({
    canonicalTargetId: key.canonicalTargetId,
    platformVersion: key.platformVersion,
    configurationId: key.configurationId,
    supplierConfigurationIds: [...key.supplierConfigurationIds].sort(),
    formatRevision: key.formatRevision,
  });
}

function freezeKey(key: SupportPayloadCacheKey): SupportPayloadCacheKey {
  return Object.freeze({
    ...key,
    supplierConfigurationIds: Object.freeze([...key.supplierConfigurationIds].sort()),
  });
}

function sortedUnique(values: readonly string[], field: string): string[] {
  if (values.length === 0 || values.some((value) => !value)) {
    throw new Error(`${field} must be non-empty.`);
  }
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length) {
    throw new Error(`${field} must be unique.`);
  }
  return sorted;
}

function normalizeRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  if (
    !normalized
    || path.posix.isAbsolute(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Unsafe support payload relative path: ${relativePath}.`);
  }
  return normalized;
}

function normalizeAbsolutePath(absolutePath: string): string {
  const normalized = path.resolve(absolutePath);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

async function writeNewAndSync(
  filePath: string,
  content: Buffer,
  deps: SupportPayloadCacheDeps,
): Promise<void> {
  const handle = await (deps.open ?? fs.open)(filePath, 'wx');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string, deps: SupportPayloadCacheDeps): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await (deps.open ?? fs.open)(directoryPath, 'r');
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) { throw error; }
  } finally {
    await handle?.close();
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (process.platform !== 'win32' || !error || typeof error !== 'object' || !('code' in error)) {
    return false;
  }
  const code = (error as { code?: string }).code;
  return code === 'EPERM' || code === 'EINVAL' || code === 'ENOTSUP' || code === 'EISDIR';
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error
    && (error as { code?: string }).code === 'ENOENT');
}
