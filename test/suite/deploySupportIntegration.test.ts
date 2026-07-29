import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import {
  DeployService,
  type DeploySupportContext,
} from '../../src/bindings/deployService';
import {
  checkRecentDeploy,
  resetDeployDedupCacheForTests,
} from '../../src/bindings/deployDedupCache';
import type { ConfigurationBinding } from '../../src/bindings/models/configurationBinding';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import type { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';
import { resolveInfobaseCanonicalIdentity } from '../../src/infobases/infobaseCanonicalIdentity';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import {
  getIbcmdService,
  resetIbcmdServiceSingletonForTests,
} from '../../src/services/ibcmd/ibcmdServiceSingleton';
import type { IbcmdInfobaseOperationResult } from '../../src/services/ibcmd/ibcmdInfobaseOperationResult';
import type { IncrementalImportParams } from '../../src/infobases/infobaseConfigCommands';
import type { ConfigurationId } from '../../src/services/configurationSession/types';
import type { SupportApplicationFacade } from '../../src/support/supportApplicationServiceRegistry';
import type {
  MasterSupportSnapshot,
  SupportStatusResult,
} from '../../src/support/supportTypes';
import {
  resetVscodeTestState,
  vscodeTestState,
} from '../helpers/vscodeModuleStub';

suite('DeployService support invariants', () => {
  const configurationId = 'cfg-deploy-support' as ConfigurationId;
  let work: string;
  let configRoot: string;
  let entry: InfobaseEntry;
  let binding: ConfigurationBinding;

  setup(() => {
    resetVscodeTestState();
    resetDeployDedupCacheForTests();
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'cdt-deploy-support-'));
    configRoot = path.join(work, 'cfg');
    fs.mkdirSync(path.join(configRoot, 'CommonModules'), { recursive: true });
    fs.mkdirSync(path.join(configRoot, 'Ext'), { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'Configuration.xml'), '<Configuration/>');
    fs.writeFileSync(path.join(configRoot, 'CommonModules', 'Foo.xml'), '<CommonModule/>');
    fs.writeFileSync(path.join(configRoot, 'CommonModules', 'Bar.xml'), '<CommonModule/>');
    fs.writeFileSync(path.join(configRoot, 'Ext', 'ParentConfigurations.bin'), 'support');
    const databasePath = path.join(work, '1Cv8.1CD');
    fs.writeFileSync(databasePath, '');
    entry = {
      id: 'ib-1',
      name: 'Base',
      type: 'file',
      filePath: databasePath,
      hasStoredPassword: false,
      createdAt: '2026-07-29T00:00:00.000Z',
    };
    binding = {
      workspaceFolder: 'ws',
      configRelativePath: 'Configuration.xml',
      infobaseIds: [entry.id],
      massDeployment: false,
    };
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    resetIbcmdServiceSingletonForTests();
  });

  teardown(() => {
    resetIbcmdServiceSingletonForTests();
    resetDeployDedupCacheForTests();
    resetVscodeTestState();
    fs.rmSync(work, { recursive: true, force: true });
  });

  test('generation drift after planning fails closed before ibcmd', async () => {
    let statusCalls = 0;
    let masterStatusCalls = 0;
    let importCalls = 0;
    const plannedStatus = readyStatus('generation-1');
    const support = supportContext({
      getStatus: async () => {
        statusCalls += 1;
        return plannedStatus;
      },
      getMasterStatus: async () => {
        masterStatusCalls += 1;
        return {
          status: 'available',
          master: readyStatus('generation-2').master,
        };
      },
    });
    const service = serviceWithImport(async () => {
      importCalls += 1;
      return success();
    });

    const summary = await service.deploySelectedObjects(params(
      [node('CommonModules/Foo.xml')],
      support,
    ));

    assert.strictEqual(statusCalls, 1);
    assert.strictEqual(masterStatusCalls, 1);
    assert.strictEqual(importCalls, 0);
    assert.strictEqual(summary.errorCount, 1);
    assert.strictEqual(summary.results[0]?.errorCode, 'SUPPORT_OPERATION_FAILED');
  });

  test('managed full deploy is rejected before ibcmd resolve or spawn', async () => {
    const status = readyStatus('generation-full');
    let statusCalls = 0;
    let masterStatusCalls = 0;
    let resolveCalls = 0;
    let runCalls = 0;
    const support = supportContext({
      getStatus: async () => {
        statusCalls += 1;
        return status;
      },
      getMasterStatus: async () => {
        masterStatusCalls += 1;
        return { status: 'available', master: status.master };
      },
    });
    const ibcmd = getIbcmdService();
    ibcmd.resolveExecutablePathAsync = async () => {
      resolveCalls += 1;
      throw new Error('ibcmd resolve must not be called');
    };
    ibcmd.run = async () => {
      runCalls += 1;
      throw new Error('ibcmd spawn must not be called');
    };

    const summary = await new DeployService().deployBinding(bindingParams(support));

    assert.strictEqual(statusCalls, 1);
    assert.strictEqual(masterStatusCalls, 0);
    assert.strictEqual(resolveCalls, 0);
    assert.strictEqual(runCalls, 0);
    assert.strictEqual(summary.errorCount, 1);
    assert.strictEqual(
      summary.results[0]?.errorCode,
      'SUPPORT_MANAGED_FULL_DEPLOY_UNSAFE',
    );
  });

  test('unmanaged full deploy continues to ibcmd resolution', async () => {
    let resolveCalls = 0;
    const support = supportContext({
      getStatus: async () => unmanagedStatus('missing'),
      getMasterStatus: async () => ({
        status: 'available',
        master: unmanagedStatus('missing').master,
      }),
    });
    const ibcmd = getIbcmdService();
    ibcmd.resolveExecutablePathAsync = async () => {
      resolveCalls += 1;
      return { kind: 'notFound', hint: 'test not found' };
    };

    const summary = await new DeployService().deployBinding(bindingParams(support));

    assert.strictEqual(resolveCalls, 1);
    assert.strictEqual(summary.errorCount, 1);
    assert.notStrictEqual(
      summary.results[0]?.errorCode,
      'SUPPORT_MANAGED_FULL_DEPLOY_UNSAFE',
    );
  });

  test('ParentConfigurations is routed through one-target support sync and never imported', async () => {
    const identity = await resolveInfobaseCanonicalIdentity(entry);
    const syncRequests: unknown[] = [];
    let importCalls = 0;
    const status = readyStatus('generation-route');
    const support = supportContext({
      getStatus: async () => status,
      getMasterStatus: async () => ({
        status: 'available',
        master: status.master,
      }),
      sync: async (request) => {
        syncRequests.push(request);
        return synchronized(status.master.kind === 'ready' ? status.master.snapshot : neverSnapshot(), identity.canonicalTargetId);
      },
    });
    const service = serviceWithImport(async () => {
      importCalls += 1;
      return success();
    });

    const summary = await service.deploySelectedObjects(params(
      [node('Ext/ParentConfigurations.bin')],
      support,
    ));

    assert.strictEqual(importCalls, 0);
    assert.deepStrictEqual(syncRequests, [{
      configurationId,
      targets: { kind: 'ids', targetIds: [identity.canonicalTargetId] },
      verification: 'fast',
    }]);
    assert.strictEqual(summary.skippedCount, 1);
    assert.strictEqual(summary.hasPartial, false);
  });

  test('same physical target is serialized and deduplicated under the shared lease', async () => {
    let imports = 0;
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let notifyEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve;
    });
    const service = serviceWithImport(async () => {
      imports += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      notifyEntered();
      await firstEntered;
      active -= 1;
      return success();
    });

    const first = service.deploySelectedObjects(params([node('CommonModules/Foo.xml')]));
    await entered;
    const second = service.deploySelectedObjects(params([node('CommonModules/Foo.xml')]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(imports, 1, 'second operation must wait for the canonical target lease');
    releaseFirst();
    const [firstSummary, secondSummary] = await Promise.all([first, second]);

    assert.strictEqual(imports, 1);
    assert.strictEqual(maxActive, 1);
    assert.strictEqual(firstSummary.successCount, 1);
    assert.strictEqual(secondSummary.skippedCount, 1);
  });

  test('reactive lock is sticky, reports concrete skips and never falls into Configuration retry', async () => {
    const calls: string[][] = [];
    const service = serviceWithImport(async (request) => {
      calls.push([...request.relativeFiles]);
      return calls.length === 1
        ? locked('Foo')
        : {
            status: 'error',
            exitCode: 1,
            userMessage: 'ordinary second failure',
            logExcerpt: 'ordinary second failure',
          };
    });

    const summary = await service.deploySelectedObjects(params([
      node('CommonModules/Foo.xml'),
      node('CommonModules/Bar.xml'),
    ]));

    assert.strictEqual(calls.length, 2);
    assert.ok(calls[1]!.every((file) => !file.includes('Foo')));
    assert.ok(calls.every((files) => !files.includes('Configuration.xml')));
    assert.strictEqual(summary.errorCount, 1);
    assert.strictEqual(summary.hasPartial, true);
    assert.deepStrictEqual(summary.results[0]?.skippedFiles, ['CommonModules/Foo.xml']);
  });

  test('Configuration fallback replans support and records only the files actually imported', async () => {
    const identity = await resolveInfobaseCanonicalIdentity(entry);
    const status = readyStatus('generation-fallback', identity.canonicalTargetId);
    const support = supportContext({
      getStatus: async () => status,
      getMasterStatus: async () => ({
        status: 'available',
        master: status.master,
      }),
    });
    const calls: string[][] = [];
    vscodeTestState.informationMessageResult = 'Повторить с Configuration.xml';
    const service = serviceWithImport(async (request) => {
      calls.push([...request.relativeFiles]);
      return calls.length === 1
        ? {
            status: 'error',
            exitCode: 1,
            userMessage: 'structural failure',
            logExcerpt: 'structural failure',
          }
        : success();
    });

    const summary = await service.deploySelectedObjects(params(
      [node('CommonModules/Foo.xml')],
      support,
    ));

    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[1], ['Configuration.xml', 'CommonModules/Foo.xml']);
    assert.strictEqual(summary.successCount, 1);
    assert.strictEqual(summary.hasPartial, false);
    const bindingId = path.resolve(configRoot, binding.configRelativePath).toLowerCase();
    assert.strictEqual(checkRecentDeploy(
      { bindingId, infobaseId: entry.id },
      { relativeFiles: calls[1]! },
      Date.now(),
    ).isDuplicate, true);
    assert.strictEqual(checkRecentDeploy(
      { bindingId, infobaseId: entry.id },
      { relativeFiles: calls[0]! },
      Date.now(),
    ).isDuplicate, false);
  });

  test('missing expected preflight fails closed before master CAS or import', async () => {
    let supportReads = 0;
    let masterStatusCalls = 0;
    let importCalls = 0;
    const support = supportContext({
      getMasterStatus: async () => {
        masterStatusCalls += 1;
        return {
          status: 'available',
          master: readyStatus('generation-missing').master,
        };
      },
    });
    const request = params([node('CommonModules/Foo.xml')]);
    Object.defineProperty(request, 'support', {
      configurable: true,
      get: () => {
        supportReads += 1;
        return supportReads === 1 ? undefined : support;
      },
    });
    const service = serviceWithImport(async () => {
      importCalls += 1;
      return success();
    });

    const summary = await service.deploySelectedObjects(request);

    assert.ok(supportReads >= 2);
    assert.strictEqual(masterStatusCalls, 0);
    assert.strictEqual(importCalls, 0);
    assert.strictEqual(summary.errorCount, 1);
    assert.strictEqual(summary.results[0]?.errorCode, 'SUPPORT_OPERATION_FAILED');
  });

  test('multi-target deploy plans universe once and uses master-only CAS immediately before each import', async () => {
    const secondDatabasePath = path.join(work, 'second.1Cv8.1CD');
    fs.writeFileSync(secondDatabasePath, '');
    const secondEntry: InfobaseEntry = {
      ...entry,
      id: 'ib-2',
      name: 'Base 2',
      filePath: secondDatabasePath,
    };
    const firstIdentity = await resolveInfobaseCanonicalIdentity(entry);
    const secondIdentity = await resolveInfobaseCanonicalIdentity(secondEntry);
    const status = readyStatus('generation-multi', [
      firstIdentity.canonicalTargetId,
      secondIdentity.canonicalTargetId,
    ]);
    const events: string[] = [];
    let getStatusCalls = 0;
    let getMasterStatusCalls = 0;
    let syncCalls = 0;
    const support = supportContext({
      getStatus: async () => {
        getStatusCalls += 1;
        events.push('getStatus');
        return status;
      },
      getMasterStatus: async () => {
        getMasterStatusCalls += 1;
        events.push('getMasterStatus');
        return { status: 'available', master: status.master };
      },
      sync: async () => {
        syncCalls += 1;
        throw new Error('acknowledged targets must not be synchronized again');
      },
    });
    const service = serviceWithImport(async (request) => {
      events.push(`import:${request.entry.id}`);
      return success();
    });
    const multiBinding: ConfigurationBinding = {
      ...binding,
      infobaseIds: [entry.id, secondEntry.id],
      massDeployment: true,
    };

    const summary = await service.deploySelectedObjects(params(
      [node('CommonModules/Foo.xml')],
      support,
      [entry, secondEntry],
      multiBinding,
    ));

    assert.strictEqual(summary.successCount, 2);
    assert.strictEqual(getStatusCalls, 1, 'metadata universe must be planned once');
    assert.strictEqual(getMasterStatusCalls, 2, 'each target keeps an exact master CAS');
    assert.strictEqual(syncCalls, 0);
    assert.deepStrictEqual(events, [
      'getStatus',
      'getMasterStatus',
      `import:${entry.id}`,
      'getMasterStatus',
      `import:${secondEntry.id}`,
    ]);
  });

  function params(
    selectedNodes: readonly TreeNode[],
    support?: DeploySupportContext,
    catalog: readonly InfobaseEntry[] = [entry],
    targetBinding: ConfigurationBinding = binding,
  ): Parameters<DeployService['deploySelectedObjects']>[0] {
    return {
      binding: targetBinding,
      workspaceFolderRoot: configRoot,
      storage: {
        readPasswordSecret: async () => undefined,
      } as unknown as InfobaseStorageService,
      catalog,
      selectedNodes,
      progress: { report: () => undefined },
      token: {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => undefined }),
      },
      support,
    };
  }

  function bindingParams(
    support: DeploySupportContext,
  ): Parameters<DeployService['deployBinding']>[0] {
    return {
      binding,
      workspaceFolderRoot: configRoot,
      storage: {
        readPasswordSecret: async () => undefined,
      } as unknown as InfobaseStorageService,
      catalog: [entry],
      progress: { report: () => undefined },
      token: {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => undefined }),
      },
      support,
    };
  }

  function node(relativePath: string): TreeNode {
    return {
      id: relativePath,
      name: path.basename(relativePath, path.extname(relativePath)),
      type: relativePath.startsWith('CommonModules/')
        ? MetadataType.CommonModule
        : MetadataType.Unknown,
      properties: {},
      filePath: path.join(configRoot, ...relativePath.split('/')),
    };
  }

  function supportContext(
    partial: Partial<Pick<SupportApplicationFacade, 'getStatus' | 'getMasterStatus' | 'sync'>>,
  ): DeploySupportContext {
    return {
      configurationId,
      facade: {
        getStatus: partial.getStatus ?? (async () => readyStatus('generation-default')),
        getMasterStatus: partial.getMasterStatus ?? (async () => ({
          status: 'available',
          master: readyStatus('generation-default').master,
        })),
        sync: partial.sync ?? (async () => {
          throw new Error('unexpected sync');
        }),
      },
    };
  }
});

function serviceWithImport(
  runIncrementalImport: (params: IncrementalImportParams) => Promise<IbcmdInfobaseOperationResult>,
): DeployService {
  return new DeployService({ runIncrementalImport });
}

function readyStatus(
  generationId: string,
  acknowledgedTargetIds?: string | readonly string[],
): SupportStatusResult {
  const configurationId = 'cfg-deploy-support' as ConfigurationId;
  const master = snapshot(configurationId, generationId);
  return {
    status: 'available',
    master: { kind: 'ready', snapshot: master },
    metadataUniverse: {
      configRoot: path.resolve('configuration'),
      metadataUniverseGenerationId: 'universe-deploy',
      entries: [],
    },
    ...(acknowledgedTargetIds === undefined
      ? {}
      : {
          lastRun: {
            runId: 'prior-run',
            operation: 'sync',
            configurationId,
            scope: 'replicated',
            desiredGenerationId: generationId,
            state: 'complete',
            startedAt: '2026-07-29T00:00:00.000Z',
            completedAt: '2026-07-29T00:00:01.000Z',
            targets: (
              typeof acknowledgedTargetIds === 'string'
                ? [acknowledgedTargetIds]
                : acknowledgedTargetIds
            ).map((canonicalTargetId, index) => ({
              canonicalTargetId,
              infobaseIds: [`ib-${index + 1}`],
              desiredGenerationId: generationId,
              state: 'applied' as const,
              acknowledgedGenerationId: generationId,
              evidence: 'configuratorAck' as const,
            })),
          },
        }),
  } as SupportStatusResult;
}

function unmanagedStatus(
  reason: 'missing' | 'empty',
): SupportStatusResult {
  const configurationId = 'cfg-deploy-support' as ConfigurationId;
  return {
    status: 'available',
    master: {
      kind: 'unmanaged',
      reason,
      configurationId,
      expectedFilePath: path.resolve('Ext', 'ParentConfigurations.bin'),
    },
  };
}

function snapshot(
  configurationId: ConfigurationId,
  generationId: string,
): MasterSupportSnapshot {
  return {
    configurationId,
    generationId,
    semanticDigest: 'a'.repeat(64),
    filePath: path.resolve('Ext', 'ParentConfigurations.bin'),
    formatRevision: '6',
    globalEditability: 'enabled',
    configurationMode: 'editable',
    objectModes: new Map(),
    supplierConfigurations: [],
  };
}

function synchronized(
  master: MasterSupportSnapshot,
  canonicalTargetId: string,
): Awaited<ReturnType<SupportApplicationFacade['sync']>> {
  return {
    status: 'synchronized',
    master,
    preflight: {
      accepted: true,
      scope: 'replicated',
      targets: [{
        canonicalTargetId,
        infobaseIds: ['ib-1'],
        state: 'ready',
      }],
    },
    run: {
      runId: 'route-run',
      operation: 'sync',
      configurationId: master.configurationId,
      scope: 'replicated',
      desiredGenerationId: master.generationId,
      state: 'complete',
      startedAt: '2026-07-29T00:00:00.000Z',
      completedAt: '2026-07-29T00:00:01.000Z',
      targets: [{
        canonicalTargetId,
        infobaseIds: ['ib-1'],
        desiredGenerationId: master.generationId,
        state: 'applied',
        acknowledgedGenerationId: master.generationId,
        evidence: 'configuratorAck',
      }],
    },
  } as Awaited<ReturnType<SupportApplicationFacade['sync']>>;
}

function neverSnapshot(): MasterSupportSnapshot {
  throw new Error('unreachable');
}

function success(): IbcmdInfobaseOperationResult {
  return {
    status: 'success',
    exitCode: 0,
    userMessage: 'success',
    logExcerpt: '',
  };
}

function locked(objectName: string): IbcmdInfobaseOperationResult {
  return {
    status: 'error',
    exitCode: 1,
    userMessage: 'locked',
    logExcerpt: `locked ${objectName}`,
    lockedObjects: [{
      kind: 'CommonModule',
      name: objectName,
      fullName: `CommonModule.${objectName}`,
    }],
  };
}
