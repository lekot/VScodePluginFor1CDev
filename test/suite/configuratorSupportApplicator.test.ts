import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { InfobaseCanonicalIdentity } from '../../src/infobases/infobaseCanonicalIdentity';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import type { ConfigurationId } from '../../src/services/configurationSession/types';
import type {
  ConfiguratorProcessOutcome,
  ConfiguratorProcessRunnerOptions,
} from '../../src/services/configurator/configuratorProcessRunner';
import { ConfiguratorSupportApplicator } from '../../src/support/configuratorSupportApplicator';
import { ParentConfigurationsCodec } from '../../src/support/parentConfigurationsCodec';
import { SupportPayloadCache } from '../../src/support/supportPayloadCache';
import type {
  MasterSupportSnapshot,
  PreparedTargetSupportPayload,
  SupportCancellation,
} from '../../src/support/supportTypes';
import {
  buildParentConfigurations,
  syntheticSupplier,
  SUPPORT_UUIDS,
} from './supportTestFixtures';

const CONFIGURATION_ID = 'cfg-applicator' as ConfigurationId;
const NEVER_CANCELLED: SupportCancellation = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

suite('ConfiguratorSupportApplicator', () => {
  let root: string;

  setup(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'support-applicator-test-'));
  });

  teardown(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('probe fails closed outside the exact certified strategy and when stored credentials are unavailable', async () => {
    const fixture = await createFixture(root);
    const cache = new SupportPayloadCache(path.join(root, 'cache'));
    const noCredentialApplicator = new ConfiguratorSupportApplicator(cache, {
      resolveIdentity: async () => identity(fixture.databasePath),
      resolveExecutable: (_entry, requiredVersion) => ({
        status: 'resolved',
        path: path.join(root, '1cv8.exe'),
        version: requiredVersion,
        source: 'settings',
      }),
    });

    const unsupportedVersion = await noCredentialApplicator.probe(
      entry(fixture.databasePath, { platformVersion: '8.3.26.1' }),
      fixture.snapshot,
    );
    assert.strictEqual(unsupportedVersion.supported, false);
    if (!unsupportedVersion.supported) {
      assert.strictEqual(unsupportedVersion.errorCode, 'SUPPORT_TARGET_UNSUPPORTED');
    }

    const storedCredential = await noCredentialApplicator.probe(
      entry(fixture.databasePath, { hasStoredPassword: true }),
      fixture.snapshot,
    );
    assert.strictEqual(storedCredential.supported, false);
    if (!storedCredential.supported) {
      assert.match(storedCredential.diagnostics?.join(' ') ?? '', /credentials are unavailable/i);
    }

    const supportedApplicator = new ConfiguratorSupportApplicator(cache, {
      resolveIdentity: async () => identity(fixture.databasePath),
      resolveExecutable: () => ({
        status: 'resolved',
        path: path.join(root, '1cv8.exe'),
        version: '8.3.27.1859',
        source: 'settings',
      }),
      getCredentials: async () => ({ user: 'operator', password: 'secret' }),
    });
    const supported = await supportedApplicator.probe(
      entry(fixture.databasePath, { hasStoredPassword: true }),
      fixture.snapshot,
    );
    assert.deepStrictEqual(supported, {
      supported: true,
      canonicalTargetId: 'file:applicator-test',
      platformVersion: '8.3.27.1859',
      strategyId: 'file-main-8.3.27.1859-revision6',
    });
  });

  test('cold prepare dumps once, warm prepare reuses payload, apply stages exact bytes and publishes acknowledgement', async () => {
    const fixture = await createFixture(root);
    const cache = new SupportPayloadCache(path.join(root, 'cache'));
    const operations: string[] = [];
    const applyTrace: string[] = [];
    let admissionCalls = 0;
    let stagedMaster: Buffer | undefined;
    let stagedSupplier: Buffer | undefined;
    const applicator = new ConfiguratorSupportApplicator(cache, {
      resolveIdentity: async () => identity(fixture.databasePath),
      resolveExecutable: () => ({
        status: 'resolved',
        path: path.join(root, '1cv8.exe'),
        version: '8.3.27.1859',
        source: 'settings',
      }),
      getCredentials: async () => ({ user: 'operator', password: 'secret-password' }),
      temporaryRoot: root,
      runProcess: async (options) => {
        operations.push(options.batchArguments.operation);
        assert.strictEqual(options.batchArguments.executionArgs.includes('-NoCheck'), false);
        assert.strictEqual(options.batchArguments.diagnosticArgs.includes('secret-password'), false);
        if (options.batchArguments.operation === 'minimalDump') {
          await writeDump(options, fixture.dumpBytes, fixture.supplierBytes);
        } else {
          applyTrace.push('runProcess');
          const staging = argumentAfter(options, '/LoadConfigFromFiles');
          stagedMaster = await fs.readFile(path.join(staging, 'Ext', 'ParentConfigurations.bin'));
          stagedSupplier = await fs.readFile(
            path.join(staging, 'Ext', 'ParentConfigurations', 'Supplier.cf'),
          );
        }
        return acknowledged(options);
      },
    });
    const target = entry(fixture.databasePath, { hasStoredPassword: true });

    const cold = await applicator.prepare(target, fixture.snapshot, NEVER_CANCELLED);
    assert.strictEqual(cold.status, 'prepared');
    if (cold.status !== 'prepared') {
      throw new Error('Expected cold payload.');
    }
    assert.strictEqual(cold.payload.observedSemanticDigest, fixture.dumpSemanticDigest);
    assert.deepStrictEqual(Buffer.from(cold.payload.desiredMasterBytes), fixture.desiredBytes);
    assert.deepStrictEqual(Buffer.from(cold.payload.supplierFiles[0]!.content), fixture.supplierBytes);

    const warm = await applicator.prepare(target, fixture.snapshot, NEVER_CANCELLED);
    assert.strictEqual(warm.status, 'prepared');
    assert.deepStrictEqual(operations, ['minimalDump']);

    const applied = await applicator.apply(
      target,
      fixture.snapshot,
      cold.payload,
      NEVER_CANCELLED,
      async () => {
        admissionCalls += 1;
        const applyRoot = await findApplyRoot(root);
        assert.ok(applyRoot, 'Apply staging must exist before admission.');
        assert.deepStrictEqual(
          await fs.readFile(path.join(applyRoot, 'staging', 'Ext', 'ParentConfigurations.bin')),
          fixture.desiredBytes,
        );
        assert.match(await fs.readFile(path.join(applyRoot, 'apply-list.txt'), 'utf8'), /ParentConfigurations\.bin/);
        applyTrace.push('beforeEffect');
        return true;
      },
    );
    assert.deepStrictEqual(applied, {
      status: 'acknowledged',
      acknowledgedGenerationId: fixture.snapshot.generationId,
    });
    assert.deepStrictEqual(stagedMaster, fixture.desiredBytes);
    assert.deepStrictEqual(stagedSupplier, fixture.supplierBytes);
    assert.deepStrictEqual(operations, ['minimalDump', 'partialApply']);
    assert.strictEqual(admissionCalls, 1);
    assert.deepStrictEqual(applyTrace, ['beforeEffect', 'runProcess']);

    let warmReadFileCalls = 0;
    let warmProcessCalls = 0;
    const warmApplicator = new ConfiguratorSupportApplicator(cache, {
      resolveIdentity: async () => identity(fixture.databasePath),
      resolveExecutable: () => ({
        status: 'resolved',
        path: path.join(root, '1cv8.exe'),
        version: '8.3.27.1859',
        source: 'settings',
      }),
      readFile: (async () => {
        warmReadFileCalls += 1;
        throw new Error('Warm acknowledged path must not read the desired master.');
      }) as typeof fs.readFile,
      runProcess: async () => {
        warmProcessCalls += 1;
        throw new Error('Warm acknowledged path must not invoke Configurator.');
      },
    });
    const acknowledgedWarm = await warmApplicator.prepare(target, fixture.snapshot, NEVER_CANCELLED);
    assert.deepStrictEqual(acknowledgedWarm, {
      status: 'alreadyAcknowledged',
      acknowledgedGenerationId: fixture.snapshot.generationId,
      evidence: 'cachedConfiguratorAck',
    });
    assert.deepStrictEqual(operations, ['minimalDump', 'partialApply']);
    assert.strictEqual(warmReadFileCalls, 0);
    assert.strictEqual(warmProcessCalls, 0);
  });

  test('immutable payload drift blocks spawn and ambiguous process outcomes redact password diagnostics', async () => {
    const fixture = await createFixture(root);
    const cache = new SupportPayloadCache(path.join(root, 'cache'));
    const operations: string[] = [];
    const applicator = new ConfiguratorSupportApplicator(cache, {
      resolveIdentity: async () => identity(fixture.databasePath),
      resolveExecutable: () => ({
        status: 'resolved',
        path: path.join(root, '1cv8.exe'),
        version: '8.3.27.1859',
        source: 'settings',
      }),
      getCredentials: async () => ({ user: 'operator', password: 'hunter2' }),
      temporaryRoot: root,
      runProcess: async (options) => {
        operations.push(options.batchArguments.operation);
        if (options.batchArguments.operation === 'minimalDump') {
          await writeDump(options, fixture.dumpBytes, fixture.supplierBytes);
          return acknowledged(options);
        }
        return {
          status: 'inDoubt',
          errorCode: 'CONFIGURATOR_ACKNOWLEDGEMENT_LOST',
          started: true,
          effectPossible: true,
          exitCode: null,
          signal: null,
          combinedLog: 'Error /P hunter2',
          logTruncated: false,
          diagnostic: {
            executablePath: options.executablePath,
            args: options.batchArguments.diagnosticArgs,
          },
          errorMessage: 'failed with /P=hunter2',
        };
      },
    });
    const target = entry(fixture.databasePath, { hasStoredPassword: true });
    let admissionCalls = 0;
    const prepared = await applicator.prepare(target, fixture.snapshot, NEVER_CANCELLED);
    assert.strictEqual(prepared.status, 'prepared');
    if (prepared.status !== 'prepared') {
      throw new Error('Expected prepared payload.');
    }

    const tampered: PreparedTargetSupportPayload = {
      ...prepared.payload,
      desiredMasterBytes: Buffer.from('tampered'),
    };
    assert.deepStrictEqual(
      await applicator.apply(
        target,
        fixture.snapshot,
        tampered,
        NEVER_CANCELLED,
        async () => {
          admissionCalls += 1;
          return true;
        },
      ),
      { status: 'stale', reason: 'targetDrift' },
    );
    assert.strictEqual(admissionCalls, 0);
    assert.deepStrictEqual(operations, ['minimalDump']);

    assert.deepStrictEqual(
      await applicator.apply(
        target,
        fixture.snapshot,
        prepared.payload,
        NEVER_CANCELLED,
        async () => {
          admissionCalls += 1;
          return false;
        },
      ),
      { status: 'stale', reason: 'masterAdvanced' },
    );
    assert.strictEqual(admissionCalls, 1);
    assert.deepStrictEqual(operations, ['minimalDump']);

    const ambiguous = await applicator.apply(
      target,
      fixture.snapshot,
      prepared.payload,
      NEVER_CANCELLED,
      async () => {
        admissionCalls += 1;
        return true;
      },
    );
    assert.strictEqual(ambiguous.status, 'inDoubt');
    if (ambiguous.status === 'inDoubt') {
      const diagnostics = ambiguous.diagnostics?.join(' ') ?? '';
      assert.strictEqual(diagnostics.includes('hunter2'), false);
      assert.match(diagnostics, /<redacted>/);
      assert.strictEqual(ambiguous.errorCode, 'CONFIGURATOR_ACKNOWLEDGEMENT_LOST');
    }
    assert.strictEqual(admissionCalls, 2);
    assert.deepStrictEqual(operations, ['minimalDump', 'partialApply']);

    let driftProcessCalls = 0;
    const preSpawnDriftApplicator = new ConfiguratorSupportApplicator(cache, {
      resolveIdentity: async () => identity(fixture.databasePath),
      resolveExecutable: () => ({
        status: 'resolved',
        path: path.join(root, '1cv8.exe'),
        version: '8.3.27.1859',
        source: 'settings',
      }),
      getCredentials: async () => ({ user: 'operator', password: 'hunter2' }),
      temporaryRoot: root,
      mkdtemp: (async (prefix: string) => {
        const temporaryPath = await fs.mkdtemp(prefix);
        await fs.appendFile(fixture.databasePath, '-drift');
        return temporaryPath;
      }) as typeof fs.mkdtemp,
      runProcess: async () => {
        driftProcessCalls += 1;
        throw new Error('Pre-spawn drift must block Configurator.');
      },
    });
    assert.deepStrictEqual(
      await preSpawnDriftApplicator.apply(
        target,
        fixture.snapshot,
        prepared.payload,
        NEVER_CANCELLED,
        async () => {
          admissionCalls += 1;
          return true;
        },
      ),
      { status: 'stale', reason: 'targetDrift' },
    );
    assert.strictEqual(admissionCalls, 2);
    assert.strictEqual(driftProcessCalls, 0);
  });

  test('post-success stamp and cache acknowledgement failures remain in doubt', async () => {
    const fixture = await createFixture(root);
    const target = entry(fixture.databasePath);

    const stampCache = new SupportPayloadCache(path.join(root, 'stamp-cache'));
    let processAcknowledged = false;
    const faultingStat = ((...args: unknown[]) => {
      if (processAcknowledged) {
        return Promise.reject(new Error('post-success stat failed'));
      }
      return fs.stat(args[0] as string, { bigint: true });
    }) as typeof fs.stat;
    const stampApplicator = createOperationalApplicator(
      root,
      fixture,
      stampCache,
      async (options) => {
        if (options.batchArguments.operation === 'minimalDump') {
          await writeDump(options, fixture.dumpBytes, fixture.supplierBytes);
        } else {
          processAcknowledged = true;
        }
        return acknowledged(options);
      },
      { stat: faultingStat },
    );
    const stampPrepared = await stampApplicator.prepare(target, fixture.snapshot, NEVER_CANCELLED);
    if (stampPrepared.status !== 'prepared') {
      throw new Error(`Expected prepared payload for post-success stamp failure: ${JSON.stringify(stampPrepared)}`);
    }
    assert.deepStrictEqual(
      await stampApplicator.apply(
        target,
        fixture.snapshot,
        stampPrepared.payload,
        NEVER_CANCELLED,
        async () => true,
      ),
      {
        status: 'inDoubt',
        errorCode: 'SUPPORT_ACK_PERSIST_FAILED',
        diagnostics: ['post-success stat failed'],
      },
    );

    for (const cacheOutcome of ['throw', 'false'] as const) {
      const cache = new SupportPayloadCache(path.join(root, `ack-${cacheOutcome}-cache`));
      const applicator = createOperationalApplicator(root, fixture, cache, async (options) => {
        if (options.batchArguments.operation === 'minimalDump') {
          await writeDump(options, fixture.dumpBytes, fixture.supplierBytes);
        }
        return acknowledged(options);
      });
      const prepared = await applicator.prepare(target, fixture.snapshot, NEVER_CANCELLED);
      assert.strictEqual(prepared.status, 'prepared');
      if (prepared.status !== 'prepared') {
        throw new Error(`Expected prepared payload for cache ${cacheOutcome} failure.`);
      }
      cache.acknowledge = cacheOutcome === 'throw'
        ? async () => { throw new Error('ack write failed'); }
        : async () => undefined;

      const outcome = await applicator.apply(
        target,
        fixture.snapshot,
        prepared.payload,
        NEVER_CANCELLED,
        async () => true,
      );
      assert.strictEqual(outcome.status, 'inDoubt');
      if (outcome.status === 'inDoubt') {
        assert.strictEqual(outcome.errorCode, 'SUPPORT_ACK_PERSIST_FAILED');
        assert.match(outcome.diagnostics?.join(' ') ?? '', cacheOutcome === 'throw'
          ? /ack write failed/
          : /cache entry disappeared/);
      }
    }
  });
});

interface Fixture {
  readonly databasePath: string;
  readonly desiredBytes: Buffer;
  readonly dumpBytes: Buffer;
  readonly supplierBytes: Buffer;
  readonly dumpSemanticDigest: string;
  readonly snapshot: MasterSupportSnapshot;
}

async function createFixture(root: string): Promise<Fixture> {
  const databasePath = path.join(root, '1Cv8.1CD');
  await fs.writeFile(databasePath, 'database');
  const supplier = syntheticSupplier({
    supplierId: SUPPORT_UUIDS.supplierA,
    name: 'Supplier',
    objects: [{
      mode: '1',
      localUuid: SUPPORT_UUIDS.objectA,
      vendorUuid: SUPPORT_UUIDS.vendorA,
    }],
  });
  const desiredBytes = buildParentConfigurations({ suppliers: [supplier] });
  const dumpBytes = buildParentConfigurations({
    suppliers: [{
      ...supplier,
      objects: [{
        mode: '0',
        localUuid: SUPPORT_UUIDS.objectA,
        vendorUuid: SUPPORT_UUIDS.vendorA,
      }],
    }],
  });
  const masterPath = path.join(root, 'master', 'Ext', 'ParentConfigurations.bin');
  await fs.mkdir(path.dirname(masterPath), { recursive: true });
  await fs.writeFile(masterPath, desiredBytes);
  const parsed = ParentConfigurationsCodec.parse(desiredBytes, {
    configurationId: CONFIGURATION_ID,
    filePath: masterPath,
    configRoot: path.dirname(path.dirname(masterPath)),
  });
  const dump = ParentConfigurationsCodec.parse(dumpBytes, {
    configurationId: CONFIGURATION_ID,
    filePath: path.join(root, 'dump', 'Ext', 'ParentConfigurations.bin'),
  });
  if (parsed.state.kind !== 'ready' || dump.state.kind !== 'ready') {
    throw new Error('Synthetic applicator fixture must parse as managed support.');
  }
  return {
    databasePath,
    desiredBytes,
    dumpBytes,
    supplierBytes: Buffer.from('supplier-cf'),
    dumpSemanticDigest: dump.state.snapshot.semanticDigest,
    snapshot: parsed.state.snapshot,
  };
}

function entry(
  databasePath: string,
  overrides: {
    readonly platformVersion?: string;
    readonly hasStoredPassword?: boolean;
  } = {},
): InfobaseEntry {
  return {
    id: 'ib-applicator',
    name: 'Applicator test',
    type: 'file',
    filePath: databasePath,
    user: 'operator',
    hasStoredPassword: overrides.hasStoredPassword ?? false,
    launchSettings: {
      platformVersion: overrides.platformVersion ?? '8.3.27.1859',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function identity(databasePath: string): InfobaseCanonicalIdentity {
  return {
    kind: 'file',
    connectionKind: 'databasePath',
    canonicalTargetId: 'file:applicator-test',
    key: 'file:applicator-test',
    resolvedPath: path.dirname(databasePath),
    databaseFilePath: databasePath,
    exists: true,
  };
}

async function writeDump(
  options: ConfiguratorProcessRunnerOptions,
  masterBytes: Buffer,
  supplierBytes: Buffer,
): Promise<void> {
  const dumpRoot = argumentAfter(options, '/DumpConfigToFiles');
  const supplierRoot = path.join(dumpRoot, 'Ext', 'ParentConfigurations');
  await fs.mkdir(supplierRoot, { recursive: true });
  await fs.writeFile(path.join(dumpRoot, 'Ext', 'ParentConfigurations.bin'), masterBytes);
  await fs.writeFile(path.join(supplierRoot, 'Supplier.cf'), supplierBytes);
}

function argumentAfter(options: ConfiguratorProcessRunnerOptions, marker: string): string {
  const index = options.batchArguments.executionArgs.indexOf(marker);
  assert.ok(index >= 0, `Missing Configurator argument ${marker}.`);
  const value = options.batchArguments.executionArgs[index + 1];
  assert.ok(value);
  return value;
}

function acknowledged(options: ConfiguratorProcessRunnerOptions): ConfiguratorProcessOutcome {
  return {
    status: 'acknowledged',
    started: true,
    effectPossible: true,
    exitCode: 0,
    signal: null,
    combinedLog: '',
    logTruncated: false,
    diagnostic: {
      executablePath: options.executablePath,
      args: options.batchArguments.diagnosticArgs,
    },
  };
}

function createOperationalApplicator(
  root: string,
  fixture: Fixture,
  cache: SupportPayloadCache,
  runProcess: (options: ConfiguratorProcessRunnerOptions) => Promise<ConfiguratorProcessOutcome>,
  overrides: Partial<ConstructorParameters<typeof ConfiguratorSupportApplicator>[1]> = {},
): ConfiguratorSupportApplicator {
  return new ConfiguratorSupportApplicator(cache, {
    resolveIdentity: async () => identity(fixture.databasePath),
    resolveExecutable: () => ({
      status: 'resolved',
      path: path.join(root, '1cv8.exe'),
      version: '8.3.27.1859',
      source: 'settings',
    }),
    temporaryRoot: root,
    runProcess,
    ...overrides,
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findApplyRoot(root: string): Promise<string | undefined> {
  const temporaryEntries = await fs.readdir(root, { withFileTypes: true });
  for (const candidate of temporaryEntries) {
    if (!candidate.isDirectory() || !candidate.name.startsWith('cdt-support-')) {
      continue;
    }
    const candidatePath = path.join(root, candidate.name);
    if (await pathExists(path.join(candidatePath, 'apply-list.txt'))) {
      return candidatePath;
    }
  }
  return undefined;
}
