import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import type { ConfigurationId } from '../../src/services/configurationSession/types';
import { ParentConfigurationsCodec, ParsedParentConfigurations } from '../../src/support/parentConfigurationsCodec';
import { SupportApplicationService } from '../../src/support/supportApplicationService';
import {
  SupportApplicationServiceRegistry,
  type SupportApplicationFacade,
  type SupportConfigurationRegistration,
} from '../../src/support/supportApplicationServiceRegistry';
import { SupportModeService } from '../../src/support/supportModeService';
import { createSupportServiceComposition } from '../../src/support/supportServiceComposition';
import type {
  SupportApplicationServiceDeps,
} from '../../src/support/supportApplicationService';
import type {
  MasterSupportSnapshot,
  MasterSupportState,
  MetadataUniverseSnapshot,
  SupportModeMutationOutcome,
  SupportStatusOutcome,
} from '../../src/support/supportTypes';

suite('Support application/registry/composition lifecycle', () => {
  test('registry routes multiple roots lazily and replaces service on registration metadata change', async () => {
    const created: string[] = [];
    const registry = new SupportApplicationServiceRegistry((registration) => {
      created.push(`${registration.configurationId}:${registration.workspaceFolderName}`);
      return fakeApplicationService(registration.configurationId);
    });
    const a = registration('cfg-a', 'root-a');
    const b = registration('cfg-b', 'root-b');
    registry.registerConfiguration(a);
    registry.registerConfiguration(b);

    assert.strictEqual(created.length, 0);
    assert.strictEqual((await registry.facade.getStatus({ configurationId: a.configurationId })).status, 'available');
    assert.strictEqual((await registry.facade.getStatus({ configurationId: b.configurationId })).status, 'available');
    assert.deepStrictEqual(created, ['cfg-a:ws-cfg-a', 'cfg-b:ws-cfg-b']);
    assert.strictEqual(registry.getRegistrationByRoot(path.resolve('root-a'))?.configurationId, a.configurationId);

    registry.registerConfiguration({ ...a, workspaceFolderName: 'renamed' });
    await registry.facade.getStatus({ configurationId: a.configurationId });
    assert.deepStrictEqual(created, ['cfg-a:ws-cfg-a', 'cfg-b:ws-cfg-b', 'cfg-a:renamed']);
    registry.unregisterConfiguration(a.configurationId);
    assert.strictEqual(
      (await registry.facade.getStatus({ configurationId: a.configurationId })).status,
      'operationRejected',
    );
  });

  test('registry rejects root/identity aliasing and clear rejects every facade operation', async () => {
    const registry = new SupportApplicationServiceRegistry((value) =>
      fakeApplicationService(value.configurationId));
    registry.registerConfiguration(registration('cfg-a', 'root-a'));
    assert.throws(
      () => registry.registerConfiguration(registration('cfg-b', 'root-a')),
      /two identities/,
    );
    assert.throws(
      () => registry.registerConfiguration(registration('cfg-a', 'root-b')),
      /two roots/,
    );
    registry.clear();
    const rejected = await registry.facade.getLastRun({ configurationId: 'cfg-a' as ConfigurationId });
    assert.strictEqual(rejected.status, 'operationRejected');
  });

  test('application service filters object status and rejects wrong identity/journal failure', async () => {
    const configurationId = 'cfg-app' as ConfigurationId;
    const snapshot = master(configurationId, 'g1', ['one', 'two']);
    let journalFails = false;
    const service = new SupportApplicationService({
      configurationId,
      modeService: {
        getStatus: async () => ({
          status: 'available',
          master: { kind: 'ready', snapshot },
          metadataUniverse: universe(),
        }),
        setObjectMode: async () => rejectedMutation(),
        enableObjectRules: async () => rejectedMutation(),
      },
      coordinator: {
        sync: async () => { throw new Error('not used'); },
        verifyOnly: async () => { throw new Error('not used'); },
      },
      journal: {
        getLastRun: async () => {
          if (journalFails) {
            throw new Error('journal unavailable');
          }
          return undefined;
        },
      },
    });

    const available = await service.getStatus({
      configurationId,
      objectIds: ['TWO'],
    });
    assert.strictEqual(available.status, 'available');
    if (available.status === 'available' && available.master.kind === 'ready') {
      assert.deepStrictEqual([...available.master.snapshot.objectModes.keys()], ['two']);
    }
    assert.strictEqual(
      (await service.getStatus({ configurationId: 'other' as ConfigurationId })).status,
      'operationRejected',
    );
    journalFails = true;
    assert.strictEqual(
      (await service.getStatus({ configurationId })).status,
      'operationRejected',
    );
  });

  test('mode service distinguishes precommit rejection from postcommit replication failure', async () => {
    const configurationId = 'cfg-mode' as ConfigurationId;
    const before = master(configurationId, 'before', ['one']);
    const after = master(configurationId, 'after', ['one']);
    let current: MasterSupportState = { kind: 'ready', snapshot: before };
    let commit = false;
    const originalPlan = ParentConfigurationsCodec.planObjectMode;
    const afterDocument = new ParsedParentConfigurations(
      Buffer.from('1'),
      { configurationId, filePath: before.filePath, configRoot: path.resolve('mode-root') },
      { kind: 'ready', snapshot: after },
    );
    (ParentConfigurationsCodec as unknown as {
      planObjectMode: typeof ParentConfigurationsCodec.planObjectMode;
    }).planObjectMode = (() => ({
      kind: 'support.setObjectMode',
      configRoot: path.resolve('mode-root'),
      before,
      after,
      afterDocument,
      patches: [{ start: 0, end: 1, before: '0', after: '1', kind: 'objectMode', objectId: 'one' }],
      targetObjectId: 'one',
    })) as unknown as typeof ParentConfigurationsCodec.planObjectMode;
    try {
      const service = new SupportModeService({
        configurationId,
        configRoot: path.resolve('mode-root'),
        store: {
          read: async () => current,
          readParsedWithinExclusiveLease: async () =>
            new ParsedParentConfigurations(
              Buffer.from('0'),
              { configurationId, filePath: before.filePath, configRoot: path.resolve('mode-root') },
              current,
            ),
          commitWithinExclusiveLease: async () => {
            commit = true;
            current = { kind: 'ready', snapshot: after };
            throw new Error('persist acknowledgement lost');
          },
        },
        universeResolver: { resolve: async () => universe() },
        preflight: async () => ({
          accepted: true,
          scope: 'masterOnly',
          targets: [],
        }),
        coordinator: { sync: async () => { throw new Error('must not run'); } },
        runExclusiveConfigurationOperation: async (_resource, _kind, operation) => operation(),
      });
      const outcome = await service.setObjectMode({
        configurationId,
        objectId: 'one',
        targetMode: 'editableWithSupport',
        expectedGenerationId: before.generationId,
      });
      assert.strictEqual(commit, true);
      assert.strictEqual(outcome.status, 'committedWithReplicationIssue');
      if (outcome.status === 'committedWithReplicationIssue') {
        assert.strictEqual(outcome.mutation.after.generationId, 'after');
        assert.strictEqual(outcome.errorCode, 'SUPPORT_REPLICATION_FAILED');
      }

      let enteredLease = false;
      const preflightRejected = new SupportModeService({
        configurationId,
        configRoot: path.resolve('mode-root'),
        store: {
          read: async () => ({ kind: 'ready', snapshot: before }),
          readParsedWithinExclusiveLease: async () => { throw new Error('must not read'); },
          commitWithinExclusiveLease: async () => { throw new Error('must not commit'); },
        },
        universeResolver: { resolve: async () => universe() },
        preflight: async () => ({
          accepted: false,
          reason: 'bindingInvalid',
          errorCode: 'SUPPORT_BINDING_INVALID',
          diagnostics: ['bad binding'],
        }),
        coordinator: { sync: async () => { throw new Error('must not sync'); } },
        runExclusiveConfigurationOperation: async (_resource, _kind, operation) => {
          enteredLease = true;
          return operation();
        },
      });
      const rejected = await preflightRejected.setObjectMode({
        configurationId,
        objectId: 'one',
        targetMode: 'editableWithSupport',
        expectedGenerationId: before.generationId,
      });
      assert.strictEqual(rejected.status, 'preflightRejected');
      assert.strictEqual(enteredLease, false);
    } finally {
      (ParentConfigurationsCodec as unknown as {
        planObjectMode: typeof ParentConfigurationsCodec.planObjectMode;
      }).planObjectMode = originalPlan;
    }
  });

  test('composition dispose cancels admission, drains active operation, and is idempotent', async () => {
    const pending = deferred<SupportStatusOutcome>();
    const composition = createSupportServiceComposition({
      bindingManager: { getDiagnostic: async () => ({ kind: 'absent' }) },
      infobaseStorage: {
        load: async () => [],
        readPasswordSecret: async () => undefined,
      },
      globalStorageRoot: path.join(os.tmpdir(), `support-composition-${Date.now()}`),
      selector: () => ({
        workspaceFolderName: 'ws',
        configRelativePath: 'Configuration.xml',
      }),
      targetQueue: {
        runExclusive: async (_target, operation) => operation({
          canonicalTargetIds: [],
          owns: () => true,
          runExclusive: async (_identity, nested) => nested({
            canonicalTargetIds: [],
            owns: () => true,
            runExclusive: async () => { throw new Error('nested lease not expected'); },
          }),
        }),
      },
      runExclusiveConfigurationOperation: async (_resource, _kind, operation) => operation(),
    });
    const configurationId = 'cfg-composition' as ConfigurationId;
    const registryWithFactory = composition.registry as unknown as {
      createService: () => SupportApplicationService;
    };
    registryWithFactory.createService = () => ({
      getStatus: async () => pending.promise,
    } as unknown as SupportApplicationService);
    composition.registry.registerConfiguration(registration('cfg-composition', 'composition-root'));

    const active = composition.facade.getStatus({ configurationId });
    let disposed = false;
    const disposal = composition.dispose().then(() => { disposed = true; });
    await tick();
    assert.strictEqual(disposed, false);
    const afterDispose = await composition.facade.getStatus({ configurationId });
    assert.strictEqual(afterDispose.status, 'operationRejected');
    pending.resolve({
      status: 'available',
      master: { kind: 'ready', snapshot: master(configurationId, 'g', []) },
      metadataUniverse: universe(),
    });
    assert.strictEqual((await active).status, 'available');
    await disposal;
    assert.strictEqual(disposed, true);
    await composition.dispose();
  });
});

function registration(id: string, root: string): SupportConfigurationRegistration {
  return {
    configurationId: id as ConfigurationId,
    configRoot: path.resolve(root),
    workspaceFolderName: `ws-${id}`,
    configRelativePath: 'Configuration.xml',
  };
}

function fakeApplicationService(configurationId: ConfigurationId): SupportApplicationService {
  return {
    getStatus: async () => ({
      status: 'available',
      master: { kind: 'ready', snapshot: master(configurationId, 'generation', []) },
      metadataUniverse: universe(),
    }),
    getLastRun: async () => ({ status: 'available' }),
  } as unknown as SupportApplicationService;
}

function master(
  configurationId: ConfigurationId,
  generationId: string,
  objectIds: readonly string[],
): MasterSupportSnapshot {
  return {
    configurationId,
    generationId,
    semanticDigest: generationId.padEnd(64, '0').slice(0, 64),
    filePath: path.resolve('Ext', 'ParentConfigurations.bin'),
    formatRevision: '6',
    globalEditability: 'enabled',
    configurationMode: 'mixed',
    objectModes: new Map(objectIds.map((objectId) => [
      objectId,
      {
        objectId,
        locked: false,
        effectiveMode: 'editableWithSupport' as const,
        sources: [],
      },
    ])),
    supplierConfigurations: [],
  };
}

function universe(): MetadataUniverseSnapshot {
  return {
    configRoot: path.resolve('root'),
    metadataUniverseGenerationId: 'universe',
    entries: [],
  };
}

function rejectedMutation(): SupportModeMutationOutcome {
  return {
    status: 'operationRejected',
    errorCode: 'SUPPORT_OPERATION_FAILED',
    retryable: true,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
