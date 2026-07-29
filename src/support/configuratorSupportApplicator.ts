import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';
import {
  resolveInfobaseCanonicalIdentity,
  type FileInfobaseCanonicalIdentity,
} from '../infobases/infobaseCanonicalIdentity';
import {
  buildConfiguratorMinimalDumpArgs,
  buildConfiguratorPartialApplyArgs,
  type ConfiguratorCredentials,
} from '../services/configurator/configuratorBatchArgs';
import {
  resolveConfiguratorExecutable,
  type ConfiguratorExecutableResolution,
} from '../services/configurator/configuratorExecutableResolver';
import {
  runConfiguratorProcess,
  type ConfiguratorProcessOutcome,
  type ConfiguratorProcessRunnerOptions,
} from '../services/configurator/configuratorProcessRunner';
import { ParentConfigurationsCodec } from './parentConfigurationsCodec';
import {
  SUPPORT_OPERATIONAL_ERROR_CODES,
  type FileDatabaseStamp,
  type MasterSupportSnapshot,
  type PreparedTargetSupportPayload,
  type SupportApplicator,
  type SupportApplyOutcome,
  type SupportCancellation,
  type SupportOperationalErrorCode,
  type SupportPayloadCacheKey,
  type SupportPrepareOutcome,
  type SupportTargetCapability,
  type SupportVerifyOutcome,
} from './supportTypes';
import {
  SupportPayloadCache,
  readFileDatabaseStamp,
  sameFileDatabaseStamp,
  type SupportPayloadCacheRecord,
} from './supportPayloadCache';
import {
  SupportCapabilityRegistry,
  type CertifiedSupportStrategy,
  type SupportConfigurationStrategy,
} from './supportCapabilityRegistry';

const MINIMAL_DUMP_LIST_ITEM = 'Configuration.ParentConfigurations';
const PARTIAL_APPLY_LIST_ITEM = 'Ext/ParentConfigurations.bin';
const SUPPLIER_DIRECTORY_RELATIVE_PATH = 'Ext/ParentConfigurations';
const DEFAULT_TIMEOUT_MS = 120_000;
const SHA256 = /^[0-9a-f]{64}$/;
const OPERATIONAL_ERROR_CODE_SET: ReadonlySet<string> = new Set(SUPPORT_OPERATIONAL_ERROR_CODES);

export interface ConfiguratorSupportApplicatorDeps {
  readonly capabilityRegistry?: SupportCapabilityRegistry;
  readonly resolveIdentity?: typeof resolveInfobaseCanonicalIdentity;
  readonly resolveExecutable?: (
    entry: InfobaseEntry,
    requiredVersion: string,
  ) => ConfiguratorExecutableResolution;
  readonly getCredentials?: (entry: InfobaseEntry) => Promise<ConfiguratorCredentials | undefined>;
  readonly runProcess?: (options: ConfiguratorProcessRunnerOptions) => Promise<ConfiguratorProcessOutcome>;
  readonly readFile?: typeof fs.readFile;
  readonly writeFile?: typeof fs.writeFile;
  readonly mkdir?: typeof fs.mkdir;
  readonly mkdtemp?: typeof fs.mkdtemp;
  readonly rm?: typeof fs.rm;
  readonly readdir?: typeof fs.readdir;
  readonly realpath?: typeof fs.realpath;
  readonly stat?: typeof fs.stat;
  readonly temporaryRoot?: string;
  readonly timeoutMs?: number;
  readonly configurationStrategy?: SupportConfigurationStrategy;
}

interface ResolvedTarget {
  readonly identity: FileInfobaseCanonicalIdentity & {
    readonly connectionKind: 'databasePath';
    readonly databaseFilePath: string;
  };
  readonly executablePath: string;
  readonly platformVersion: string;
  readonly strategy: CertifiedSupportStrategy;
  readonly stamp: FileDatabaseStamp;
  readonly key: SupportPayloadCacheKey;
}

type TargetResolution =
  | { readonly status: 'resolved'; readonly target: ResolvedTarget }
  | {
      readonly status: 'failed';
      readonly errorCode: SupportOperationalErrorCode;
      readonly diagnostics: readonly string[];
    };

/** Certified partial-load adapter for support external-property replication. */
export class ConfiguratorSupportApplicator implements SupportApplicator {
  private readonly capabilityRegistry: SupportCapabilityRegistry;

  constructor(
    private readonly cache: SupportPayloadCache,
    private readonly deps: ConfiguratorSupportApplicatorDeps = {},
  ) {
    this.capabilityRegistry = deps.capabilityRegistry ?? new SupportCapabilityRegistry();
  }

  async probe(target: InfobaseEntry, snapshot: MasterSupportSnapshot): Promise<SupportTargetCapability> {
    const resolution = await this.resolveTarget(target, snapshot);
    if (resolution.status === 'failed') {
      return {
        supported: false,
        errorCode: resolution.errorCode,
        diagnostics: resolution.diagnostics,
      };
    }
    const credentialFailure = await this.credentialPreflight(target);
    if (credentialFailure) {
      return credentialFailure;
    }
    return {
      supported: true,
      canonicalTargetId: resolution.target.identity.canonicalTargetId,
      platformVersion: resolution.target.platformVersion,
      strategyId: resolution.target.strategy.id,
    };
  }

  async prepare(
    target: InfobaseEntry,
    snapshot: MasterSupportSnapshot,
    cancellation: SupportCancellation,
  ): Promise<SupportPrepareOutcome> {
    try {
      const resolution = await this.resolveTarget(target, snapshot);
      if (resolution.status === 'failed') {
        return failedPrepare(resolution.errorCode, false, resolution.diagnostics);
      }
      const cached = await this.cache.load(resolution.target.key, resolution.target.stamp);
      if (cached) {
        if (cached.acknowledgedGenerationId === snapshot.generationId) {
          return {
            status: 'alreadyAcknowledged',
            acknowledgedGenerationId: snapshot.generationId,
            evidence: 'cachedConfiguratorAck',
          };
        }
        const desiredMasterBytes = await this.readDesiredMaster(snapshot);
        return {
          status: 'prepared',
          payload: attachDesiredSnapshot(cached, snapshot.generationId, desiredMasterBytes),
        };
      }
      const desiredMasterBytes = await this.readDesiredMaster(snapshot);
      return await this.prepareCold(target, snapshot, resolution.target, desiredMasterBytes, cancellation);
    } catch (error) {
      return failedPrepare('SUPPORT_PREPARE_FAILED', true, [safeErrorMessage(error)]);
    }
  }

  async apply(
    target: InfobaseEntry,
    snapshot: MasterSupportSnapshot,
    payload: PreparedTargetSupportPayload,
    cancellation: SupportCancellation,
    beforeEffect: () => Promise<boolean>,
  ): Promise<SupportApplyOutcome> {
    let temporaryPath: string | undefined;
    try {
      const resolution = await this.resolveTarget(target, snapshot);
      if (resolution.status === 'failed') {
        return failedApply(resolution.errorCode, false, resolution.diagnostics);
      }
      const credentials = await this.credentials(target);
      if (target.hasStoredPassword && !credentials?.password?.length) {
        return failedApply(
          'SUPPORT_TARGET_UNSUPPORTED',
          false,
          ['Stored target credentials could not be resolved.'],
        );
      }
      if (!payloadMatchesTarget(payload, resolution.target, snapshot)) {
        return { status: 'stale', reason: 'targetDrift' };
      }
      if (
        !sameFileDatabaseStamp(payload.databaseStamp, resolution.target.stamp)
        || !validateImmutablePayload(payload, resolution.target, snapshot)
      ) {
        return { status: 'stale', reason: 'targetDrift' };
      }

      temporaryPath = await this.createTemporaryDirectory();
      const stagingPath = path.join(temporaryPath, 'staging');
      await (this.deps.mkdir ?? fs.mkdir)(path.join(stagingPath, 'Ext', 'ParentConfigurations'), {
        recursive: true,
      });
      await this.writeExactFile(
        path.join(stagingPath, 'Ext', 'ParentConfigurations.bin'),
        payload.desiredMasterBytes,
      );
      for (const supplier of payload.supplierFiles) {
        const targetPath = safeJoin(stagingPath, supplier.relativePath);
        await (this.deps.mkdir ?? fs.mkdir)(path.dirname(targetPath), { recursive: true });
        await this.writeExactFile(targetPath, supplier.content);
      }
      const listFilePath = path.join(temporaryPath, 'apply-list.txt');
      const outputFilePath = path.join(temporaryPath, 'apply.log');
      await this.writeExactFile(listFilePath, Buffer.from(`${PARTIAL_APPLY_LIST_ITEM}\r\n`, 'utf8'));

      const preSpawnStamp = await this.databaseStamp(resolution.target.identity.databaseFilePath);
      if (
        !sameFileDatabaseStamp(payload.databaseStamp, preSpawnStamp)
        || !payloadMatchesTarget(payload, resolution.target, snapshot)
        || !validateImmutablePayload(payload, resolution.target, snapshot)
      ) {
        return { status: 'stale', reason: 'targetDrift' };
      }
      const batchArguments = buildConfiguratorPartialApplyArgs({
        target: { type: 'file', filePath: resolution.target.identity.resolvedPath },
        stagingDirectory: stagingPath,
        listFilePath,
        outputFilePath,
        ...(credentials ? { credentials } : {}),
      });
      if (!await beforeEffect()) {
        return { status: 'stale', reason: 'masterAdvanced' };
      }
      const processOutcome = await this.runProcess({
        executablePath: resolution.target.executablePath,
        batchArguments,
      }, cancellation);
      if (processOutcome.status === 'inDoubt') {
        return {
          status: 'inDoubt',
          errorCode: sanitizeOperationalCode(processOutcome.errorCode, 'SUPPORT_APPLY_FAILED'),
          diagnostics: processDiagnostics(processOutcome),
        };
      }
      if (processOutcome.status === 'failed') {
        return failedApply(
          processOutcome.errorCode,
          processOutcome.retryable,
          processDiagnostics(processOutcome),
        );
      }

      try {
        const actualStamp = await this.databaseStamp(resolution.target.identity.databaseFilePath);
        const acknowledged = await this.cache.acknowledge(
          resolution.target.key,
          payload.databaseStamp,
          actualStamp,
          snapshot.generationId,
        );
        if (!acknowledged) {
          throw new Error('Prepared support payload cache entry disappeared after apply.');
        }
      } catch (error) {
        return {
          status: 'inDoubt',
          errorCode: 'SUPPORT_ACK_PERSIST_FAILED',
          diagnostics: [safeErrorMessage(error)],
        };
      }
      return {
        status: 'acknowledged',
        acknowledgedGenerationId: snapshot.generationId,
      };
    } catch (error) {
      return failedApply('SUPPORT_APPLY_FAILED', true, [safeErrorMessage(error)]);
    } finally {
      if (temporaryPath) {
        await (this.deps.rm ?? fs.rm)(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async verify(
    target: InfobaseEntry,
    snapshot: MasterSupportSnapshot,
    cancellation: SupportCancellation,
  ): Promise<SupportVerifyOutcome> {
    try {
      const resolution = await this.resolveTarget(target, snapshot);
      if (resolution.status === 'failed') {
        return failedVerify(resolution.errorCode, resolution.diagnostics);
      }
      const desiredMasterBytes = await this.readDesiredMaster(snapshot);
      const dump = await this.dumpPayload(target, snapshot, resolution.target, cancellation);
      if (dump.status === 'failed') {
        return failedVerify(dump.errorCode, dump.diagnostics);
      }
      const payload = attachDesiredSnapshot(
        dump.payload,
        snapshot.generationId,
        desiredMasterBytes,
      );
      if (payload.observedSemanticDigest === snapshot.semanticDigest) {
        await this.cache.acknowledge(
          resolution.target.key,
          resolution.target.stamp,
          resolution.target.stamp,
          snapshot.generationId,
        );
        return {
          status: 'matched',
          verifiedGenerationId: snapshot.generationId,
        };
      }
      return { status: 'mismatch', payload };
    } catch (error) {
      return failedVerify('SUPPORT_VERIFY_FAILED', [safeErrorMessage(error)]);
    }
  }

  private async prepareCold(
    target: InfobaseEntry,
    snapshot: MasterSupportSnapshot,
    resolved: ResolvedTarget,
    desiredMasterBytes: Buffer,
    cancellation: SupportCancellation,
  ): Promise<SupportPrepareOutcome> {
    const dump = await this.dumpPayload(target, snapshot, resolved, cancellation);
    if (dump.status === 'failed') {
      return failedPrepare(dump.errorCode, dump.retryable, dump.diagnostics);
    }
    const payload = attachDesiredSnapshot(dump.payload, snapshot.generationId, desiredMasterBytes);
    if (payload.observedSemanticDigest === snapshot.semanticDigest) {
      await this.cache.acknowledge(
        resolved.key,
        resolved.stamp,
        resolved.stamp,
        snapshot.generationId,
      );
      return {
        status: 'matched',
        verifiedGenerationId: snapshot.generationId,
        evidence: 'semanticDump',
      };
    }
    return { status: 'prepared', payload };
  }

  private async dumpPayload(
    target: InfobaseEntry,
    snapshot: MasterSupportSnapshot,
    resolved: ResolvedTarget,
    cancellation: SupportCancellation,
  ): Promise<
    | { readonly status: 'dumped'; readonly payload: SupportPayloadCacheRecord }
    | {
        readonly status: 'failed';
        readonly errorCode: SupportOperationalErrorCode;
        readonly retryable: boolean;
        readonly diagnostics: readonly string[];
      }
  > {
    const temporaryPath = await this.createTemporaryDirectory();
    try {
      const dumpPath = path.join(temporaryPath, 'dump');
      await (this.deps.mkdir ?? fs.mkdir)(dumpPath, { recursive: true });
      const listFilePath = path.join(temporaryPath, 'dump-list.txt');
      const outputFilePath = path.join(temporaryPath, 'dump.log');
      await this.writeExactFile(listFilePath, Buffer.from(`${MINIMAL_DUMP_LIST_ITEM}\r\n`, 'utf8'));
      const credentials = await this.credentials(target);
      const batchArguments = buildConfiguratorMinimalDumpArgs({
        target: { type: 'file', filePath: resolved.identity.resolvedPath },
        dumpDirectory: dumpPath,
        listFilePath,
        outputFilePath,
        ...(credentials ? { credentials } : {}),
      });
      const processOutcome = await this.runProcess({
        executablePath: resolved.executablePath,
        batchArguments,
      }, cancellation);
      if (processOutcome.status !== 'acknowledged') {
        return {
          status: 'failed',
          errorCode: sanitizeOperationalCode(processOutcome.errorCode, 'SUPPORT_DUMP_FAILED'),
          retryable: processOutcome.status === 'failed' ? processOutcome.retryable : true,
          diagnostics: processDiagnostics(processOutcome),
        };
      }

      const afterDumpStamp = await this.databaseStamp(resolved.identity.databaseFilePath);
      if (!sameFileDatabaseStamp(resolved.stamp, afterDumpStamp)) {
        return {
          status: 'failed',
          errorCode: 'SUPPORT_TARGET_DRIFT',
          retryable: true,
          diagnostics: ['File database stamp changed during minimal dump.'],
        };
      }
      const binPath = path.join(dumpPath, 'Ext', 'ParentConfigurations.bin');
      const binBytes = Buffer.from(await (this.deps.readFile ?? fs.readFile)(binPath));
      const document = ParentConfigurationsCodec.parse(binBytes, {
        configurationId: snapshot.configurationId,
        filePath: binPath,
      });
      if (document.state.kind !== 'ready') {
        return {
          status: 'failed',
          errorCode: 'SUPPORT_DUMP_INVALID',
          retryable: false,
          diagnostics: document.state.kind === 'unknown'
            ? document.state.diagnostics
            : ['Minimal dump did not contain a managed support master.'],
        };
      }
      if (!sameSupplierIdentityMap(
        snapshot.supplierConfigurations,
        document.state.snapshot.supplierConfigurations,
      )) {
        return {
          status: 'failed',
          errorCode: 'SUPPORT_DUMP_SUPPLIER_MISMATCH',
          retryable: false,
          diagnostics: ['Minimal dump supplier identity/name mapping differs from the desired master.'],
        };
      }
      const supplierFiles = await this.readExactSupplierFiles(dumpPath, snapshot);
      const cached = await this.cache.store({
        key: resolved.key,
        databaseStamp: afterDumpStamp,
        observedSemanticDigest: document.state.snapshot.semanticDigest,
        supplierFiles,
      });
      return { status: 'dumped', payload: cached };
    } catch (error) {
      return {
        status: 'failed',
        errorCode: 'SUPPORT_DUMP_FAILED',
        retryable: true,
        diagnostics: [safeErrorMessage(error)],
      };
    } finally {
      await (this.deps.rm ?? fs.rm)(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async readExactSupplierFiles(
    dumpRoot: string,
    snapshot: MasterSupportSnapshot,
  ): Promise<readonly {
    supplierConfigurationId: string;
    relativePath: string;
    content: Uint8Array;
  }[]> {
    const supplierDirectory = path.join(dumpRoot, 'Ext', 'ParentConfigurations');
    const names = await (this.deps.readdir ?? fs.readdir)(supplierDirectory);
    const actualCfNames = names.filter((name) => name.toLocaleLowerCase().endsWith('.cf'));
    const expected = snapshot.supplierConfigurations.map((supplier) => {
      const fileName = safeSupplierFileName(supplier.name);
      return {
        supplierConfigurationId: supplier.supplierConfigurationId,
        relativePath: `${SUPPLIER_DIRECTORY_RELATIVE_PATH}/${fileName}`,
        fileName,
      };
    });
    const actualSet = [...actualCfNames].map((name) => name.toLocaleLowerCase()).sort();
    const expectedSet = expected.map((file) => file.fileName.toLocaleLowerCase()).sort();
    if (JSON.stringify(actualSet) !== JSON.stringify(expectedSet)) {
      throw new Error('Minimal dump supplier payload set is missing, duplicated, or unexpected.');
    }
    return Promise.all(expected.map(async (supplier) => ({
      supplierConfigurationId: supplier.supplierConfigurationId,
      relativePath: supplier.relativePath,
      content: Buffer.from(await (this.deps.readFile ?? fs.readFile)(
        path.join(supplierDirectory, supplier.fileName),
      )),
    })));
  }

  private async resolveTarget(
    entry: InfobaseEntry,
    snapshot: MasterSupportSnapshot,
  ): Promise<TargetResolution> {
    try {
      const identity = await (this.deps.resolveIdentity ?? resolveInfobaseCanonicalIdentity)(entry);
      if (
        identity.kind !== 'file'
        || identity.connectionKind !== 'databasePath'
        || !identity.exists
        || !identity.databaseFilePath
      ) {
        return {
          status: 'failed',
          errorCode: 'SUPPORT_TARGET_UNSUPPORTED',
          diagnostics: ['Only a resolved file infobase is certified for support mutation.'],
        };
      }
      const requiredVersion = entry.launchSettings?.platformVersion?.trim() ?? '';
      if (!requiredVersion) {
        return {
          status: 'failed',
          errorCode: 'CONFIGURATOR_PLATFORM_VERSION_UNKNOWN',
          diagnostics: ['An exact target platform version is required.'],
        };
      }
      const executable = (this.deps.resolveExecutable ?? defaultResolveExecutable)(entry, requiredVersion);
      if (executable.status === 'failed') {
        return {
          status: 'failed',
          errorCode: sanitizeOperationalCode(
            executable.errorCode,
            'CONFIGURATOR_EXECUTABLE_INVALID',
          ),
          diagnostics: [executable.message],
        };
      }
      const capability = this.capabilityRegistry.resolve({
        targetKind: entry.type,
        platformVersion: executable.version,
        formatRevision: snapshot.formatRevision,
        configurationStrategy: this.deps.configurationStrategy ?? 'main',
      });
      if (!capability.supported) {
        return {
          status: 'failed',
          errorCode: sanitizeOperationalCode(capability.errorCode, 'SUPPORT_TARGET_UNSUPPORTED'),
          diagnostics: [`Unsupported support strategy: ${capability.reason}.`],
        };
      }
      const stamp = await this.databaseStamp(identity.databaseFilePath);
      const key: SupportPayloadCacheKey = Object.freeze({
        canonicalTargetId: identity.canonicalTargetId,
        platformVersion: executable.version,
        configurationId: snapshot.configurationId,
        supplierConfigurationIds: Object.freeze(
          snapshot.supplierConfigurations
            .map((supplier) => supplier.supplierConfigurationId)
            .sort(),
        ),
        formatRevision: snapshot.formatRevision,
      });
      return {
        status: 'resolved',
        target: {
          identity: identity as ResolvedTarget['identity'],
          executablePath: executable.path,
          platformVersion: executable.version,
          strategy: capability.strategy,
          stamp,
          key,
        },
      };
    } catch (error) {
      return {
        status: 'failed',
        errorCode: 'SUPPORT_TARGET_UNSUPPORTED',
        diagnostics: [safeErrorMessage(error)],
      };
    }
  }

  private async readDesiredMaster(snapshot: MasterSupportSnapshot): Promise<Buffer> {
    const bytes = Buffer.from(await (this.deps.readFile ?? fs.readFile)(snapshot.filePath));
    if (sha256(bytes) !== snapshot.generationId) {
      throw new Error('Desired support master changed after the immutable snapshot was selected.');
    }
    const parsed = ParentConfigurationsCodec.parse(bytes, {
      configurationId: snapshot.configurationId,
      filePath: snapshot.filePath,
    });
    if (
      parsed.state.kind !== 'ready'
      || parsed.state.snapshot.semanticDigest !== snapshot.semanticDigest
    ) {
      throw new Error('Desired support master no longer matches the immutable semantic snapshot.');
    }
    return bytes;
  }

  private databaseStamp(databaseFilePath: string): Promise<FileDatabaseStamp> {
    return readFileDatabaseStamp(databaseFilePath, {
      ...(this.deps.realpath ? { realpath: this.deps.realpath } : {}),
      ...(this.deps.stat ? { stat: this.deps.stat } : {}),
    });
  }

  private async credentials(entry: InfobaseEntry): Promise<ConfiguratorCredentials | undefined> {
    if (this.deps.getCredentials) {
      return this.deps.getCredentials(entry);
    }
    return entry.user?.trim() ? { user: entry.user.trim() } : undefined;
  }

  private async credentialPreflight(entry: InfobaseEntry): Promise<
    Extract<SupportTargetCapability, { supported: false }> | undefined
  > {
    try {
      if (entry.hasStoredPassword && !this.deps.getCredentials) {
        return {
          supported: false,
          errorCode: 'SUPPORT_TARGET_UNSUPPORTED',
          diagnostics: ['Stored target credentials are unavailable to the support applicator.'],
        };
      }
      const credentials = await this.credentials(entry);
      if (entry.hasStoredPassword && !credentials?.password?.length) {
        return {
          supported: false,
          errorCode: 'SUPPORT_TARGET_UNSUPPORTED',
          diagnostics: ['Stored target credentials could not be resolved.'],
        };
      }
      return undefined;
    } catch {
      return {
        supported: false,
        errorCode: 'SUPPORT_TARGET_UNSUPPORTED',
        diagnostics: ['Target credentials could not be resolved.'],
      };
    }
  }

  private runProcess(
    options: Pick<ConfiguratorProcessRunnerOptions, 'executablePath' | 'batchArguments'>,
    cancellation: SupportCancellation,
  ): Promise<ConfiguratorProcessOutcome> {
    return (this.deps.runProcess ?? runConfiguratorProcess)({
      ...options,
      timeoutMs: this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      cancellation,
    });
  }

  private createTemporaryDirectory(): Promise<string> {
    const root = path.resolve(this.deps.temporaryRoot ?? os.tmpdir());
    return (this.deps.mkdtemp ?? fs.mkdtemp)(path.join(root, 'cdt-support-'));
  }

  private async writeExactFile(filePath: string, bytes: Uint8Array): Promise<void> {
    await (this.deps.writeFile ?? fs.writeFile)(filePath, Buffer.from(bytes), { flag: 'wx' });
  }
}

function defaultResolveExecutable(entry: InfobaseEntry, requiredVersion: string): ConfiguratorExecutableResolution {
  return resolveConfiguratorExecutable(entry, { requiredVersion });
}

function attachDesiredSnapshot(
  payload: SupportPayloadCacheRecord,
  desiredGenerationId: string,
  desiredMasterBytes: Uint8Array,
): PreparedTargetSupportPayload {
  return Object.freeze({
    canonicalTargetId: payload.key.canonicalTargetId,
    platformVersion: payload.key.platformVersion,
    cacheKey: Object.freeze({
      ...payload.key,
      supplierConfigurationIds: Object.freeze([...payload.key.supplierConfigurationIds]),
    }),
    databaseStamp: Object.freeze({ ...payload.databaseStamp }),
    observedSemanticDigest: payload.observedSemanticDigest,
    supplierFiles: Object.freeze(payload.supplierFiles.map((file) => Object.freeze({
      ...file,
      content: Buffer.from(file.content),
    }))),
    desiredGenerationId,
    desiredMasterBytes: Buffer.from(desiredMasterBytes),
    ...(payload.acknowledgedGenerationId
      ? { acknowledgedGenerationId: payload.acknowledgedGenerationId }
      : {}),
  });
}

function payloadMatchesTarget(
  payload: PreparedTargetSupportPayload,
  target: ResolvedTarget,
  snapshot: MasterSupportSnapshot,
): boolean {
  return payload.canonicalTargetId === target.identity.canonicalTargetId
    && payload.platformVersion === target.platformVersion
    && payload.desiredGenerationId === snapshot.generationId
    && sameCacheKey(payload.cacheKey, target.key)
    && sha256(payload.desiredMasterBytes) === snapshot.generationId;
}

function validateImmutablePayload(
  payload: PreparedTargetSupportPayload,
  target: ResolvedTarget,
  snapshot: MasterSupportSnapshot,
): boolean {
  if (
    payload.supplierFiles.length === 0
    || !payload.observedSemanticDigest
    || !SHA256.test(payload.desiredGenerationId)
    || sha256(payload.desiredMasterBytes) !== payload.desiredGenerationId
    || !payloadMatchesTarget(payload, target, snapshot)
  ) {
    return false;
  }
  let expectedById: ReadonlyMap<string, string>;
  try {
    expectedById = expectedSupplierPaths(snapshot);
  } catch {
    return false;
  }
  if (
    expectedById.size !== payload.cacheKey.supplierConfigurationIds.length
    || expectedById.size !== payload.supplierFiles.length
  ) {
    return false;
  }
  const paths = new Set<string>();
  const supplierIds = new Set<string>();
  let cacheEntryId: string | undefined;
  for (const supplier of payload.supplierFiles) {
    const expectedPath = expectedById.get(supplier.supplierConfigurationId);
    if (
      !expectedPath
      || supplier.relativePath !== expectedPath
      || supplierIds.has(supplier.supplierConfigurationId)
      || paths.has(supplier.relativePath)
      || !supplier.cacheEntryId
      || (cacheEntryId !== undefined && supplier.cacheEntryId !== cacheEntryId)
      || !SHA256.test(supplier.sha256)
      || sha256(supplier.content) !== supplier.sha256
      || !supplier.relativePath.startsWith(`${SUPPLIER_DIRECTORY_RELATIVE_PATH}/`)
    ) {
      return false;
    }
    cacheEntryId = supplier.cacheEntryId;
    supplierIds.add(supplier.supplierConfigurationId);
    paths.add(supplier.relativePath);
  }
  return sortedEqual([...supplierIds], payload.cacheKey.supplierConfigurationIds);
}

function safeJoin(root: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  if (
    path.posix.isAbsolute(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Unsafe staging relative path: ${relativePath}.`);
  }
  const result = path.resolve(root, ...normalized.split('/'));
  const relative = path.relative(path.resolve(root), result);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Staging payload escapes its root: ${relativePath}.`);
  }
  return result;
}

function safeSupplierFileName(supplierName: string): string {
  const name = `${supplierName}.cf`;
  if (
    !supplierName.trim()
    || name !== path.basename(name)
    || /[\\/:*?"<>|]/u.test(name)
    || [...name].some((character) => character.charCodeAt(0) < 0x20)
  ) {
    throw new Error(`Supplier name cannot be mapped to a safe payload file: ${supplierName}.`);
  }
  return name;
}

function expectedSupplierPaths(snapshot: MasterSupportSnapshot): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const normalizedPaths = new Set<string>();
  for (const supplier of snapshot.supplierConfigurations) {
    if (!supplier.supplierConfigurationId || result.has(supplier.supplierConfigurationId)) {
      throw new Error('Support supplier identities must be present and unique.');
    }
    const relativePath = `${SUPPLIER_DIRECTORY_RELATIVE_PATH}/${safeSupplierFileName(supplier.name)}`;
    const normalizedPath = relativePath.toLocaleLowerCase();
    if (normalizedPaths.has(normalizedPath)) {
      throw new Error('Support supplier names must map one-to-one to payload files.');
    }
    result.set(supplier.supplierConfigurationId, relativePath);
    normalizedPaths.add(normalizedPath);
  }
  return result;
}

function sameSupplierIdentityMap(
  expected: MasterSupportSnapshot['supplierConfigurations'],
  observed: MasterSupportSnapshot['supplierConfigurations'],
): boolean {
  try {
    const expectedNames = supplierNamesById(expected);
    const observedNames = supplierNamesById(observed);
    if (expectedNames.size !== observedNames.size) {
      return false;
    }
    for (const [supplierId, expectedName] of expectedNames) {
      if (observedNames.get(supplierId) !== expectedName) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function supplierNamesById(
  suppliers: MasterSupportSnapshot['supplierConfigurations'],
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const normalizedNames = new Set<string>();
  for (const supplier of suppliers) {
    if (
      !supplier.supplierConfigurationId
      || !supplier.name
      || result.has(supplier.supplierConfigurationId)
      || normalizedNames.has(supplier.name.toLocaleLowerCase())
    ) {
      throw new Error('Support supplier identity/name mapping is not one-to-one.');
    }
    result.set(supplier.supplierConfigurationId, supplier.name);
    normalizedNames.add(supplier.name.toLocaleLowerCase());
  }
  return result;
}

function sameCacheKey(left: SupportPayloadCacheKey, right: SupportPayloadCacheKey): boolean {
  return left.canonicalTargetId === right.canonicalTargetId
    && left.platformVersion === right.platformVersion
    && left.configurationId === right.configurationId
    && left.formatRevision === right.formatRevision
    && sortedEqual(left.supplierConfigurationIds, right.supplierConfigurationIds);
}

function sortedEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((value, index) => value === rightSorted[index]);
}

function failedPrepare(
  errorCode: unknown,
  retryable: boolean,
  diagnostics: readonly string[],
): Extract<SupportPrepareOutcome, { status: 'failed' }> {
  return {
    status: 'failed',
    errorCode: sanitizeOperationalCode(errorCode, 'SUPPORT_PREPARE_FAILED'),
    retryable,
    diagnostics: redactDiagnostics(diagnostics),
  };
}

function failedApply(
  errorCode: unknown,
  retryable: boolean,
  diagnostics: readonly string[],
): Extract<SupportApplyOutcome, { status: 'failed' }> {
  return {
    status: 'failed',
    errorCode: sanitizeOperationalCode(errorCode, 'SUPPORT_APPLY_FAILED'),
    retryable,
    diagnostics: redactDiagnostics(diagnostics),
  };
}

function failedVerify(
  errorCode: unknown,
  diagnostics: readonly string[],
): Extract<SupportVerifyOutcome, { status: 'failed' }> {
  return {
    status: 'failed',
    errorCode: sanitizeOperationalCode(errorCode, 'SUPPORT_VERIFY_FAILED'),
    diagnostics: redactDiagnostics(diagnostics),
  };
}

function sanitizeOperationalCode(
  errorCode: unknown,
  fallback: SupportOperationalErrorCode,
): SupportOperationalErrorCode {
  return typeof errorCode === 'string' && OPERATIONAL_ERROR_CODE_SET.has(errorCode)
    ? errorCode as SupportOperationalErrorCode
    : fallback;
}

function processDiagnostics(outcome: ConfiguratorProcessOutcome): readonly string[] {
  const values = [
    `status=${outcome.status}`,
    `exitCode=${outcome.exitCode ?? 'null'}`,
    `signal=${outcome.signal ?? 'null'}`,
    outcome.combinedLog,
    ...(outcome.status !== 'acknowledged' && outcome.errorMessage ? [outcome.errorMessage] : []),
  ];
  return redactDiagnostics(values);
}

function redactDiagnostics(diagnostics: readonly string[]): readonly string[] {
  return Object.freeze(diagnostics.map((diagnostic) =>
    diagnostic.replace(/(\/P(?:\s+|=))(?:"[^"]*"|\S+)/giu, '$1<redacted>')));
}

function safeErrorMessage(error: unknown): string {
  return redactDiagnostics([error instanceof Error ? error.message : String(error)])[0]!;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
