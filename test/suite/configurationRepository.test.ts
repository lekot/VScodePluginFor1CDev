import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  buildConfigurationRepositoryBatchArgs,
} from '../../src/services/configurator/configuratorBatchArgs';
import { publishConfigurationTree } from '../../src/infobases/infobaseConfigCommands';
import {
  ConfigurationRepositoryTransport,
} from '../../src/services/configurationRepository/configurationRepositoryTransport';
import { ConfigurationRepositoryService } from '../../src/services/configurationRepository/configurationRepositoryService';
import { InfobaseConfigurationOperationQueue } from '../../src/infobases/infobaseConfigurationOperationQueue';
import { resolveInfobaseCanonicalIdentity } from '../../src/infobases/infobaseCanonicalIdentity';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import {
  resolveRepositoryObject,
  resolveRepositoryTarget,
} from '../../src/services/configurationRepository/repositoryObjectResolver';
import {
  writeRepositoryObjectsFile,
} from '../../src/services/configurationRepository/repositoryObjectsFileWriter';
import {
  RepositoryStateProjection,
  resolveRepositoryTreeDecoration,
} from '../../src/services/configurationRepository/repositoryTreeDecorations';
import {
  RepositoryBindingStore,
  RepositoryStateStore,
  repositoryTargetKey,
} from '../../src/services/configurationRepository/repositoryStores';

suite('Configuration Repository phase 1', () => {
  test('Configurator batch builder keeps repository and infobase passwords separate and redacted', () => {
    const args = buildConfigurationRepositoryBatchArgs({
      operation: 'repositoryCommit',
      target: { type: 'file', filePath: 'C:\\Bases\\Demo' },
      outputFilePath: 'C:\\Temp\\designer.log',
      repositoryPath: 'C:\\Repository',
      repositoryCredentials: { user: 'repo-user', password: 'repo-secret' },
      credentials: { user: 'ib-user', password: 'ib-secret' },
      objectListPath: 'C:\\Temp\\objects.xml',
      comment: 'commit comment',
      platform: 'win32',
    });
    assert.ok(args.executionArgs.includes('repo-secret'));
    assert.ok(args.executionArgs.includes('ib-secret'));
    assert.ok(args.diagnosticArgs.includes('<redacted>'));
    assert.strictEqual(args.diagnosticArgs.includes('repo-secret'), false);
    assert.strictEqual(args.diagnosticArgs.includes('ib-secret'), false);
    assert.ok(args.executionArgs.includes('/ConfigurationRepositoryCommit'));
    assert.ok(args.executionArgs.includes('-comment'));
  });

  test('transport maps readable repository exit failure and never puts either password in its log', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-transport-'));
    let diagnostic = '';
    let emptyLog = false;
    let removed = false;
    const transport = new ConfigurationRepositoryTransport({
      resolveExecutable: () => ({ status: 'resolved', path: 'C:\\1cv8.exe', version: '8.3.27', source: 'settings' }),
      mkdtemp: fs.mkdtemp,
      rm: async (target, options) => { removed = true; await fs.rm(target, options); },
      runProcess: async ({ batchArguments }) => {
        diagnostic = batchArguments.diagnosticArgs.join(' ');
        return {
          status: 'inDoubt',
          errorCode: 'CONFIGURATOR_EXIT_FAILED',
          started: true,
          effectPossible: true,
          exitCode: 1,
          signal: null,
          combinedLog: emptyLog ? '' : 'Справочник.Products: пользователь уже захватил объект',
          logTruncated: false,
          outputFileReadable: true,
          diagnostic: { executablePath: 'C:\\1cv8.exe', args: batchArguments.diagnosticArgs },
        };
      },
    });
    await fs.writeFile(
      path.join(rootPath, 'Objects.xml'),
      '<Objects><Object fullName="Справочник.Products"/></Objects>',
      'utf8',
    );
    const outcome = await transport.run({
      operation: 'lock',
      target: { configRoot: 'C:\\Config', configKind: 'cf', key: 'cf:C:\\Config' },
      binding: {
        repositoryPath: 'C:\\Repository',
        repositoryUser: 'repo',
        executionInfobaseId: 'test-infobase',
        repositoryPassword: 'repo-secret',
      },
      infobase: infobase('C:\\Bases\\Demo'),
      infobaseCredentials: { user: 'ib', password: 'ib-secret' },
      objectListPath: path.join(rootPath, 'Objects.xml'),
      cancellation: neverCancelled(),
    });
    assert.strictEqual(outcome.status, 'failed');
    assert.match(outcome.message, /Справочник\.Products/u);
    assert.match(outcome.message, /пользователь/u);
    assert.strictEqual(diagnostic.includes('repo-secret'), false);
    assert.strictEqual(diagnostic.includes('ib-secret'), false);
    assert.strictEqual(outcome.log.includes('repo-secret'), false);
    assert.strictEqual(outcome.log.includes('ib-secret'), false);
    assert.strictEqual(removed, true);
    emptyLog = true;
    const emptyOutputOutcome = await transport.run({
      operation: 'lock',
      target: { configRoot: 'C:\\Config', configKind: 'cf', key: 'cf:C:\\Config' },
      binding: {
        repositoryPath: 'C:\\Repository',
        repositoryUser: 'repo',
        executionInfobaseId: 'test-infobase',
        repositoryPassword: 'repo-secret',
      },
      infobase: infobase('C:\\Bases\\Demo'),
      objectListPath: path.join(rootPath, 'Objects.xml'),
      cancellation: neverCancelled(),
    });
    assert.strictEqual(emptyOutputOutcome.status, 'failed');
    assert.match(emptyOutputOutcome.message, /код выхода 1/u);
    await fs.rm(rootPath, { recursive: true, force: true });
  });

  test('resolver maps configuration object to Russian repository full name and ibcmd name', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-test-'));
    try {
      await fs.writeFile(
        path.join(rootPath, 'Configuration.xml'),
        '<Configuration xmlns="http://v8.1c.ru/8.3/MDClasses"><Properties><Name>Demo</Name></Properties></Configuration>',
        'utf8',
      );
      const root = node(MetadataType.Configuration, 'Configuration', rootPath, {});
      const folder = node(MetadataType.Unknown, 'Catalogs', undefined, {}, root);
      const catalog = node(MetadataType.Catalog, 'Products', undefined, {}, folder);
      const target = resolveRepositoryTarget(catalog);
      assert.ok(target);
      assert.strictEqual(target?.configKind, 'cf');
      const reference = target ? resolveRepositoryObject(catalog, target) : undefined;
      assert.ok(reference);
      assert.strictEqual(reference?.repositoryFullName, 'Справочник.Products');
      assert.strictEqual(reference?.ibcmdFullName, 'Catalog.Products');
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });

  test('resolver keeps a CFE target independent from the parent CF target', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-cfe-'));
    try {
      await fs.writeFile(
        path.join(rootPath, 'Configuration.xml'),
        '<Configuration><Properties><Name>SalesExtension</Name></Properties></Configuration>',
        'utf8',
      );
      const extension = node(MetadataType.Extension, 'SalesExtension', rootPath, { isExtension: true });
      const catalog = node(MetadataType.Catalog, 'Products', undefined, {}, extension);
      const target = resolveRepositoryTarget(catalog);
      assert.ok(target);
      assert.strictEqual(target?.configKind, 'cfe');
      assert.strictEqual(target?.extensionName, 'SalesExtension');
      const cfKey = repositoryTargetKey({ configRoot: rootPath, configKind: 'cf' });
      assert.notStrictEqual(target?.key, cfKey);
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });

  test('objects list is deterministic, deduplicated and XML-escaped', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-test-'));
    try {
      const root = node(MetadataType.Configuration, 'Configuration', rootPath, {});
      const folder = node(MetadataType.Unknown, 'Catalogs', undefined, {}, root);
      const first = node(MetadataType.Catalog, 'A&B', undefined, {}, folder);
      const second = node(MetadataType.Catalog, 'A&B', undefined, {}, folder);
      const target = {
        configRoot: rootPath,
        configKind: 'cf' as const,
        key: repositoryTargetKey({ configRoot: rootPath, configKind: 'cf' }),
      };
      const firstReference = resolveRepositoryObject(first, target);
      const secondReference = resolveRepositoryObject(second, target);
      assert.ok(firstReference && secondReference);
      const objects = await writeRepositoryObjectsFile(target, [firstReference!, secondReference!], false);
      try {
        const xml = await fs.readFile(objects.filePath, 'utf8');
        assert.strictEqual((xml.match(/<Object /gu) ?? []).length, 1);
        assert.match(xml, /Справочник\.A&amp;B/u);
        assert.match(xml, /includeChildObjects="false"/u);
      } finally {
        await objects.dispose();
      }
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });

  test('full update publishes a mirror, removes stale files and is failure-safe before swap', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-publish-'));
    const sourcePath = path.join(rootPath, 'source');
    const destinationPath = path.join(rootPath, 'destination');
    const missingSource = path.join(rootPath, 'missing');
    try {
      await fs.mkdir(path.join(sourcePath, 'Catalogs'), { recursive: true });
      await fs.mkdir(destinationPath, { recursive: true });
      await fs.writeFile(path.join(sourcePath, 'Configuration.xml'), '<Configuration/>', 'utf8');
      await fs.writeFile(path.join(sourcePath, 'Catalogs', 'New.xml'), '<Catalog/>', 'utf8');
      await fs.writeFile(path.join(destinationPath, 'Configuration.xml'), '<Configuration old="true"/>', 'utf8');
      await fs.writeFile(path.join(destinationPath, 'ConfigDumpInfo.xml'), '<Dump old="true"/>', 'utf8');
      await fs.writeFile(path.join(destinationPath, 'Catalogs', 'Old.xml'), '<Catalog old="true"/>', 'utf8').catch(async () => {
        await fs.mkdir(path.join(destinationPath, 'Catalogs'), { recursive: true });
        await fs.writeFile(path.join(destinationPath, 'Catalogs', 'Old.xml'), '<Catalog old="true"/>', 'utf8');
      });
      await fs.mkdir(path.join(destinationPath, 'Documents'), { recursive: true });
      await fs.writeFile(path.join(destinationPath, 'Documents', 'Stale.xml'), '<Document old="true"/>', 'utf8');
      await fs.writeFile(path.join(destinationPath, 'README.md'), 'workspace notes', 'utf8');
      await fs.mkdir(path.join(destinationPath, 'scripts'), { recursive: true });
      await fs.writeFile(path.join(destinationPath, 'scripts', 'deploy.ps1'), 'Write-Output keep', 'utf8');
      await publishConfigurationTree(sourcePath, destinationPath);
      assert.strictEqual(await fs.readFile(path.join(destinationPath, 'Catalogs', 'New.xml'), 'utf8'), '<Catalog/>');
      await assert.rejects(fs.access(path.join(destinationPath, 'Catalogs', 'Old.xml')));
      await assert.rejects(fs.access(path.join(destinationPath, 'ConfigDumpInfo.xml')));
      await assert.rejects(fs.access(path.join(destinationPath, 'Documents')));
      assert.strictEqual(await fs.readFile(path.join(destinationPath, 'README.md'), 'utf8'), 'workspace notes');
      assert.strictEqual(await fs.readFile(path.join(destinationPath, 'scripts', 'deploy.ps1'), 'utf8'), 'Write-Output keep');

      const beforeFailure = await fs.readFile(path.join(destinationPath, 'Configuration.xml'), 'utf8');
      await assert.rejects(publishConfigurationTree(missingSource, destinationPath));
      assert.strictEqual(await fs.readFile(path.join(destinationPath, 'Configuration.xml'), 'utf8'), beforeFailure);
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });

  test('full update restores generated entries on injected publication failure and retains recovery backup on rollback failure', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-publish-failure-'));
    const sourcePath = path.join(rootPath, 'source');
    const destinationPath = path.join(rootPath, 'destination');
    try {
      await fs.mkdir(path.join(sourcePath, 'Catalogs'), { recursive: true });
      await fs.mkdir(destinationPath, { recursive: true });
      await fs.writeFile(path.join(sourcePath, 'Configuration.xml'), '<Configuration new="true"/>', 'utf8');
      await fs.writeFile(path.join(sourcePath, 'Catalogs', 'New.xml'), '<Catalog new="true"/>', 'utf8');
      await fs.writeFile(path.join(destinationPath, 'Configuration.xml'), '<Configuration old="true"/>', 'utf8');
      await fs.mkdir(path.join(destinationPath, 'Catalogs'), { recursive: true });
      await fs.writeFile(path.join(destinationPath, 'Catalogs', 'Old.xml'), '<Catalog old="true"/>', 'utf8');
      await fs.writeFile(path.join(destinationPath, 'README.md'), 'keep this', 'utf8');

      let failPublication = true;
      const failingRename = async (from: string, to: string): Promise<void> => {
        if (failPublication && from.includes(`${path.sep}staging${path.sep}`)) {
          failPublication = false;
          throw new Error('injected publication failure');
        }
        await fs.rename(from, to);
      };
      await assert.rejects(
        publishConfigurationTree(sourcePath, destinationPath, { rename: failingRename }),
        /injected publication failure/u,
      );
      assert.strictEqual(await fs.readFile(path.join(destinationPath, 'Configuration.xml'), 'utf8'), '<Configuration old="true"/>');
      assert.strictEqual(await fs.readFile(path.join(destinationPath, 'Catalogs', 'Old.xml'), 'utf8'), '<Catalog old="true"/>');
      assert.strictEqual(await fs.readFile(path.join(destinationPath, 'README.md'), 'utf8'), 'keep this');

      let recoveryPath = '';
      let failRestore = true;
      const failingRestoreRename = async (from: string, to: string): Promise<void> => {
        if (from.includes(`${path.sep}staging${path.sep}`)) {
          throw new Error('injected publication failure');
        }
        if (failRestore && from.includes(`${path.sep}backup${path.sep}`)) {
          failRestore = false;
          throw new Error('injected restore failure');
        }
        await fs.rename(from, to);
      };
      await assert.rejects(
        publishConfigurationTree(sourcePath, destinationPath, { rename: failingRestoreRename }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Резервная копия сохранена:/u);
          recoveryPath = error.message.match(/Резервная копия сохранена:\s*(.*?)\.\s+Исходная/u)?.[1] ?? '';
          return recoveryPath.length > 0;
        },
      );
      assert.ok(recoveryPath, 'rollback failure must disclose a recovery path');
      assert.ok((await fs.stat(recoveryPath)).isDirectory(), 'backup must survive rollback failure');
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });

  test('tree decoration uses last-known lock only and never invents lock for unknown state', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-test-'));
    try {
      await fs.writeFile(path.join(rootPath, 'Configuration.xml'), '<Configuration/>', 'utf8');
      const root = node(MetadataType.Configuration, 'Configuration', rootPath, {});
      const folder = node(MetadataType.Unknown, 'Catalogs', undefined, {}, root);
      const catalog = node(MetadataType.Catalog, 'Products', undefined, {}, folder);
      const target = resolveRepositoryTarget(catalog);
      assert.ok(target);
      const projection = new RepositoryStateProjection();
      projection.set(target!.key, {
        connection: 'connected',
        locks: { 'Справочник.Products': 'heldByCurrentCredentials' },
        source: 'configuratorAcknowledgement',
      });
      const locked = resolveRepositoryTreeDecoration(catalog, projection);
      assert.strictEqual(locked?.iconIntent, 'lock');
      projection.set(target!.key, {
        connection: 'unknown',
        locks: { 'Справочник.Products': 'unknown' },
        source: 'unknown',
      });
      const unknown = resolveRepositoryTreeDecoration(catalog, projection);
      assert.strictEqual(unknown?.iconIntent, undefined);
      assert.strictEqual(unknown?.lockState, 'unknown');
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });

  test('binding/state read-modify-write is serialized and preserves concurrent CF/CFE entries', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-store-'));
    try {
      const targetCf = { configRoot: path.join(rootPath, 'cf'), configKind: 'cf' as const, key: 'cf' };
      const targetCfe = {
        configRoot: path.join(rootPath, 'cfe'),
        configKind: 'cfe' as const,
        extensionName: 'Ext',
        key: 'cfe',
      };
      const bindingStore = new RepositoryBindingStore(path.join(rootPath, 'bindings.json'));
      await Promise.all([
        bindingStore.set(targetCf, { repositoryPath: 'repo', repositoryUser: 'u', executionInfobaseId: 'cf-ib' }),
        bindingStore.set(targetCfe, { repositoryPath: 'repo', repositoryUser: 'u', executionInfobaseId: 'cfe-ib' }),
      ]);
      assert.strictEqual((await bindingStore.list()).length, 2);

      const stateStore = new RepositoryStateStore(path.join(rootPath, 'state.json'));
      await Promise.all([
        stateStore.set(targetCf, { connection: 'connected', locks: {}, source: 'configuratorAcknowledgement' }),
        stateStore.set(targetCfe, { connection: 'unknown', locks: {}, source: 'unknown' }),
      ]);
      assert.strictEqual((await stateStore.get(targetCf)).connection, 'connected');
      assert.strictEqual((await stateStore.get(targetCfe)).connection, 'unknown');
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });

  test('service persists execution IB before bind, routes later lock and updates lock state', async () => {
    const harness = await createServiceHarness(() => acknowledgedOutcome('bind'));
    try {
      const connected = await harness.service.connect(harness.target, harness.entry, {
        repositoryPath: 'repo',
        repositoryUser: 'u',
        repositoryPassword: 'secret',
        executionInfobaseId: harness.entry.id,
      }, neverCancelled());
      assert.strictEqual(connected.status, 'acknowledged');
      assert.strictEqual((await harness.bindingStore.get(harness.target))?.executionInfobaseId, harness.entry.id);
      assert.strictEqual((await harness.stateStore.get(harness.target)).connection, 'connected');
      assert.strictEqual(await harness.secrets.get('repositoryPassword'), 'secret');

      harness.transport.run = async (request: any) => {
        harness.calls.push(request);
        if (request.objectListPath) {
          harness.objectXml = await fs.readFile(request.objectListPath, 'utf8');
        }
        return acknowledgedOutcome(request.operation);
      };
      harness.calls.length = 0;
      const locked = await harness.service.lock(harness.catalog, neverCancelled());
      assert.strictEqual(locked.status, 'acknowledged');
      assert.strictEqual(harness.calls[0]?.infobase.id, harness.entry.id);
      assert.match(harness.objectXml, /includeChildObjects="true"/u);
      assert.strictEqual((await harness.stateStore.get(harness.target)).locks['Справочник.Products'], 'heldByCurrentCredentials');
      const unlocked = await harness.service.unlock(harness.catalog, neverCancelled());
      assert.strictEqual(unlocked.status, 'acknowledged');
      assert.strictEqual((await harness.stateStore.get(harness.target)).locks['Справочник.Products'], 'unlocked');
    } finally {
      await harness.dispose();
    }
  });

  test('bind inDoubt keeps candidate binding/secret, marks unknown and quarantines physical IB', async () => {
    const harness = await createServiceHarness(() => ({
      status: 'inDoubt' as const,
      operation: 'bind' as const,
      errorCode: 'CONFIGURATOR_TIMED_OUT_AFTER_START',
      message: 'timeout',
      log: '',
    }));
    try {
      const result = await harness.service.connect(harness.target, harness.entry, {
        repositoryPath: 'repo', repositoryUser: 'u', repositoryPassword: 'secret', executionInfobaseId: harness.entry.id,
      }, neverCancelled());
      assert.strictEqual(result.status, 'inDoubt');
      assert.strictEqual((await harness.bindingStore.get(harness.target))?.executionInfobaseId, harness.entry.id);
      assert.strictEqual(await harness.secrets.get('repositoryPassword'), 'secret');
      assert.strictEqual((await harness.stateStore.get(harness.target)).connection, 'unknown');
      assert.strictEqual(harness.queue.getQuarantines([await resolveInfobaseCanonicalIdentity(harness.entry)]).length, 1);
    } finally {
      await harness.dispose();
    }
  });

  test('local reload failure after acknowledged operation does not quarantine the physical IB', async () => {
    const harness = await createServiceHarness(
      (operation) => acknowledgedOutcome(operation as 'bind' | 'lock'),
      async () => { throw new Error('reload failed'); },
    );
    try {
      const connected = await harness.service.connect(harness.target, harness.entry, {
        repositoryPath: 'repo', repositoryUser: 'u', repositoryPassword: 'secret', executionInfobaseId: harness.entry.id,
      }, neverCancelled());
      assert.strictEqual(connected.status, 'acknowledged');
      const result = await harness.service.lock(harness.catalog, neverCancelled());
      assert.strictEqual(result.status, 'inDoubt');
      assert.strictEqual(harness.queue.getQuarantines([await resolveInfobaseCanonicalIdentity(harness.entry)]).length, 0);
      assert.strictEqual((await harness.stateStore.get(harness.target)).connection, 'unknown');
    } finally {
      await harness.dispose();
    }
  });

  test('definitive repository failure is failed and does not quarantine the IB', async () => {
    const harness = await createServiceHarness(() => ({
      status: 'failed' as const,
      operation: 'bind' as const,
      errorCode: 'CONFIGURATOR_REPOSITORY_OPERATION_FAILED',
      message: 'чужой захват',
      retryable: false,
      log: 'чужой захват',
    }));
    try {
      const result = await harness.service.connect(harness.target, harness.entry, {
        repositoryPath: 'repo', repositoryUser: 'u', executionInfobaseId: harness.entry.id,
      }, neverCancelled());
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(harness.queue.getQuarantines(['file:does-not-exist']).length, 0);
      assert.strictEqual(await harness.bindingStore.get(harness.target), undefined);
      assert.strictEqual(await harness.secrets.get('repositoryPassword'), undefined);
      assert.strictEqual((await harness.service.getObservedState(harness.target)).connection, 'disconnected');
    } finally {
      await harness.dispose();
    }
  });

  test('failed reconnect restores the exact previous binding, secret and state', async () => {
    let mode: any = acknowledgedOutcome('bind');
    const harness = await createServiceHarness(() => mode);
    try {
      const originalBinding = {
        repositoryPath: 'repo-old',
        repositoryUser: 'old-user',
        repositoryPassword: 'old-secret',
        executionInfobaseId: harness.entry.id,
      };
      const connected = await harness.service.connect(harness.target, harness.entry, originalBinding, neverCancelled());
      assert.strictEqual(connected.status, 'acknowledged');
      const previousState = await harness.stateStore.get(harness.target);
      mode = {
        status: 'failed' as const,
        operation: 'bind' as const,
        errorCode: 'CONFIGURATOR_REPOSITORY_OPERATION_FAILED',
        message: 'чужой захват',
        retryable: false,
        log: 'чужой захват',
      };
      const failed = await harness.service.connect(harness.target, harness.entry, {
        repositoryPath: 'repo-new',
        repositoryUser: 'new-user',
        repositoryPassword: 'new-secret',
        executionInfobaseId: harness.entry.id,
      }, neverCancelled());
      assert.strictEqual(failed.status, 'failed');
      assert.deepStrictEqual(await harness.bindingStore.get(harness.target), {
        repositoryPath: originalBinding.repositoryPath,
        repositoryUser: originalBinding.repositoryUser,
        executionInfobaseId: originalBinding.executionInfobaseId,
      });
      assert.strictEqual(await harness.secrets.get('repositoryPassword'), 'old-secret');
      assert.deepStrictEqual(await harness.stateStore.get(harness.target), previousState);
    } finally {
      await harness.dispose();
    }
  });

  test('cancel-before-start rolls back a first bind without unknown state or quarantine', async () => {
    const harness = await createServiceHarness(() => ({
      status: 'failed' as const,
      operation: 'bind' as const,
      errorCode: 'CONFIGURATOR_CANCELLED_BEFORE_START',
      message: 'cancelled',
      retryable: true,
      log: '',
    }));
    try {
      const result = await harness.service.connect(harness.target, harness.entry, {
        repositoryPath: 'repo', repositoryUser: 'u', repositoryPassword: 'secret', executionInfobaseId: harness.entry.id,
      }, neverCancelled());
      assert.strictEqual(result.status, 'cancelled');
      assert.strictEqual(await harness.bindingStore.get(harness.target), undefined);
      assert.strictEqual(await harness.secrets.get('repositoryPassword'), undefined);
      assert.strictEqual((await harness.service.getObservedState(harness.target)).connection, 'disconnected');
      assert.strictEqual(harness.queue.getQuarantines([await resolveInfobaseCanonicalIdentity(harness.entry)]).length, 0);
    } finally {
      await harness.dispose();
    }
  });
});

function node(
  type: MetadataType,
  name: string,
  filePath: string | undefined,
  properties: TreeNode['properties'],
  parent?: TreeNode,
): TreeNode {
  return {
    id: `${type}.${name}`,
    name,
    type,
    properties,
    ...(filePath ? { filePath } : {}),
    ...(parent ? { parent } : {}),
    children: [],
  };
}

function infobase(filePath: string) {
  return {
    id: 'test-infobase',
    name: 'Test',
    type: 'file' as const,
    filePath,
    hasStoredPassword: false,
    createdAt: new Date(0).toISOString(),
  };
}

function neverCancelled() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  };
}

function acknowledgedOutcome(operation: 'bind' | 'lock' | 'unlock' | 'commit' | 'unbind' | 'updateObject' | 'updateConfiguration') {
  return { status: 'acknowledged' as const, operation, log: '' };
}

async function createServiceHarness(
  outcome: (operation: string) => unknown,
  reloadConfiguration?: () => Promise<void>,
) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-service-'));
  await fs.mkdir(path.join(rootPath, 'Catalogs'), { recursive: true });
  await fs.writeFile(path.join(rootPath, 'Configuration.xml'), '<Configuration/>', 'utf8');
  await fs.writeFile(path.join(rootPath, 'Catalogs', 'Products.xml'), '<Catalog/>', 'utf8');
  const root = node(MetadataType.Configuration, 'Configuration', rootPath, {});
  const folder = node(MetadataType.Unknown, 'Catalogs', undefined, {}, root);
  const catalog = node(MetadataType.Catalog, 'Products', path.join(rootPath, 'Catalogs', 'Products.xml'), {}, folder);
  const target = resolveRepositoryTarget(catalog)!;
  const entry = infobase(path.join(rootPath, '1Cv8.1CD'));
  const bindingStore = new RepositoryBindingStore(path.join(rootPath, 'bindings.json'));
  const stateStore = new RepositoryStateStore(path.join(rootPath, 'state.json'));
  const secretValues = new Map<string, string>();
  const repositorySecret = {
    get: async (_target: unknown) => secretValues.get('repositoryPassword'),
    set: async (_target: unknown, value: string) => { secretValues.set('repositoryPassword', value); },
    delete: async (_target: unknown) => { secretValues.delete('repositoryPassword'); },
  };
  const calls: any[] = [];
  let objectXml = '';
  const transport: any = {
    run: async (request: any) => {
      calls.push(request);
      return outcome(request.operation);
    },
  };
  const storage: any = {
    getById: async (id: string) => id === entry.id ? entry : undefined,
    readPasswordSecret: async () => undefined,
  };
  const queue = new InfobaseConfigurationOperationQueue();
  const service = new ConfigurationRepositoryService({
    bindingStore,
    secretStore: repositorySecret as any,
    stateStore,
    infobaseStorage: storage,
    transport,
    queue,
    ...(reloadConfiguration ? { reloadConfiguration } : {}),
  });
  return {
    rootPath,
    target,
    entry,
    catalog,
    service,
    bindingStore,
    stateStore,
    secrets: { get: async (key: string) => secretValues.get(key) },
    transport,
    calls,
    get objectXml() { return objectXml; },
    set objectXml(value: string) { objectXml = value; },
    queue,
    dispose: async () => fs.rm(rootPath, { recursive: true, force: true }),
  };
}
