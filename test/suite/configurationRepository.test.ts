import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  buildConfigurationRepositoryBatchArgs,
} from '../../src/services/configurator/configuratorBatchArgs';
import { publishConfigurationTree } from '../../src/infobases/infobaseConfigCommands';
import {
  ConfigurationRepositoryTransport,
} from '../../src/services/configurationRepository/configurationRepositoryTransport';
import {
  ConfigurationRepositoryService,
  type ConfigurationRepositoryServiceDeps,
} from '../../src/services/configurationRepository/configurationRepositoryService';
import {
  InfobaseConfigurationOperationQueue,
  type InfobaseConfigurationOperationLease,
  type InfobaseConfigurationQueueCancellation,
  type InfobaseConfigurationQueueIdentity,
} from '../../src/infobases/infobaseConfigurationOperationQueue';
import { resolveInfobaseCanonicalIdentity } from '../../src/infobases/infobaseCanonicalIdentity';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import {
  resolveRepositoryObject,
  resolveRepositoryTarget,
  type ResolveRepositoryObjectOptions,
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
  repositoryTargetMutationKey,
  repositoryTargetKey,
} from '../../src/services/configurationRepository/repositoryStores';
import {
  WorkspaceRepositoryBindingStore,
  WorkspaceRepositoryStateStore,
  createWorkspaceRepositoryStoreWorkspaceLifecycle,
  migrateWorkspaceRepositoryStores,
} from '../../src/services/configurationRepository/workspaceRepositoryStores';
import { XmlParser } from '../../src/parsers/xmlParser';
import type { IbcmdInfobaseOperationResult } from '../../src/services/ibcmd/ibcmdInfobaseOperationResult';
import type {
  ConfigurationRepositoryTransportOutcome,
  ConfigurationRepositoryTransportRequest,
  RepositoryBinding,
  RepositoryServiceResult,
  RepositoryTarget,
} from '../../src/services/configurationRepository/types';
import { ReloadCoordinatorService } from '../../src/services/reloadCoordinatorService';
import type { ReloadReason } from '../../src/types/reloadContracts';
import { createRequestConfigurationReload } from '../../src/reload/requestConfigurationReload';

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

  test('resolver does not parse Configuration.xml for every object in a base configuration', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-fast-target-'));
    const originalParseFile = XmlParser.parseFile;
    let parseCount = 0;
    try {
      await fs.writeFile(
        path.join(rootPath, 'Configuration.xml'),
        '<Configuration><Properties><Name>Demo</Name></Properties></Configuration>',
        'utf8',
      );
      const root = node(MetadataType.Configuration, 'Configuration', rootPath, {});
      const folder = node(MetadataType.Unknown, 'Catalogs', undefined, {}, root);
      const catalogs = Array.from({ length: 32 }, (_, index) =>
        node(MetadataType.Catalog, `Product${index}`, undefined, {}, folder));

      (XmlParser as unknown as { parseFile: typeof XmlParser.parseFile }).parseFile = ((_filePath: string) => {
        parseCount += 1;
        return {};
      }) as typeof XmlParser.parseFile;

      for (const catalog of catalogs) {
        const target = resolveRepositoryTarget(catalog);
        assert.ok(target);
        assert.strictEqual(target?.configKind, 'cf');
      }

      assert.strictEqual(parseCount, 0, 'base repository targets must not parse the large Configuration.xml');
    } finally {
      (XmlParser as unknown as { parseFile: typeof XmlParser.parseFile }).parseFile = originalParseFile;
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });

  test('repository object resolver keeps file collection opt-in for tree decorations', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-object-identity-'));
    try {
      const descriptorPath = path.join(rootPath, 'Catalogs', 'Products.xml');
      const modulePath = path.join(rootPath, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl');
      await fs.mkdir(path.dirname(modulePath), { recursive: true });
      await fs.writeFile(path.join(rootPath, 'Configuration.xml'), '<Configuration/>', 'utf8');
      await fs.writeFile(descriptorPath, '<Catalog/>', 'utf8');
      await fs.writeFile(modulePath, 'Процедура Тест()\nКонецПроцедуры', 'utf8');

      const root = node(MetadataType.Configuration, 'Configuration', rootPath, {});
      const folder = node(MetadataType.Unknown, 'Catalogs', undefined, {}, root);
      const catalog = node(MetadataType.Catalog, 'Products', descriptorPath, {}, folder);
      const target = resolveRepositoryTarget(catalog);
      assert.ok(target);

      const identity = resolveRepositoryObject(catalog, target!, {
        includeFiles: false,
      } satisfies ResolveRepositoryObjectOptions);
      assert.ok(identity);
      assert.deepStrictEqual(identity?.relativeFiles, []);

      const complete = resolveRepositoryObject(catalog, target!);
      assert.ok(complete);
      assert.ok(complete?.relativeFiles.some((file) => file.endsWith('Products/Ext/ObjectModule.bsl')));
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

  test('binding and state writes serialize across nested owner removal and re-add', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-owner-race-'));
    const nestedOwner = path.join(workspaceRoot, 'NestedOwner');
    const globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-owner-race-global-'));
    await fs.mkdir(nestedOwner, { recursive: true });
    const configRoot = path.join(nestedOwner, 'Configuration');
    const target = {
      configRoot,
      configKind: 'cf' as const,
      key: repositoryTargetKey({ configRoot, configKind: 'cf' }),
    };
    let workspaceFolders = [workspaceRoot, nestedOwner];
    const options = { getWorkspaceFolders: () => workspaceFolders, globalStorageRoot: globalRoot };
    const bindingStore = new WorkspaceRepositoryBindingStore(options);
    const stateStore = new WorkspaceRepositoryStateStore(options);
    const parentBindingPath = path.join(workspaceRoot, '.vscode', 'configuration-repository-bindings.json');
    const parentStatePath = path.join(workspaceRoot, '.vscode', 'configuration-repository-state.json');
    const originalDelete = RepositoryBindingStore.prototype.delete;
    const originalClear = RepositoryStateStore.prototype.clear;
    let releaseCleanup!: () => void;
    let cleanupStarted!: () => void;
    let cleanupCount = 0;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const cleanupStartedPromise = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    const waitForCleanup = async (): Promise<void> => {
      cleanupCount += 1;
      if (cleanupCount === 1) {
        cleanupStarted();
      }
      await cleanupGate;
    };

    RepositoryBindingStore.prototype.delete = async function (deleteTarget) {
      if (path.resolve((this as unknown as { filePath: string }).filePath) === path.resolve(parentBindingPath)) {
        await waitForCleanup();
      }
      return originalDelete.call(this, deleteTarget);
    };
    RepositoryStateStore.prototype.clear = async function (clearTarget) {
      if (path.resolve((this as unknown as { filePath: string }).filePath) === path.resolve(parentStatePath)) {
        await waitForCleanup();
      }
      return originalClear.call(this, clearTarget);
    };

    try {
      const firstWrite = Promise.all([
        bindingStore.set(target, {
          repositoryPath: 'repo-first', repositoryUser: 'user', executionInfobaseId: 'ib-first',
        }),
        stateStore.set(target, {
          connection: 'connected', locks: { 'Catalog.First': 'heldByCurrentCredentials' },
          source: 'configuratorAcknowledgement',
        }),
      ]);
      await cleanupStartedPromise;

      workspaceFolders = [workspaceRoot];
      const secondWrite = Promise.all([
        bindingStore.set(target, {
          repositoryPath: 'repo-second', repositoryUser: 'user', executionInfobaseId: 'ib-second',
        }),
        stateStore.set(target, {
          connection: 'disconnected', locks: { 'Catalog.Second': 'unlocked' }, source: 'unknown',
        }),
      ]);
      workspaceFolders = [workspaceRoot, nestedOwner];
      let secondWriteFinished = false;
      void secondWrite.then(() => { secondWriteFinished = true; });
      await Promise.race([
        secondWrite,
        new Promise<void>((resolve) => setTimeout(resolve, 100)),
      ]);
      const secondWriteFinishedBeforeRelease = secondWriteFinished;
      releaseCleanup();
      await Promise.all([firstWrite, secondWrite]);

      assert.strictEqual(secondWriteFinishedBeforeRelease, false, 'the second target transaction must wait behind first-owner cleanup');
      assert.strictEqual((await bindingStore.get(target))?.repositoryPath, 'repo-second');
      assert.strictEqual((await stateStore.get(target)).connection, 'disconnected');
      assert.deepStrictEqual((await stateStore.get(target)).locks, { 'Catalog.Second': 'unlocked' });
    } finally {
      releaseCleanup();
      RepositoryBindingStore.prototype.delete = originalDelete;
      RepositoryStateStore.prototype.clear = originalClear;
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(globalRoot, { recursive: true, force: true });
    }
  });

  test('first access reconciles binding and state to a re-added nested owner before the old root is removed', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-owner-readd-'));
    const nestedOwner = path.join(workspaceRoot, 'NestedOwner');
    const globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-owner-readd-global-'));
    await fs.mkdir(nestedOwner, { recursive: true });
    const configRoot = path.join(nestedOwner, 'Configuration');
    const target = {
      configRoot,
      configKind: 'cf' as const,
      key: repositoryTargetKey({ configRoot, configKind: 'cf' }),
    };
    let workspaceFolders = [workspaceRoot, nestedOwner];
    const options = { getWorkspaceFolders: () => workspaceFolders, globalStorageRoot: globalRoot };
    const bindingStore = new WorkspaceRepositoryBindingStore(options);
    const stateStore = new WorkspaceRepositoryStateStore(options);
    const parentBindingStore = new RepositoryBindingStore(
      path.join(workspaceRoot, '.vscode', 'configuration-repository-bindings.json'),
    );
    const parentStateStore = new RepositoryStateStore(
      path.join(workspaceRoot, '.vscode', 'configuration-repository-state.json'),
    );
    const nestedBindingStore = new RepositoryBindingStore(
      path.join(nestedOwner, '.vscode', 'configuration-repository-bindings.json'),
    );
    const nestedStateStore = new RepositoryStateStore(
      path.join(nestedOwner, '.vscode', 'configuration-repository-state.json'),
    );

    try {
      await bindingStore.set(target, {
        repositoryPath: 'repo-in-nested-owner', repositoryUser: 'user', executionInfobaseId: 'ib-nested',
      });
      await stateStore.set(target, {
        connection: 'connected', locks: { 'Catalog.Before': 'heldByCurrentCredentials' },
        source: 'configuratorAcknowledgement',
      });

      workspaceFolders = [workspaceRoot];
      await bindingStore.set(target, {
        repositoryPath: 'repo-second', repositoryUser: 'user', executionInfobaseId: 'ib-second',
      });
      await stateStore.set(target, {
        connection: 'disconnected', locks: { 'Catalog.Second': 'unlocked' }, source: 'unknown',
      });
      workspaceFolders = [workspaceRoot, nestedOwner];

      assert.strictEqual((await bindingStore.get(target))?.repositoryPath, 'repo-second');
      assert.strictEqual((await stateStore.getStored(target))?.connection, 'disconnected');
      assert.strictEqual((await nestedBindingStore.get(target))?.repositoryPath, 'repo-second');
      assert.deepStrictEqual((await nestedStateStore.getStored(target))?.locks, { 'Catalog.Second': 'unlocked' });
      assert.strictEqual(await parentBindingStore.get(target), undefined);
      assert.strictEqual(await parentStateStore.getStored(target), undefined);

      workspaceFolders = [nestedOwner];
      assert.strictEqual((await bindingStore.get(target))?.repositoryPath, 'repo-second');
      assert.strictEqual((await stateStore.getStored(target))?.connection, 'disconnected');
      assert.strictEqual((await bindingStore.list()).some((entry) => entry.targetKey === target.key), true);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(globalRoot, { recursive: true, force: true });
    }
  });

  test('binding list reconciles foreign records before their former owner leaves the workspace', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-owner-list-readd-'));
    const nestedOwner = path.join(workspaceRoot, 'NestedOwner');
    const globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-owner-list-readd-global-'));
    await fs.mkdir(nestedOwner, { recursive: true });
    const configRoot = path.join(nestedOwner, 'Configuration');
    const target = {
      configRoot,
      configKind: 'cfe' as const,
      extensionName: 'Sales',
      key: repositoryTargetKey({ configRoot, configKind: 'cfe', extensionName: 'Sales' }),
    };
    let workspaceFolders = [workspaceRoot, nestedOwner];
    const options = { getWorkspaceFolders: () => workspaceFolders, globalStorageRoot: globalRoot };
    const bindingStore = new WorkspaceRepositoryBindingStore(options);
    const stateStore = new WorkspaceRepositoryStateStore(options);
    const parentBindingStore = new RepositoryBindingStore(
      path.join(workspaceRoot, '.vscode', 'configuration-repository-bindings.json'),
    );
    const nestedBindingStore = new RepositoryBindingStore(
      path.join(nestedOwner, '.vscode', 'configuration-repository-bindings.json'),
    );
    const nestedStateStore = new RepositoryStateStore(
      path.join(nestedOwner, '.vscode', 'configuration-repository-state.json'),
    );

    try {
      workspaceFolders = [workspaceRoot];
      await bindingStore.set(target, {
        repositoryPath: 'repo-relisted', repositoryUser: 'user', executionInfobaseId: 'ib-relisted',
      });
      await stateStore.set(target, {
        connection: 'connected', locks: { 'Catalog.Relisted': 'heldByCurrentCredentials' },
        source: 'configuratorAcknowledgement',
      });
      workspaceFolders = [workspaceRoot, nestedOwner];

      assert.strictEqual((await bindingStore.list()).length, 1);
      assert.strictEqual((await nestedBindingStore.get(target))?.repositoryPath, 'repo-relisted');
      assert.deepStrictEqual((await nestedStateStore.getStored(target))?.locks, {
        'Catalog.Relisted': 'heldByCurrentCredentials',
      });
      assert.strictEqual(await parentBindingStore.get(target), undefined);

      workspaceFolders = [nestedOwner];
      assert.strictEqual((await bindingStore.get(target))?.repositoryPath, 'repo-relisted');
      assert.strictEqual((await stateStore.getStored(target))?.connection, 'connected');
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(globalRoot, { recursive: true, force: true });
    }
  });

  test('workspace root changes migrate the binding and state pair before the former owner is removed', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-owner-events-'));
    const nestedOwner = path.join(workspaceRoot, 'NestedOwner');
    const globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-owner-events-global-'));
    await fs.mkdir(nestedOwner, { recursive: true });
    const configRoot = path.join(nestedOwner, 'Configuration');
    const target = {
      configRoot,
      configKind: 'cf' as const,
      key: repositoryTargetKey({ configRoot, configKind: 'cf' }),
    };
    let workspaceFolders = [workspaceRoot];
    const options = { getWorkspaceFolders: () => workspaceFolders, globalStorageRoot: globalRoot };
    const bindingStore = new WorkspaceRepositoryBindingStore(options);
    const stateStore = new WorkspaceRepositoryStateStore(options);
    const workspaceLifecycle = createWorkspaceRepositoryStoreWorkspaceLifecycle(options);
    const parentBindingStore = new RepositoryBindingStore(
      path.join(workspaceRoot, '.vscode', 'configuration-repository-bindings.json'),
    );
    const parentStateStore = new RepositoryStateStore(
      path.join(workspaceRoot, '.vscode', 'configuration-repository-state.json'),
    );
    const nestedBindingStore = new RepositoryBindingStore(
      path.join(nestedOwner, '.vscode', 'configuration-repository-bindings.json'),
    );
    const nestedStateStore = new RepositoryStateStore(
      path.join(nestedOwner, '.vscode', 'configuration-repository-state.json'),
    );

    try {
      await bindingStore.set(target, {
        repositoryPath: 'repo-before-folder-change', repositoryUser: 'user', executionInfobaseId: 'ib-before-change',
      });
      await stateStore.set(target, {
        connection: 'connected', locks: { 'Catalog.BeforeChange': 'heldByCurrentCredentials' },
        source: 'configuratorAcknowledgement',
      });

      workspaceFolders = [workspaceRoot, nestedOwner];
      await workspaceLifecycle.handleWorkspaceFoldersChanged();
      workspaceFolders = [nestedOwner];
      await workspaceLifecycle.handleWorkspaceFoldersChanged();

      assert.strictEqual((await bindingStore.get(target))?.repositoryPath, 'repo-before-folder-change');
      assert.strictEqual((await stateStore.getStored(target))?.connection, 'connected');
      assert.strictEqual((await nestedBindingStore.get(target))?.repositoryPath, 'repo-before-folder-change');
      assert.deepStrictEqual((await nestedStateStore.getStored(target))?.locks, {
        'Catalog.BeforeChange': 'heldByCurrentCredentials',
      });
      assert.strictEqual(await parentBindingStore.get(target), undefined);
      assert.strictEqual(await parentStateStore.getStored(target), undefined);
    } finally {
      await workspaceLifecycle.dispose();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(globalRoot, { recursive: true, force: true });
    }
  });

  test('rapid workspace changes serialize pair migration and disposal drains queued work', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-owner-events-fast-'));
    const nestedOwner = path.join(workspaceRoot, 'NestedOwner');
    const globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-owner-events-fast-global-'));
    await fs.mkdir(nestedOwner, { recursive: true });
    const configRoot = path.join(nestedOwner, 'Configuration');
    const target = {
      configRoot,
      configKind: 'cf' as const,
      key: repositoryTargetKey({ configRoot, configKind: 'cf' }),
    };
    let workspaceFolders = [workspaceRoot];
    const options = { getWorkspaceFolders: () => workspaceFolders, globalStorageRoot: globalRoot };
    const bindingStore = new WorkspaceRepositoryBindingStore(options);
    const stateStore = new WorkspaceRepositoryStateStore(options);
    const lifecycle = createWorkspaceRepositoryStoreWorkspaceLifecycle(options);
    const parentBindingPath = path.join(workspaceRoot, '.vscode', 'configuration-repository-bindings.json');
    const parentStatePath = path.join(workspaceRoot, '.vscode', 'configuration-repository-state.json');
    const nestedBindingStore = new RepositoryBindingStore(
      path.join(nestedOwner, '.vscode', 'configuration-repository-bindings.json'),
    );
    const nestedStateStore = new RepositoryStateStore(
      path.join(nestedOwner, '.vscode', 'configuration-repository-state.json'),
    );
    const originalDelete = RepositoryBindingStore.prototype.delete;
    let releaseCleanup!: () => void;
    let cleanupStarted!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const cleanupStartedPromise = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    RepositoryBindingStore.prototype.delete = async function (deleteTarget) {
      if (path.resolve((this as unknown as { filePath: string }).filePath) === path.resolve(parentBindingPath)) {
        cleanupStarted();
        await cleanupGate;
      }
      return originalDelete.call(this, deleteTarget);
    };

    try {
      await bindingStore.set(target, {
        repositoryPath: 'repo-fast-events', repositoryUser: 'user', executionInfobaseId: 'ib-fast-events',
      });
      await stateStore.set(target, {
        connection: 'connected', locks: { 'Catalog.FastEvents': 'heldByCurrentCredentials' },
        source: 'configuratorAcknowledgement',
      });

      workspaceFolders = [workspaceRoot, nestedOwner];
      const addNestedOwner = lifecycle.handleWorkspaceFoldersChanged();
      await cleanupStartedPromise;
      workspaceFolders = [nestedOwner];
      const removeFormerOwner = lifecycle.handleWorkspaceFoldersChanged();
      let disposed = false;
      const dispose = lifecycle.dispose().then(() => { disposed = true; });
      await Promise.race([dispose, new Promise<void>((resolve) => setTimeout(resolve, 50))]);
      assert.strictEqual(disposed, false, 'lifecycle disposal must wait for pending root-change migration');

      releaseCleanup();
      await Promise.all([addNestedOwner, removeFormerOwner, dispose]);
      assert.strictEqual((await nestedBindingStore.get(target))?.repositoryPath, 'repo-fast-events');
      assert.deepStrictEqual((await nestedStateStore.getStored(target))?.locks, {
        'Catalog.FastEvents': 'heldByCurrentCredentials',
      });
      assert.strictEqual(await new RepositoryBindingStore(parentBindingPath).get(target), undefined);
      assert.strictEqual(await new RepositoryStateStore(parentStatePath).getStored(target), undefined);
      assert.strictEqual((await bindingStore.get(target))?.repositoryPath, 'repo-fast-events');
      assert.strictEqual((await stateStore.getStored(target))?.connection, 'connected');
    } finally {
      releaseCleanup();
      await lifecycle.dispose();
      RepositoryBindingStore.prototype.delete = originalDelete;
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(globalRoot, { recursive: true, force: true });
    }
  });

  test('legacy migration serializes with binding and state updates across owner removal and re-add', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-migration-race-'));
    const nestedOwner = path.join(workspaceRoot, 'NestedOwner');
    const globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-migration-race-global-'));
    await fs.mkdir(nestedOwner, { recursive: true });
    const configRoot = path.join(nestedOwner, 'Configuration');
    const target = {
      configRoot,
      configKind: 'cf' as const,
      key: repositoryTargetKey({ configRoot, configKind: 'cf' }),
    };
    let workspaceFolders = [workspaceRoot, nestedOwner];
    const options = { getWorkspaceFolders: () => workspaceFolders, globalStorageRoot: globalRoot };
    const bindingStore = new WorkspaceRepositoryBindingStore(options);
    const stateStore = new WorkspaceRepositoryStateStore(options);
    const parentBindingPath = path.join(workspaceRoot, '.vscode', 'configuration-repository-bindings.json');
    const parentStatePath = path.join(workspaceRoot, '.vscode', 'configuration-repository-state.json');
    await new RepositoryBindingStore(parentBindingPath).set(target, {
      repositoryPath: 'legacy-repo', repositoryUser: 'user', executionInfobaseId: 'legacy-ib',
    });
    await new RepositoryStateStore(parentStatePath).set(target, {
      connection: 'connected', locks: { 'Catalog.Legacy': 'heldByCurrentCredentials' },
      source: 'configuratorAcknowledgement',
    });

    const originalDelete = RepositoryBindingStore.prototype.delete;
    const originalClear = RepositoryStateStore.prototype.clear;
    let releaseCleanup!: () => void;
    let cleanupStarted!: () => void;
    let cleanupCount = 0;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const cleanupStartedPromise = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    const waitForCleanup = async (): Promise<void> => {
      cleanupCount += 1;
      if (cleanupCount === 1) {
        cleanupStarted();
      }
      await cleanupGate;
    };
    RepositoryBindingStore.prototype.delete = async function (deleteTarget) {
      if (path.resolve((this as unknown as { filePath: string }).filePath) === path.resolve(parentBindingPath)) {
        await waitForCleanup();
      }
      return originalDelete.call(this, deleteTarget);
    };
    RepositoryStateStore.prototype.clear = async function (clearTarget) {
      if (path.resolve((this as unknown as { filePath: string }).filePath) === path.resolve(parentStatePath)) {
        await waitForCleanup();
      }
      return originalClear.call(this, clearTarget);
    };

    try {
      const migration = migrateWorkspaceRepositoryStores(options);
      await cleanupStartedPromise;
      workspaceFolders = [workspaceRoot];
      const secondWrite = Promise.all([
        bindingStore.set(target, {
          repositoryPath: 'repo-second', repositoryUser: 'user', executionInfobaseId: 'ib-second',
        }),
        stateStore.set(target, {
          connection: 'disconnected', locks: { 'Catalog.Second': 'unlocked' }, source: 'unknown',
        }),
      ]);
      workspaceFolders = [workspaceRoot, nestedOwner];
      let secondWriteFinished = false;
      void secondWrite.then(() => { secondWriteFinished = true; });
      await Promise.race([
        secondWrite,
        new Promise<void>((resolve) => setTimeout(resolve, 100)),
      ]);
      const secondWriteFinishedBeforeRelease = secondWriteFinished;
      releaseCleanup();
      await Promise.all([migration, secondWrite]);

      assert.strictEqual(secondWriteFinishedBeforeRelease, false, 'migration cleanup must hold the target transaction until its source is safe');
      assert.strictEqual((await bindingStore.get(target))?.repositoryPath, 'repo-second');
      assert.strictEqual((await stateStore.get(target)).connection, 'disconnected');
      assert.deepStrictEqual((await stateStore.get(target)).locks, { 'Catalog.Second': 'unlocked' });
      assert.strictEqual((await new RepositoryBindingStore(parentBindingPath).get(target)), undefined);
      assert.strictEqual((await new RepositoryStateStore(parentStatePath).getStored(target)), undefined);
    } finally {
      releaseCleanup();
      RepositoryBindingStore.prototype.delete = originalDelete;
      RepositoryStateStore.prototype.clear = originalClear;
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(globalRoot, { recursive: true, force: true });
    }
  });

  test('owner-store deletion failures remain visible after Designer acknowledged disconnect', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-owner-failure-'));
    const globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-global-failure-'));
    const configRoot = path.join(workspaceRoot, 'Configuration');
    const target = {
      configRoot,
      configKind: 'cf' as const,
      key: repositoryTargetKey({ configRoot, configKind: 'cf' }),
    };
    const entry = infobase(path.join(workspaceRoot, '1Cv8.1CD'));
    const ownerBindingPath = path.join(workspaceRoot, '.vscode', 'configuration-repository-bindings.json');
    const ownerStore = new RepositoryBindingStore(ownerBindingPath);
    await ownerStore.set(target, {
      repositoryPath: 'repo',
      repositoryUser: 'user',
      executionInfobaseId: entry.id,
    });
    const stateStore = new WorkspaceRepositoryStateStore({
      getWorkspaceFolders: () => [workspaceRoot],
      globalStorageRoot: globalRoot,
    });
    await stateStore.set(target, {
      connection: 'connected',
      locks: {},
      source: 'configuratorAcknowledgement',
    });
    const bindingStore = new WorkspaceRepositoryBindingStore({
      getWorkspaceFolders: () => [workspaceRoot],
      globalStorageRoot: globalRoot,
    });
    const repositoryPassword = 'owner-store-test-secret';
    const secretStore = {
      get: async () => repositoryPassword,
      set: async () => undefined,
      delete: async () => undefined,
    };
    const service = new ConfigurationRepositoryService({
      bindingStore,
      secretStore: secretStore as any,
      stateStore,
      infobaseStorage: { getById: async (id: string) => id === entry.id ? entry : undefined } as any,
      transport: { run: async () => acknowledgedOutcome('unbind') } as any,
      queue: new InfobaseConfigurationOperationQueue(),
      requestConfigurationReload: async () => undefined,
    });
    const originalDelete = RepositoryBindingStore.prototype.delete;
    RepositoryBindingStore.prototype.delete = async function (deleteTarget) {
      if (path.resolve((this as unknown as { filePath: string }).filePath) === path.resolve(ownerBindingPath)) {
        throw Object.assign(new Error(`owner store denied deletion for password=${repositoryPassword}`), { code: 'EPERM' });
      }
      return originalDelete.call(this, deleteTarget);
    };

    try {
      const result = await service.disconnect(target, neverCancelled());
      assert.strictEqual(result.status, 'inDoubt', 'a post-ack owner-store failure must be reported to the caller');
      assert.match(result.message, /owner store denied deletion/u);
      assert.strictEqual(result.message.includes(repositoryPassword), false, 'owner-store diagnostics must redact the repository password');
      assert.ok(await ownerStore.get(target), 'failed deletion must leave the binding available for retry');
    } finally {
      RepositoryBindingStore.prototype.delete = originalDelete;
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(globalRoot, { recursive: true, force: true });
    }
  });

  test('failed legacy migration retains the source binding and state for retry', async () => {
    const formerFirstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-legacy-first-'));
    const ownerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-legacy-owner-'));
    const globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-legacy-global-'));
    const configRoot = path.join(ownerRoot, 'Configuration');
    const target = {
      configRoot,
      configKind: 'cf' as const,
      key: repositoryTargetKey({ configRoot, configKind: 'cf' }),
    };
    const legacyBindingPath = path.join(formerFirstRoot, '.vscode', 'configuration-repository-bindings.json');
    const legacyBindingStore = new RepositoryBindingStore(legacyBindingPath);
    const legacyStateStore = new RepositoryStateStore(
      path.join(formerFirstRoot, '.vscode', 'configuration-repository-state.json'),
    );
    await legacyBindingStore.set(target, {
      repositoryPath: 'legacy-repo',
      repositoryUser: 'legacy-user',
      executionInfobaseId: 'legacy-ib',
    });
    await legacyStateStore.set(target, {
      connection: 'connected',
      locks: {},
      source: 'configuratorAcknowledgement',
    });
    const ownerBindingPath = path.join(ownerRoot, '.vscode', 'configuration-repository-bindings.json');
    const options = { getWorkspaceFolders: () => [formerFirstRoot, ownerRoot], globalStorageRoot: globalRoot };
    const routedBindingStore = new WorkspaceRepositoryBindingStore(options);
    const originalSet = RepositoryBindingStore.prototype.set;
    RepositoryBindingStore.prototype.set = async function (setTarget, binding) {
      if (path.resolve((this as unknown as { filePath: string }).filePath) === path.resolve(ownerBindingPath)) {
        throw Object.assign(new Error('destination store denied migration'), { code: 'EPERM' });
      }
      return originalSet.call(this, setTarget, binding);
    };

    try {
      await assert.rejects(routedBindingStore.list(), /destination store denied migration/u);
      await assert.rejects(migrateWorkspaceRepositoryStores(options), /destination store denied migration/u);
      assert.strictEqual((await legacyBindingStore.get(target))?.repositoryPath, 'legacy-repo');
      assert.strictEqual((await legacyStateStore.get(target)).connection, 'connected');
      assert.strictEqual(await new RepositoryBindingStore(ownerBindingPath).get(target), undefined);
    } finally {
      RepositoryBindingStore.prototype.set = originalSet;
      await fs.rm(formerFirstRoot, { recursive: true, force: true });
      await fs.rm(ownerRoot, { recursive: true, force: true });
      await fs.rm(globalRoot, { recursive: true, force: true });
    }
  });

  test('binding reads and lists durably migrate foreign-root records to their owner', async () => {
    const legacyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-list-legacy-'));
    const ownerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-list-owner-'));
    const globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-list-global-'));
    const configRoot = path.join(ownerRoot, 'Configuration');
    const target = {
      configRoot,
      configKind: 'cf' as const,
      key: repositoryTargetKey({ configRoot, configKind: 'cf' }),
    };
    const legacyStore = new RepositoryBindingStore(
      path.join(legacyRoot, '.vscode', 'configuration-repository-bindings.json'),
    );
    const options = {
      getWorkspaceFolders: () => [legacyRoot, ownerRoot],
      globalStorageRoot: globalRoot,
    };
    const routedStore = new WorkspaceRepositoryBindingStore(options);

    try {
      await legacyStore.set(target, {
        repositoryPath: 'legacy-repository',
        repositoryUser: 'legacy-user',
        executionInfobaseId: 'legacy-ib',
      });

      assert.strictEqual((await routedStore.get(target))?.repositoryPath, 'legacy-repository');
      assert.strictEqual((await routedStore.list()).length, 1);
      assert.strictEqual((await routedStore.get(target))?.repositoryPath, 'legacy-repository');
      assert.strictEqual((await legacyStore.list()).length, 0);

      await migrateWorkspaceRepositoryStores(options);
      assert.strictEqual((await routedStore.list()).length, 1, 'repeated migration must keep owner data intact');
    } finally {
      await fs.rm(legacyRoot, { recursive: true, force: true });
      await fs.rm(ownerRoot, { recursive: true, force: true });
      await fs.rm(globalRoot, { recursive: true, force: true });
    }
  });

  test('migration keeps the owning workspace value when a stale legacy copy disagrees', async () => {
    const formerFirstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-stale-first-'));
    const ownerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-stale-owner-'));
    const globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-stale-global-'));
    const configRoot = path.join(ownerRoot, 'Configuration');
    const target = {
      configRoot,
      configKind: 'cfe' as const,
      extensionName: 'Ext',
      key: repositoryTargetKey({ configRoot, configKind: 'cfe', extensionName: 'Ext' }),
    };
    const legacyBindings = new RepositoryBindingStore(
      path.join(formerFirstRoot, '.vscode', 'configuration-repository-bindings.json'),
    );
    const ownerBindings = new RepositoryBindingStore(
      path.join(ownerRoot, '.vscode', 'configuration-repository-bindings.json'),
    );
    const legacyStates = new RepositoryStateStore(
      path.join(formerFirstRoot, '.vscode', 'configuration-repository-state.json'),
    );
    const ownerStates = new RepositoryStateStore(
      path.join(ownerRoot, '.vscode', 'configuration-repository-state.json'),
    );
    await legacyBindings.set(target, {
      repositoryPath: 'stale-repository',
      repositoryUser: 'stale-user',
      executionInfobaseId: 'stale-ib',
    });
    await ownerBindings.set(target, {
      repositoryPath: 'owner-repository',
      repositoryUser: 'owner-user',
      executionInfobaseId: 'owner-ib',
    });
    await legacyStates.set(target, { connection: 'disconnected', locks: {}, source: 'unknown' });
    await ownerStates.set(target, { connection: 'connected', locks: {}, source: 'configuratorAcknowledgement' });

    try {
      await migrateWorkspaceRepositoryStores({
        getWorkspaceFolders: () => [formerFirstRoot, ownerRoot],
        globalStorageRoot: globalRoot,
      });

      assert.strictEqual((await ownerBindings.get(target))?.repositoryPath, 'owner-repository');
      assert.strictEqual((await ownerStates.get(target)).connection, 'connected');
      assert.strictEqual((await legacyBindings.list()).length, 0, 'stale legacy copy must be removed after owner data is durable');
      assert.strictEqual((await legacyStates.getStored(target)), undefined);
    } finally {
      await fs.rm(formerFirstRoot, { recursive: true, force: true });
      await fs.rm(ownerRoot, { recursive: true, force: true });
      await fs.rm(globalRoot, { recursive: true, force: true });
    }
  });

  test('repository stores use global storage without an owning workspace', async () => {
    const globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-global-fallback-'));
    const visibleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-visible-root-'));
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-external-root-'));
    const configRoot = path.join(externalRoot, 'Configuration');
    const target = {
      configRoot,
      configKind: 'cf' as const,
      key: repositoryTargetKey({ configRoot, configKind: 'cf' }),
    };
    const globalBindings = new RepositoryBindingStore(
      path.join(globalRoot, 'configuration-repository-bindings.json'),
    );
    const globalStates = new RepositoryStateStore(
      path.join(globalRoot, 'configuration-repository-state.json'),
    );
    const options = {
      getWorkspaceFolders: () => [] as readonly string[],
      globalStorageRoot: globalRoot,
    };
    const bindings = new WorkspaceRepositoryBindingStore(options);
    const states = new WorkspaceRepositoryStateStore(options);

    try {
      await bindings.set(target, { repositoryPath: 'global-repository', repositoryUser: 'user', executionInfobaseId: 'ib' });
      await states.set(target, { connection: 'connected', locks: {}, source: 'configuratorAcknowledgement' });
      assert.strictEqual((await globalBindings.get(target))?.repositoryPath, 'global-repository');
      assert.strictEqual((await globalStates.get(target)).connection, 'connected');

      const outsideBindings = new WorkspaceRepositoryBindingStore({
        getWorkspaceFolders: () => [visibleRoot],
        globalStorageRoot: globalRoot,
      });
      await outsideBindings.set(target, { repositoryPath: 'global-outside', repositoryUser: 'user', executionInfobaseId: 'ib' });
      assert.strictEqual((await globalBindings.get(target))?.repositoryPath, 'global-outside');
      assert.strictEqual(
        await new RepositoryBindingStore(path.join(visibleRoot, '.vscode', 'configuration-repository-bindings.json')).get(target),
        undefined,
      );
    } finally {
      await fs.rm(globalRoot, { recursive: true, force: true });
      await fs.rm(visibleRoot, { recursive: true, force: true });
      await fs.rm(externalRoot, { recursive: true, force: true });
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

      harness.transport.run = async (request: ConfigurationRepositoryTransportRequest) => {
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

  test('acknowledged operations preserve a replacement binding, secret and state owner', async () => {
    const successfulIbcmd: IbcmdInfobaseOperationResult = {
      status: 'success',
      exitCode: 0,
      userMessage: 'ok',
      logExcerpt: '',
    };
    const operationCases: Array<{
      readonly name: string;
      readonly operation: ConfigurationRepositoryTransportRequest['operation'];
      readonly invoke: (harness: Awaited<ReturnType<typeof createServiceHarness>>) => Promise<RepositoryServiceResult>;
      readonly exportKind?: 'objects' | 'configuration';
    }> = [
      { name: 'lock', operation: 'lock', invoke: (harness) => harness.service.lock(harness.catalog, neverCancelled()) },
      { name: 'unlock', operation: 'unlock', invoke: (harness) => harness.service.unlock(harness.catalog, neverCancelled()) },
      { name: 'commit', operation: 'commit', invoke: (harness) => harness.service.commit(harness.catalog, neverCancelled()) },
      {
        name: 'updateObject', operation: 'updateObject',
        invoke: (harness) => harness.service.updateObject(harness.catalog, neverCancelled()),
        exportKind: 'objects',
      },
      {
        name: 'updateConfiguration', operation: 'updateConfiguration',
        invoke: (harness) => harness.service.updateConfiguration(harness.catalog, neverCancelled()),
        exportKind: 'configuration',
      },
    ];
    const invariantFailures: string[] = [];

    for (const operationCase of operationCases) {
      const transportEntered = deferred<void>();
      const releaseTransport = deferred<ConfigurationRepositoryTransportOutcome>();
      let objectExportCount = 0;
      let configurationExportCount = 0;
      const harness = await createServiceHarness(
        () => acknowledgedOutcome(operationCase.operation),
        undefined,
        {
          importFiles: async () => successfulIbcmd,
          exportObjects: async () => { objectExportCount += 1; return successfulIbcmd; },
          exportConfiguration: async () => { configurationExportCount += 1; return successfulIbcmd; },
        },
      );
      let operationPromise: Promise<RepositoryServiceResult> | undefined;
      try {
        await harness.bindingStore.set(harness.target, {
          repositoryPath: 'repo-before',
          repositoryUser: 'user-before',
          executionInfobaseId: harness.entry.id,
        });
        await harness.secrets.set('repositoryPassword', 'password-before');
        await harness.stateStore.set(harness.target, {
          connection: 'connected',
          locks: { 'Catalog.Before': 'unlocked' },
          source: 'configuratorAcknowledgement',
        });
        harness.transport.run = async () => {
          transportEntered.resolve(undefined);
          return releaseTransport.promise;
        };

        operationPromise = operationCase.invoke(harness);
        const transportStarted = await settlesWithin(transportEntered.promise, 1000);
        if (!transportStarted) {
          invariantFailures.push(`${operationCase.name}: transport did not start`);
          releaseTransport.resolve(acknowledgedOutcome(operationCase.operation));
          await operationPromise;
          continue;
        }

        const replacementBinding = {
          repositoryPath: `repo-external-${operationCase.name}`,
          repositoryUser: `user-external-${operationCase.name}`,
          executionInfobaseId: harness.entry.id,
        };
        const replacementState = {
          connection: 'disconnected' as const,
          locks: { 'Catalog.External': 'heldByCurrentCredentials' as const },
          lastConfirmedAt: 'external-owner-state',
          source: 'unknown' as const,
        };
        await Promise.all([
          harness.bindingStore.set(harness.target, replacementBinding),
          harness.secrets.set('repositoryPassword', `password-external-${operationCase.name}`),
          harness.stateStore.set(harness.target, replacementState),
        ]);
        releaseTransport.resolve(acknowledgedOutcome(operationCase.operation));
        const result = await operationPromise;

        if (result.status !== 'inDoubt') {
          invariantFailures.push(`${operationCase.name}: expected inDoubt, got ${result.status}`);
        }
        if (JSON.stringify(await harness.bindingStore.get(harness.target)) !== JSON.stringify(replacementBinding)) {
          invariantFailures.push(`${operationCase.name}: replacement binding was not preserved`);
        }
        if (await harness.secrets.get('repositoryPassword') !== `password-external-${operationCase.name}`) {
          invariantFailures.push(`${operationCase.name}: replacement secret was not preserved`);
        }
        if (JSON.stringify(await harness.stateStore.get(harness.target)) !== JSON.stringify(replacementState)) {
          invariantFailures.push(`${operationCase.name}: replacement state was overwritten by a stale ACK`);
        }
        if (operationCase.exportKind === 'objects' && objectExportCount !== 0) {
          invariantFailures.push(`${operationCase.name}: stale IB export ran after owner changed`);
        }
        if (operationCase.exportKind === 'configuration' && configurationExportCount !== 0) {
          invariantFailures.push(`${operationCase.name}: stale IB export ran after owner changed`);
        }
      } finally {
        releaseTransport.resolve(acknowledgedOutcome(operationCase.operation));
        if (operationPromise) {
          await Promise.allSettled([operationPromise]);
        }
        await harness.dispose();
      }
    }

    assert.deepStrictEqual(invariantFailures, [], invariantFailures.join('\n'));
  });

  test('inDoubt repository outcome quarantines its IB without marking a replacement owner unknown', async () => {
    const harness = await createServiceHarness(() => ({
      status: 'inDoubt' as const,
      operation: 'lock' as const,
      errorCode: 'CONFIGURATOR_ACKNOWLEDGEMENT_LOST',
      message: 'acknowledgement was lost',
      log: '',
    }));
    const transportEntered = deferred<void>();
    const releaseTransport = deferred<ConfigurationRepositoryTransportOutcome>();
    let operationPromise: Promise<RepositoryServiceResult> | undefined;
    try {
      await harness.bindingStore.set(harness.target, {
        repositoryPath: 'repo-before', repositoryUser: 'user-before', executionInfobaseId: harness.entry.id,
      });
      await harness.secrets.set('repositoryPassword', 'password-before');
      await harness.stateStore.set(harness.target, {
        connection: 'connected', locks: { 'Catalog.Before': 'unlocked' }, source: 'configuratorAcknowledgement',
      });
      harness.transport.run = async () => {
        transportEntered.resolve(undefined);
        return releaseTransport.promise;
      };

      operationPromise = harness.service.lock(harness.catalog, neverCancelled());
      assert.strictEqual(await settlesWithin(transportEntered.promise, 1000), true, 'lock transport must start');
      const replacementBinding = {
        repositoryPath: 'repo-external', repositoryUser: 'external-user', executionInfobaseId: harness.entry.id,
      };
      const replacementState = {
        connection: 'disconnected' as const,
        locks: { 'Catalog.External': 'unlocked' as const },
        lastConfirmedAt: 'external-owner-state',
        source: 'unknown' as const,
      };
      await Promise.all([
        harness.bindingStore.set(harness.target, replacementBinding),
        harness.secrets.set('repositoryPassword', 'password-external'),
        harness.stateStore.set(harness.target, replacementState),
      ]);
      releaseTransport.resolve({
        status: 'inDoubt',
        operation: 'lock',
        errorCode: 'CONFIGURATOR_ACKNOWLEDGEMENT_LOST',
        message: 'acknowledgement was lost',
        log: '',
      });
      const result = await operationPromise;

      assert.strictEqual(result.status, 'inDoubt');
      assert.deepStrictEqual(await harness.bindingStore.get(harness.target), replacementBinding);
      assert.strictEqual(await harness.secrets.get('repositoryPassword'), 'password-external');
      assert.deepStrictEqual(await harness.stateStore.get(harness.target), replacementState);
      assert.strictEqual(
        harness.queue.getQuarantines([await resolveInfobaseCanonicalIdentity(harness.entry)]).length,
        1,
        'transport uncertainty must still quarantine the physical IB',
      );
    } finally {
      releaseTransport.resolve({
        status: 'inDoubt',
        operation: 'lock',
        errorCode: 'CONFIGURATOR_ACKNOWLEDGEMENT_LOST',
        message: 'cleanup outcome',
        log: '',
      });
      if (operationPromise) {
        await Promise.allSettled([operationPromise]);
      }
      await harness.dispose();
    }
  });

  test('workspace store migration during the operation snapshot remains a valid owner baseline', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-workspace-witness-'));
    const globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-workspace-global-'));
    const configRoot = path.join(workspaceRoot, 'Configuration');
    const entry = infobase(path.join(workspaceRoot, '1Cv8.1CD'));
    const target = createRepositoryTarget(configRoot);
    const options = { getWorkspaceFolders: () => [workspaceRoot], globalStorageRoot: globalRoot };
    const bindingStore = new WorkspaceRepositoryBindingStore(options);
    const stateStore = new WorkspaceRepositoryStateStore(options);
    const legacyBindingStore = new RepositoryBindingStore(path.join(globalRoot, 'configuration-repository-bindings.json'));
    const legacyStateStore = new RepositoryStateStore(path.join(globalRoot, 'configuration-repository-state.json'));
    const secretValues = new Map<string, string>();
    const secretStore = {
      get: async (secretTarget: RepositoryTarget) => secretValues.get(secretTarget.key),
      set: async (secretTarget: RepositoryTarget, value: string) => { secretValues.set(secretTarget.key, value); },
      delete: async (secretTarget: RepositoryTarget) => { secretValues.delete(secretTarget.key); },
    };
    const queue = new InfobaseConfigurationOperationQueue();
    const service = new ConfigurationRepositoryService({
      bindingStore,
      secretStore: secretStore as any,
      stateStore,
      infobaseStorage: { getById: async (id: string) => id === entry.id ? entry : undefined } as any,
      transport: { run: async (request: ConfigurationRepositoryTransportRequest) => acknowledgedOutcome(request.operation) } as any,
      queue,
      requestConfigurationReload: async () => undefined,
    });

    try {
      await Promise.all([
        fs.mkdir(configRoot, { recursive: true }),
        fs.writeFile(entry.filePath, '', 'utf8'),
      ]);
      await legacyBindingStore.set(target, {
        repositoryPath: 'legacy-repo', repositoryUser: 'legacy-user', executionInfobaseId: entry.id,
      });
      await legacyStateStore.set(target, {
        connection: 'connected', locks: { 'Catalog.Legacy': 'unlocked' }, source: 'configuratorAcknowledgement',
      });
      await secretStore.set(target, 'legacy-password');

      const result = await service.connect(target, entry, {
        repositoryPath: 'workspace-repo', repositoryUser: 'workspace-user',
        repositoryPassword: 'workspace-password', executionInfobaseId: entry.id,
      }, neverCancelled());

      assert.strictEqual(result.status, 'acknowledged');
      assert.deepStrictEqual(await bindingStore.get(target), {
        repositoryPath: 'workspace-repo', repositoryUser: 'workspace-user', executionInfobaseId: entry.id,
      });
      assert.strictEqual(await secretStore.get(target), 'workspace-password');
      assert.strictEqual((await stateStore.get(target)).connection, 'connected');
      assert.strictEqual(await legacyBindingStore.get(target), undefined, 'snapshot migration must remove the former global copy');
      assert.strictEqual(await legacyStateStore.getStored(target), undefined, 'snapshot migration must remove the former global state copy');
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(globalRoot, { recursive: true, force: true });
    }
  });

  test('same target connections on different IBs cannot let failed A roll back acknowledged B', async () => {
    const harness = await createRepositoryRaceHarness();
    const enteredA = deferred<void>();
    const enteredB = deferred<void>();
    const releaseA = deferred<ConfigurationRepositoryTransportOutcome>();
    const releaseB = deferred<ConfigurationRepositoryTransportOutcome>();
    let activeTransports = 0;
    let maxActiveTransports = 0;
    harness.transport.run = async (request: ConfigurationRepositoryTransportRequest) => {
      harness.calls.push(request);
      activeTransports += 1;
      maxActiveTransports = Math.max(maxActiveTransports, activeTransports);
      try {
        if (request.binding.repositoryPath === 'repo-a') {
          enteredA.resolve(undefined);
          return await releaseA.promise;
        }
        enteredB.resolve(undefined);
        return await releaseB.promise;
      } finally {
        activeTransports -= 1;
      }
    };

    const connectA = harness.service.connect(harness.targetA, harness.entryA, {
      repositoryPath: 'repo-a', repositoryUser: 'user-a', repositoryPassword: 'password-a',
      executionInfobaseId: harness.entryA.id,
    }, neverCancelled());
    await enteredA.promise;
    const connectB = harness.service.connect(harness.targetA, harness.entryB, {
      repositoryPath: 'repo-b', repositoryUser: 'user-b', repositoryPassword: 'password-b',
      executionInfobaseId: harness.entryB.id,
    }, neverCancelled());

    try {
      const bEnteredBeforeACompleted = await settlesWithin(enteredB.promise, 250);
      if (bEnteredBeforeACompleted) {
        releaseB.resolve(acknowledgedOutcome('bind'));
        await connectB;
      }

      releaseA.resolve({
        status: 'failed' as const,
        operation: 'bind' as const,
        errorCode: 'CONFIGURATOR_REPOSITORY_OPERATION_FAILED',
        message: 'repository A rejected the bind',
        retryable: false,
        log: '',
      });
      const resultA = await connectA;
      if (!bEnteredBeforeACompleted) {
        await enteredB.promise;
        releaseB.resolve(acknowledgedOutcome('bind'));
      }
      const resultB = await connectB;

      assert.strictEqual(resultA.status, 'failed');
      assert.strictEqual(resultB.status, 'acknowledged');
      assert.strictEqual(maxActiveTransports, 1, 'operations for one target must not reach Configurator concurrently');
      assert.deepStrictEqual(await harness.bindingStore.get(harness.targetA), {
        repositoryPath: 'repo-b', repositoryUser: 'user-b', executionInfobaseId: harness.entryB.id,
      });
      assert.strictEqual(await harness.secrets.get(harness.targetA), 'password-b');
      assert.strictEqual((await harness.stateStore.get(harness.targetA)).connection, 'connected');
    } finally {
      releaseA.resolve({
        status: 'failed' as const,
        operation: 'bind' as const,
        errorCode: 'CONFIGURATOR_REPOSITORY_OPERATION_FAILED',
        message: 'cleanup failure result',
        retryable: false,
        log: '',
      });
      releaseB.resolve(acknowledgedOutcome('bind'));
      await Promise.allSettled([connectA, connectB]);
      await harness.dispose();
    }
  });

  test('rebind to another IB serializes with disconnect and preserves the new binding owner', async () => {
    const harness = await createRepositoryRaceHarness();
    const disconnectEntered = deferred<void>();
    const rebindEntered = deferred<void>();
    const releaseDisconnect = deferred<ConfigurationRepositoryTransportOutcome>();
    const releaseRebind = deferred<ConfigurationRepositoryTransportOutcome>();
    let activeTransports = 0;
    let maxActiveTransports = 0;
    harness.transport.run = async (request: ConfigurationRepositoryTransportRequest) => {
      harness.calls.push(request);
      if (request.operation === 'bind' && request.binding.repositoryPath === 'repo-b') {
        activeTransports += 1;
        maxActiveTransports = Math.max(maxActiveTransports, activeTransports);
        try {
          rebindEntered.resolve(undefined);
          return await releaseRebind.promise;
        } finally {
          activeTransports -= 1;
        }
      }
      if (request.operation === 'unbind') {
        activeTransports += 1;
        maxActiveTransports = Math.max(maxActiveTransports, activeTransports);
        try {
          disconnectEntered.resolve(undefined);
          return await releaseDisconnect.promise;
        } finally {
          activeTransports -= 1;
        }
      }
      return acknowledgedOutcome(request.operation);
    };

    const pendingOperations: Promise<unknown>[] = [];
    try {
      const initial = await harness.service.connect(harness.targetA, harness.entryA, {
        repositoryPath: 'repo-a', repositoryUser: 'user-a', repositoryPassword: 'password-a',
        executionInfobaseId: harness.entryA.id,
      }, neverCancelled());
      assert.strictEqual(initial.status, 'acknowledged');

      const disconnect = harness.service.disconnect(harness.targetA, neverCancelled());
      pendingOperations.push(disconnect);
      await disconnectEntered.promise;
      const rebind = harness.service.connect(harness.targetA, harness.entryB, {
        repositoryPath: 'repo-b', repositoryUser: 'user-b', repositoryPassword: 'password-b',
        executionInfobaseId: harness.entryB.id,
      }, neverCancelled());
      pendingOperations.push(rebind);

      const rebindEnteredBeforeDisconnectCompleted = await settlesWithin(rebindEntered.promise, 250);
      if (rebindEnteredBeforeDisconnectCompleted) {
        releaseRebind.resolve(acknowledgedOutcome('bind'));
        await rebind;
      }

      releaseDisconnect.resolve(acknowledgedOutcome('unbind'));
      const disconnected = await disconnect;
      if (!rebindEnteredBeforeDisconnectCompleted) {
        await rebindEntered.promise;
        releaseRebind.resolve(acknowledgedOutcome('bind'));
      }
      const rebound = await rebind;

      assert.strictEqual(disconnected.status, 'acknowledged');
      assert.strictEqual(rebound.status, 'acknowledged');
      assert.strictEqual(maxActiveTransports, 1, 'disconnect and rebind for one target must be serialized across IB changes');
      assert.deepStrictEqual(await harness.bindingStore.get(harness.targetA), {
        repositoryPath: 'repo-b', repositoryUser: 'user-b', executionInfobaseId: harness.entryB.id,
      });
      assert.strictEqual(await harness.secrets.get(harness.targetA), 'password-b');
      assert.strictEqual((await harness.stateStore.get(harness.targetA)).connection, 'connected');
    } finally {
      releaseDisconnect.resolve(acknowledgedOutcome('unbind'));
      releaseRebind.resolve(acknowledgedOutcome('bind'));
      await Promise.allSettled(pendingOperations);
      await harness.dispose();
    }
  });

  test('disconnect resolved on IB-A cannot unbind a queued rebind on IB-B through the stale lease', async () => {
    const harness = await createRepositoryRaceHarness();
    const enteredA = deferred<void>();
    const enteredB = deferred<void>();
    const releaseA = deferred<ConfigurationRepositoryTransportOutcome>();
    const bLeaseRequested = deferred<void>();
    const bCandidateWriteStarted = deferred<void>();
    const releaseBCandidateWrite = deferred<void>();
    const disconnectResolvedInfobase = deferred<string>();
    const secondALeaseRequested = deferred<void>();
    const unbindRequests: ConfigurationRepositoryTransportRequest[] = [];
    const infobaseLookups: string[] = [];
    const infobaseAKey = (await resolveInfobaseCanonicalIdentity(harness.entryA)).canonicalTargetId;
    const infobaseBKey = (await resolveInfobaseCanonicalIdentity(harness.entryB)).canonicalTargetId;
    const originalRunComposite = harness.queue.runComposite.bind(harness.queue);
    const originalBindingSet = harness.bindingStore.set.bind(harness.bindingStore);
    const originalGetById = harness.storage.getById.bind(harness.storage);
    let physicalARequests = 0;

    harness.queue.runComposite = async <T>(
      identities: readonly InfobaseConfigurationQueueIdentity[],
      operation: (lease: InfobaseConfigurationOperationLease) => Promise<T>,
      cancellation?: InfobaseConfigurationQueueCancellation,
    ): Promise<T> => {
      const keys = identities.map(queueIdentityKey);
      if (keys.includes(infobaseBKey)) {
        bLeaseRequested.resolve(undefined);
      }
      if (keys.includes(infobaseAKey)) {
        physicalARequests += 1;
        if (physicalARequests === 2) {
          secondALeaseRequested.resolve(undefined);
        }
      }
      return originalRunComposite(identities, operation, cancellation);
    };
    harness.bindingStore.set = async (target: RepositoryTarget, binding: RepositoryBinding) => {
      if (target.configRoot === harness.targetA.configRoot && binding.executionInfobaseId === harness.entryB.id) {
        bCandidateWriteStarted.resolve(undefined);
        await releaseBCandidateWrite.promise;
      }
      return originalBindingSet(target, binding);
    };
    harness.storage.getById = async (id: string) => {
      infobaseLookups.push(id);
      if (id === harness.entryA.id) {
        disconnectResolvedInfobase.resolve(id);
      }
      return originalGetById(id);
    };
    harness.transport.run = async (request: ConfigurationRepositoryTransportRequest) => {
      harness.calls.push(request);
      if (request.operation === 'bind' && request.binding.repositoryPath === 'repo-a') {
        enteredA.resolve(undefined);
        return releaseA.promise;
      }
      if (request.operation === 'bind' && request.binding.repositoryPath === 'repo-b') {
        enteredB.resolve(undefined);
        return acknowledgedOutcome('bind');
      }
      if (request.operation === 'unbind') {
        unbindRequests.push(request);
      }
      return acknowledgedOutcome(request.operation);
    };

    let connectA: Promise<RepositoryServiceResult> | undefined;
    let connectB: Promise<RepositoryServiceResult> | undefined;
    let disconnect: Promise<RepositoryServiceResult> | undefined;
    try {
      connectA = harness.service.connect(harness.targetA, harness.entryA, {
        repositoryPath: 'repo-a', repositoryUser: 'user-a', repositoryPassword: 'password-a',
        executionInfobaseId: harness.entryA.id,
      }, neverCancelled());
      await enteredA.promise;

      connectB = harness.service.connect(harness.targetA, harness.entryB, {
        repositoryPath: 'repo-b', repositoryUser: 'user-b', repositoryPassword: 'password-b',
        executionInfobaseId: harness.entryB.id,
      }, neverCancelled());
      const bAdmissionObserved = await settlesWithin(
        Promise.race([bLeaseRequested.promise, bCandidateWriteStarted.promise]),
        250,
      );
      assert.strictEqual(bAdmissionObserved, true, 'rebind B must be queued or reach its guarded candidate write while A is active');

      disconnect = harness.service.disconnect(harness.targetA, neverCancelled());
      const disconnectResolvedInTime = await settlesWithin(disconnectResolvedInfobase.promise, 250);
      const resolvedInfobaseId = disconnectResolvedInTime ? await disconnectResolvedInfobase.promise : undefined;
      assert.strictEqual(resolvedInfobaseId, harness.entryA.id, 'disconnect must capture the old execution IB before acquiring its lease');
      assert.strictEqual((await harness.bindingStore.get(harness.targetA))?.executionInfobaseId, harness.entryA.id);
      const disconnectLeaseObserved = await settlesWithin(secondALeaseRequested.promise, 250);

      releaseBCandidateWrite.resolve(undefined);
      const bEnteredBeforeACompleted = await settlesWithin(enteredB.promise, 250);
      releaseA.resolve(acknowledgedOutcome('bind'));
      const resultA = await connectA;
      if (!bEnteredBeforeACompleted) {
        await enteredB.promise;
      }
      const resultB = await connectB;
      const disconnectResult = await disconnect;
      const staleUnbind = unbindRequests.find((request) =>
        request.infobase.id === harness.entryA.id
        && request.binding.executionInfobaseId === harness.entryB.id);

      assert.strictEqual(disconnectLeaseObserved, true, 'disconnect must request its lease after resolving the old execution IB');
      assert.strictEqual(resultA.status, 'acknowledged');
      assert.strictEqual(resultB.status, 'acknowledged');
      assert.strictEqual(staleUnbind, undefined, 'an IB-A lease must never execute unbind with the newer IB-B binding');

      if (disconnectResult.status === 'inDoubt') {
        assert.strictEqual(unbindRequests.length, 0, 'a stale disconnect conflict must be reported before transport');
        assert.deepStrictEqual(await harness.bindingStore.get(harness.targetA), {
          repositoryPath: 'repo-b', repositoryUser: 'user-b', executionInfobaseId: harness.entryB.id,
        });
        assert.strictEqual(await harness.secrets.get(harness.targetA), 'password-b');
        assert.strictEqual((await harness.stateStore.get(harness.targetA)).connection, 'connected');
      } else {
        assert.strictEqual(disconnectResult.status, 'acknowledged', 'disconnect may re-admit only after resolving IB-B');
        assert.strictEqual(unbindRequests.length, 1);
        assert.strictEqual(unbindRequests[0]?.infobase.id, harness.entryB.id);
        assert.strictEqual(unbindRequests[0]?.binding.executionInfobaseId, harness.entryB.id);
        assert.ok(infobaseLookups.includes(harness.entryB.id), 'a new admission must resolve the new execution IB');
        assert.strictEqual(await harness.bindingStore.get(harness.targetA), undefined);
        assert.strictEqual(await harness.secrets.get(harness.targetA), undefined);
      }
    } finally {
      releaseBCandidateWrite.resolve(undefined);
      releaseA.resolve(acknowledgedOutcome('bind'));
      harness.queue.runComposite = originalRunComposite;
      harness.bindingStore.set = originalBindingSet;
      harness.storage.getById = originalGetById;
      await Promise.allSettled([
        ...(connectA ? [connectA] : []),
        ...(connectB ? [connectB] : []),
        ...(disconnect ? [disconnect] : []),
      ]);
      await harness.dispose();
    }
  });

  test('different repository targets sharing one physical IB keep independent bindings and states', async () => {
    const harness = await createRepositoryRaceHarness();
    const enteredA = deferred<void>();
    const enteredB = deferred<void>();
    const releaseA = deferred<ConfigurationRepositoryTransportOutcome>();
    const releaseB = deferred<ConfigurationRepositoryTransportOutcome>();
    let activeTransports = 0;
    let maxActiveTransports = 0;
    harness.transport.run = async (request: ConfigurationRepositoryTransportRequest) => {
      harness.calls.push(request);
      activeTransports += 1;
      maxActiveTransports = Math.max(maxActiveTransports, activeTransports);
      try {
        if (request.target.key === harness.targetA.key) {
          enteredA.resolve(undefined);
          return await releaseA.promise;
        }
        enteredB.resolve(undefined);
        return await releaseB.promise;
      } finally {
        activeTransports -= 1;
      }
    };

    const connectA = harness.service.connect(harness.targetA, harness.entryA, {
      repositoryPath: 'repo-target-a', repositoryUser: 'user-a', repositoryPassword: 'password-a',
      executionInfobaseId: harness.entryA.id,
    }, neverCancelled());
    await enteredA.promise;
    const connectB = harness.service.connect(harness.targetB, harness.entryA, {
      repositoryPath: 'repo-target-b', repositoryUser: 'user-b', repositoryPassword: 'password-b',
      executionInfobaseId: harness.entryA.id,
    }, neverCancelled());

    try {
      const bEnteredBeforeACompleted = await settlesWithin(enteredB.promise, 250);
      releaseA.resolve(acknowledgedOutcome('bind'));
      const resultA = await connectA;
      if (!bEnteredBeforeACompleted) {
        await enteredB.promise;
      }
      releaseB.resolve(acknowledgedOutcome('bind'));
      const resultB = await connectB;

      assert.strictEqual(resultA.status, 'acknowledged');
      assert.strictEqual(resultB.status, 'acknowledged');
      assert.strictEqual(maxActiveTransports, 1, 'repository operations sharing a physical IB must be serialized');
      assert.notStrictEqual(harness.targetA.key, harness.targetB.key);
      assert.deepStrictEqual(await harness.bindingStore.get(harness.targetA), {
        repositoryPath: 'repo-target-a', repositoryUser: 'user-a', executionInfobaseId: harness.entryA.id,
      });
      assert.deepStrictEqual(await harness.bindingStore.get(harness.targetB), {
        repositoryPath: 'repo-target-b', repositoryUser: 'user-b', executionInfobaseId: harness.entryA.id,
      });
      assert.strictEqual(await harness.secrets.get(harness.targetA), 'password-a');
      assert.strictEqual(await harness.secrets.get(harness.targetB), 'password-b');
      assert.strictEqual((await harness.stateStore.get(harness.targetA)).connection, 'connected');
      assert.strictEqual((await harness.stateStore.get(harness.targetB)).connection, 'connected');
    } finally {
      releaseA.resolve(acknowledgedOutcome('bind'));
      releaseB.resolve(acknowledgedOutcome('bind'));
      await Promise.allSettled([connectA, connectB]);
      await harness.dispose();
    }
  });

  test('CF and CFE targets at one root retain distinct canonical queue identities', async () => {
    const harness = await createRepositoryRaceHarness();
    const cfeTarget = createRepositoryTarget(harness.targetA.configRoot, 'cfe', 'SalesExtension');
    const cfQueueKey = repositoryTargetMutationKey(harness.targetA);
    const cfeQueueKey = repositoryTargetMutationKey(cfeTarget);
    const enteredCf = deferred<void>();
    const enteredCfe = deferred<void>();
    const releaseCf = deferred<ConfigurationRepositoryTransportOutcome>();
    const releaseCfe = deferred<ConfigurationRepositoryTransportOutcome>();
    let activeTransports = 0;
    let maxActiveTransports = 0;
    harness.transport.run = async (request: ConfigurationRepositoryTransportRequest) => {
      harness.calls.push(request);
      activeTransports += 1;
      maxActiveTransports = Math.max(maxActiveTransports, activeTransports);
      try {
        if (request.target.configKind === 'cf') {
          enteredCf.resolve(undefined);
          return await releaseCf.promise;
        }
        enteredCfe.resolve(undefined);
        return await releaseCfe.promise;
      } finally {
        activeTransports -= 1;
      }
    };

    const connectCf = harness.service.connect(harness.targetA, harness.entryA, {
      repositoryPath: 'repo-cf', repositoryUser: 'cf-user', repositoryPassword: 'cf-secret',
      executionInfobaseId: harness.entryA.id,
    }, neverCancelled());
    await enteredCf.promise;
    const connectCfe = harness.service.connect(cfeTarget, harness.entryB, {
      repositoryPath: 'repo-cfe', repositoryUser: 'cfe-user', repositoryPassword: 'cfe-secret',
      executionInfobaseId: harness.entryB.id,
    }, neverCancelled());

    try {
      const cfeEnteredWhileCfActive = await settlesWithin(enteredCfe.promise, 250);
      releaseCf.resolve(acknowledgedOutcome('bind'));
      const resultCf = await connectCf;
      if (!cfeEnteredWhileCfActive) {
        await enteredCfe.promise;
      }
      releaseCfe.resolve(acknowledgedOutcome('bind'));
      const resultCfe = await connectCfe;

      assert.notStrictEqual(harness.targetA.key, cfeTarget.key);
      assert.notStrictEqual(cfQueueKey, cfeQueueKey);
      assert.notStrictEqual(cfQueueKey, harness.targetA.key, 'service queue identity must use the canonical target tuple');
      assert.strictEqual(cfeEnteredWhileCfActive, true, 'different CF/CFE targets on different IBs may run concurrently');
      assert.strictEqual(resultCf.status, 'acknowledged');
      assert.strictEqual(resultCfe.status, 'acknowledged');
      assert.strictEqual(maxActiveTransports, 2);
      assert.deepStrictEqual(await harness.bindingStore.get(harness.targetA), {
        repositoryPath: 'repo-cf', repositoryUser: 'cf-user', executionInfobaseId: harness.entryA.id,
      });
      assert.deepStrictEqual(await harness.bindingStore.get(cfeTarget), {
        repositoryPath: 'repo-cfe', repositoryUser: 'cfe-user', executionInfobaseId: harness.entryB.id,
      });
      assert.strictEqual(await harness.secrets.get(harness.targetA), 'cf-secret');
      assert.strictEqual(await harness.secrets.get(cfeTarget), 'cfe-secret');
      assert.strictEqual((await harness.stateStore.get(harness.targetA)).connection, 'connected');
      assert.strictEqual((await harness.stateStore.get(cfeTarget)).connection, 'connected');
    } finally {
      releaseCf.resolve(acknowledgedOutcome('bind'));
      releaseCfe.resolve(acknowledgedOutcome('bind'));
      await Promise.allSettled([connectCf, connectCfe]);
      await harness.dispose();
    }
  });

  test('cancelling a queued bind for the same target leaves the active owner and transport untouched', async () => {
    const harness = await createRepositoryRaceHarness();
    const enteredA = deferred<void>();
    const enteredB = deferred<void>();
    const releaseA = deferred<ConfigurationRepositoryTransportOutcome>();
    harness.transport.run = async (request: ConfigurationRepositoryTransportRequest) => {
      harness.calls.push(request);
      if (request.binding.repositoryPath === 'repo-a') {
        enteredA.resolve(undefined);
        return await releaseA.promise;
      }
      enteredB.resolve(undefined);
      return acknowledgedOutcome(request.operation);
    };

    const connectA = harness.service.connect(harness.targetA, harness.entryA, {
      repositoryPath: 'repo-a', repositoryUser: 'user-a', repositoryPassword: 'password-a',
      executionInfobaseId: harness.entryA.id,
    }, neverCancelled());
    await enteredA.promise;
    const cancellation = new vscode.CancellationTokenSource();
    const connectB = harness.service.connect(harness.targetA, harness.entryB, {
      repositoryPath: 'repo-b', repositoryUser: 'user-b', repositoryPassword: 'password-b',
      executionInfobaseId: harness.entryB.id,
    }, cancellation.token);

    try {
      const bEnteredBeforeCancellation = await settlesWithin(enteredB.promise, 250);
      cancellation.cancel();
      releaseA.resolve(acknowledgedOutcome('bind'));
      const resultA = await connectA;
      const resultB = await connectB;

      assert.strictEqual(bEnteredBeforeCancellation, false, 'the conflicting target lease must keep the bind queued until cancellation');
      assert.strictEqual(resultA.status, 'acknowledged');
      assert.strictEqual(resultB.status, 'cancelled');
      assert.strictEqual(harness.calls.some((request) => request.binding.repositoryPath === 'repo-b'), false);
      assert.deepStrictEqual(await harness.bindingStore.get(harness.targetA), {
        repositoryPath: 'repo-a', repositoryUser: 'user-a', executionInfobaseId: harness.entryA.id,
      });
      assert.strictEqual(await harness.secrets.get(harness.targetA), 'password-a');
      assert.strictEqual((await harness.stateStore.get(harness.targetA)).connection, 'connected');
    } finally {
      releaseA.resolve(acknowledgedOutcome('bind'));
      await Promise.allSettled([connectA, connectB]);
      cancellation.dispose();
      await harness.dispose();
    }
  });

  test('failed bind does not roll back an externally replaced binding, secret or state', async () => {
    const harness = await createRepositoryRaceHarness();
    const entered = deferred<void>();
    const release = deferred<ConfigurationRepositoryTransportOutcome>();
    harness.transport.run = async (request: ConfigurationRepositoryTransportRequest) => {
      harness.calls.push(request);
      entered.resolve(undefined);
      return await release.promise;
    };

    const operation = harness.service.connect(harness.targetA, harness.entryA, {
      repositoryPath: 'candidate-repository', repositoryUser: 'candidate-user', repositoryPassword: 'candidate-secret',
      executionInfobaseId: harness.entryA.id,
    }, neverCancelled());
    await entered.promise;
    const externalBinding = {
      repositoryPath: 'external-repository',
      repositoryUser: 'external-user',
      executionInfobaseId: harness.entryB.id,
    };
    const externalState = {
      connection: 'connected' as const,
      locks: { 'Справочник.External': 'heldByCurrentCredentials' as const },
      lastConfirmedAt: 'external-owner-state',
      source: 'configuratorAcknowledgement' as const,
    };

    try {
      await harness.bindingStore.set(harness.targetA, externalBinding);
      await harness.secrets.set(harness.targetA, 'external-secret');
      await harness.stateStore.set(harness.targetA, externalState);
      release.resolve({
        status: 'failed' as const,
        operation: 'bind' as const,
        errorCode: 'CONFIGURATOR_REPOSITORY_OPERATION_FAILED',
        message: 'candidate bind rejected',
        retryable: false,
        log: '',
      });
      const result = await operation;

      assert.strictEqual(result.status, 'inDoubt', 'changed candidate ownership must be reported as an unresolved local conflict');
      assert.deepStrictEqual(await harness.bindingStore.get(harness.targetA), externalBinding);
      assert.strictEqual(await harness.secrets.get(harness.targetA), 'external-secret');
      assert.deepStrictEqual(await harness.stateStore.get(harness.targetA), externalState);
      assert.strictEqual(result.message.includes('external-secret'), false, 'secret values must stay out of diagnostics');
    } finally {
      release.resolve({
        status: 'failed' as const,
        operation: 'bind' as const,
        errorCode: 'CONFIGURATOR_REPOSITORY_OPERATION_FAILED',
        message: 'cleanup failure result',
        retryable: false,
        log: '',
      });
      await Promise.allSettled([operation]);
      await harness.dispose();
    }
  });

  test('late bind acknowledgement does not replace state after an external candidate owner change', async () => {
    const harness = await createRepositoryRaceHarness();
    const entered = deferred<void>();
    const release = deferred<ConfigurationRepositoryTransportOutcome>();
    harness.transport.run = async (request: ConfigurationRepositoryTransportRequest) => {
      harness.calls.push(request);
      entered.resolve(undefined);
      return await release.promise;
    };

    const operation = harness.service.connect(harness.targetA, harness.entryA, {
      repositoryPath: 'candidate-repository', repositoryUser: 'candidate-user', repositoryPassword: 'candidate-secret',
      executionInfobaseId: harness.entryA.id,
    }, neverCancelled());
    await entered.promise;
    const externalBinding = {
      repositoryPath: 'external-repository',
      repositoryUser: 'external-user',
      executionInfobaseId: harness.entryB.id,
    };
    const externalState = {
      connection: 'disconnected' as const,
      locks: { 'Справочник.External': 'unknown' as const },
      lastConfirmedAt: 'external-owner-state',
      source: 'unknown' as const,
    };

    try {
      await harness.bindingStore.set(harness.targetA, externalBinding);
      await harness.secrets.set(harness.targetA, 'external-secret');
      await harness.stateStore.set(harness.targetA, externalState);
      release.resolve(acknowledgedOutcome('bind'));
      const result = await operation;

      assert.strictEqual(result.status, 'inDoubt', 'late ACK cannot certify a candidate that no longer owns the target');
      assert.deepStrictEqual(await harness.bindingStore.get(harness.targetA), externalBinding);
      assert.strictEqual(await harness.secrets.get(harness.targetA), 'external-secret');
      assert.deepStrictEqual(await harness.stateStore.get(harness.targetA), externalState);
      assert.strictEqual(result.message.includes('external-secret'), false, 'secret values must stay out of diagnostics');
    } finally {
      release.resolve(acknowledgedOutcome('bind'));
      await Promise.allSettled([operation]);
      await harness.dispose();
    }
  });

  test('repository commit preserves typed inDoubt receipt from its pre-commit import', async () => {
    const termination = {
      terminated: false,
      hardKillUsed: true,
      survivingPids: [8831],
      errors: ['tree stop not confirmed'],
    };
    const harness = await createServiceHarness(
      () => acknowledgedOutcome('bind'),
      undefined,
      {
        importFiles: async (): Promise<IbcmdInfobaseOperationResult> => ({
          status: 'inDoubt',
          exitCode: null,
          userMessage: 'Import result is uncertain.',
          logExcerpt: '',
          effectPossible: true,
          termination,
        }),
      },
    );
    try {
      await harness.service.connect(harness.target, harness.entry, {
        repositoryPath: 'repo',
        repositoryUser: 'u',
        executionInfobaseId: harness.entry.id,
      }, neverCancelled());
      harness.calls.length = 0;

      const result = await harness.service.commit(harness.catalog, neverCancelled());

      assert.strictEqual(result.status, 'inDoubt');
      assert.strictEqual(result.effectPossible, true);
      assert.deepStrictEqual(result.termination, termination);
      assert.strictEqual(harness.calls.length, 0, 'repository transport must not run after an uncertain import');
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
    const reloadRequests: Array<{ configRoot: string; reason: ReloadReason }> = [];
    const coordinator = new ReloadCoordinatorService(async ({ configPath, reason }) => {
      reloadRequests.push({ configRoot: configPath, reason });
      throw Object.assign(new Error('reload failed'), { code: 'CONFIGURATION_PARSE_FAILED' });
    }, { defaultDebounceMs: 0 });
    const harness = await createServiceHarness(
      (operation) => acknowledgedOutcome(operation as 'bind' | 'lock'),
      createRequestConfigurationReload({ reloadCoordinator: coordinator }),
    );
    try {
      const connected = await harness.service.connect(harness.target, harness.entry, {
        repositoryPath: 'repo', repositoryUser: 'u', repositoryPassword: 'secret', executionInfobaseId: harness.entry.id,
      }, neverCancelled());
      assert.strictEqual(connected.status, 'acknowledged');
      const result = await harness.service.lock(harness.catalog, neverCancelled());
      assert.strictEqual(result.status, 'inDoubt');
      assert.deepStrictEqual(reloadRequests, [{ configRoot: harness.target.configRoot, reason: 'repository' }]);
      assert.strictEqual(harness.queue.getQuarantines([await resolveInfobaseCanonicalIdentity(harness.entry)]).length, 0);
      assert.strictEqual((await harness.stateStore.get(harness.target)).connection, 'unknown');
    } finally {
      await harness.dispose();
      await coordinator.dispose();
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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function createRepositoryRaceHarness() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-repository-race-'));
  const configRootA = path.join(rootPath, 'config-a');
  const configRootB = path.join(rootPath, 'config-b');
  const targetA = createRepositoryTarget(configRootA);
  const targetB = createRepositoryTarget(configRootB);
  const entryA = { ...infobase(path.join(rootPath, 'ib-a', '1Cv8.1CD')), id: 'race-ib-a', name: 'Race IB A' };
  const entryB = { ...infobase(path.join(rootPath, 'ib-b', '1Cv8.1CD')), id: 'race-ib-b', name: 'Race IB B' };
  await Promise.all([
    fs.mkdir(configRootA, { recursive: true }),
    fs.mkdir(configRootB, { recursive: true }),
    fs.mkdir(path.dirname(entryA.filePath), { recursive: true }),
    fs.mkdir(path.dirname(entryB.filePath), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(entryA.filePath, '', 'utf8'),
    fs.writeFile(entryB.filePath, '', 'utf8'),
  ]);

  const bindingStore = new RepositoryBindingStore(path.join(rootPath, 'bindings.json'));
  const stateStore = new RepositoryStateStore(path.join(rootPath, 'state.json'));
  const secretValues = new Map<string, string>();
  const secretStore = {
    get: async (target: RepositoryTarget) => secretValues.get(target.key),
    set: async (target: RepositoryTarget, value: string) => { secretValues.set(target.key, value); },
    delete: async (target: RepositoryTarget) => { secretValues.delete(target.key); },
  };
  const entries = new Map([[entryA.id, entryA], [entryB.id, entryB]]);
  const calls: ConfigurationRepositoryTransportRequest[] = [];
  const transport: {
    run(request: ConfigurationRepositoryTransportRequest): Promise<ConfigurationRepositoryTransportOutcome>;
  } = {
    run: async (request: ConfigurationRepositoryTransportRequest) => {
      calls.push(request);
      return acknowledgedOutcome(request.operation);
    },
  };
  const storage = {
    getById: async (id: string) => entries.get(id),
    readPasswordSecret: async () => undefined,
  };
  const queue = new InfobaseConfigurationOperationQueue();
  const service = new ConfigurationRepositoryService({
    bindingStore,
    secretStore: secretStore as any,
    stateStore,
    infobaseStorage: storage as any,
    transport: transport as unknown as ConfigurationRepositoryTransport,
    queue,
    requestConfigurationReload: async () => undefined,
  });

  return {
    rootPath,
    targetA,
    targetB,
    entryA,
    entryB,
    bindingStore,
    stateStore,
    storage,
    secrets: {
      get: async (target: RepositoryTarget) => secretValues.get(target.key),
      set: async (target: RepositoryTarget, value: string) => { secretValues.set(target.key, value); },
      delete: async (target: RepositoryTarget) => { secretValues.delete(target.key); },
    },
    transport,
    calls,
    queue,
    service,
    dispose: async () => fs.rm(rootPath, { recursive: true, force: true }),
  };
}

function createRepositoryTarget(
  configRoot: string,
  configKind: 'cf' | 'cfe' = 'cf',
  extensionName?: string,
): RepositoryTarget {
  return {
    configRoot,
    configKind,
    ...(extensionName ? { extensionName } : {}),
    key: repositoryTargetKey({ configRoot, configKind, extensionName }),
  };
}

function queueIdentityKey(identity: InfobaseConfigurationQueueIdentity): string {
  return typeof identity === 'string' ? identity : identity.canonicalTargetId;
}

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

function acknowledgedOutcome(
  operation: 'bind' | 'lock' | 'unlock' | 'commit' | 'unbind' | 'updateObject' | 'updateConfiguration',
): ConfigurationRepositoryTransportOutcome {
  return { status: 'acknowledged' as const, operation, log: '' };
}

async function createServiceHarness(
  outcome: (operation: string) => unknown,
  requestConfigurationReload: (configRoot: string, reason: ReloadReason) => Promise<void> = async () => undefined,
  extraDeps: Partial<Pick<ConfigurationRepositoryServiceDeps, 'importFiles' | 'exportObjects' | 'exportConfiguration'>> = {},
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
    requestConfigurationReload,
    ...extraDeps,
  });
  return {
    rootPath,
    target,
    entry,
    catalog,
    service,
    bindingStore,
    stateStore,
    secrets: {
      get: async (key: string) => secretValues.get(key),
      set: async (key: string, value: string) => { secretValues.set(key, value); },
      delete: async (key: string) => { secretValues.delete(key); },
    },
    transport,
    calls,
    get objectXml() { return objectXml; },
    set objectXml(value: string) { objectXml = value; },
    queue,
    dispose: async () => fs.rm(rootPath, { recursive: true, force: true }),
  };
}
