import * as assert from 'assert';
import * as path from 'path';
import type { ConfigurationId } from '../../src/services/configurationSession/types';
import {
  createSupportStateCacheFacade,
  SupportStateCache,
  type CachedSupportStatus,
} from '../../src/support/supportStateCache';
import {
  SUPPORT_MASTER_WATCH_GLOB,
  SupportStateWatcher,
  type SupportFileSystemWatcher,
  type SupportWatcherDisposable,
  type SupportWatcherUri,
} from '../../src/support/supportStateWatcher';
import { SupportRootRegistrationLifecycle } from '../../src/support/supportRootRegistrationLifecycle';
import type { SupportConfigurationRegistration } from '../../src/support/supportApplicationServiceRegistry';
import type { SupportStatusResult } from '../../src/support/supportTypes';

suite('Support state cache/watcher/root lifecycle', () => {
  test('cache deduplicates in-flight reads and stale completion cannot republish after invalidation', async () => {
    const first = deferred<SupportStatusResult>();
    const second = deferred<SupportStatusResult>();
    let calls = 0;
    const cache = new SupportStateCache({
      getStatus: async () => (++calls === 1 ? first.promise : second.promise),
    });
    const root = path.resolve('cache-root');
    const configurationId = 'cfg-cache' as ConfigurationId;
    cache.register(root, configurationId);

    const loadA = cache.load(root);
    const loadB = cache.load(root);
    assert.strictEqual(calls, 1);
    cache.invalidate(root);
    const loadC = cache.load(root);
    assert.strictEqual(calls, 2);

    first.resolve(status(configurationId, 'old'));
    const stale = await loadA;
    assert.strictEqual(await loadB, stale);
    assert.strictEqual(stale.generationId, 'old');
    assert.strictEqual(cache.get(root), undefined);

    second.resolve(status(configurationId, 'new'));
    const current = await loadC;
    assert.strictEqual(current.generationId, 'new');
    assert.strictEqual(cache.get(root), current);
    assert.strictEqual(cache.get(root, 'old'), undefined);
    assert.strictEqual(cache.get(root, 'new'), current);
  });

  test('cache registration identity replacement fences the previous load', async () => {
    const pending = deferred<SupportStatusResult>();
    const cache = new SupportStateCache({
      getStatus: async (request) =>
        request.configurationId === ('cfg-a' as ConfigurationId)
          ? pending.promise
          : status(request.configurationId, 'b'),
    });
    const root = path.resolve('identity-root');
    cache.register(root, 'cfg-a' as ConfigurationId);
    const oldLoad = cache.load(root);
    cache.register(root, 'cfg-b' as ConfigurationId);
    const current = await cache.load(root);
    pending.resolve(status('cfg-a' as ConfigurationId, 'a'));
    await oldLoad;

    assert.strictEqual(current.configurationId, 'cfg-b');
    assert.strictEqual(cache.get(root)?.configurationId, 'cfg-b');
  });

  test('watcher reloads only the exact affected root and drops stale callbacks', async () => {
    const fake = new FakeWatcher();
    const first = deferred<SupportStatusResult>();
    const second = deferred<SupportStatusResult>();
    let calls = 0;
    const cache = new SupportStateCache({
      getStatus: async () => (++calls === 1 ? first.promise : second.promise),
    });
    const reloads: Array<{ root: string; generation: string | undefined }> = [];
    const watcher = new SupportStateWatcher(
      { createFileSystemWatcher: (glob) => {
        assert.strictEqual(glob, SUPPORT_MASTER_WATCH_GLOB);
        return fake;
      } },
      cache,
      {
        onDidReload: (root, value) => {
          reloads.push({ root, generation: value.generationId });
        },
      },
    );
    const rootA = path.resolve('watch-a');
    const rootB = path.resolve('watch-b');
    const regA = watcher.register(rootA, 'cfg-a' as ConfigurationId);
    watcher.register(rootB, 'cfg-b' as ConfigurationId);

    fake.change(path.join(rootA, 'Ext', 'ParentConfigurations.bin'));
    fake.change(path.join(rootB, 'Ext', 'other.bin'));
    await tick();
    assert.strictEqual(calls, 1);
    fake.change(path.join(rootA, 'Ext', 'ParentConfigurations.bin'));
    first.resolve(status('cfg-a' as ConfigurationId, 'stale'));
    await tick();
    second.resolve(status('cfg-a' as ConfigurationId, 'fresh'));
    await tick();
    await tick();

    assert.deepStrictEqual(reloads, [{ root: rootA, generation: 'fresh' }]);
    regA.dispose();
    fake.change(path.join(rootA, 'Ext', 'ParentConfigurations.bin'));
    await tick();
    assert.strictEqual(calls, 2);
    watcher.dispose();
    assert.strictEqual(fake.disposed, true);
  });

  test('root lifecycle rejects stale async snapshots and tears down exact registrations', async () => {
    const first = deferred<readonly SupportConfigurationRegistration[]>();
    const calls: string[] = [];
    let resolveCall = 0;
    const active = new Map<string, SupportConfigurationRegistration>();
    const lifecycle = new SupportRootRegistrationLifecycle({
      registry: {
        registerConfiguration: (registration) => {
          active.set(registration.configurationId, registration);
          calls.push(`register:${registration.configurationId}`);
        },
        unregisterConfiguration: (configurationId) => {
          active.delete(configurationId);
          calls.push(`unregister:${configurationId}`);
        },
      },
      watcher: {
        register: (_root, configurationId) => ({
          dispose: () => calls.push(`watcher-dispose:${configurationId}`),
        }),
      },
      resolveRegistrations: async () => {
        resolveCall += 1;
        return resolveCall === 1 ? first.promise : [registration('cfg-b', 'root-b')];
      },
      loadRegistration: async (value) => { calls.push(`load:${value.configurationId}`); },
      onDidLoad: (value) => calls.push(`loaded:${value.configurationId}`),
      onError: (error) => calls.push(`error:${String(error)}`),
    });

    lifecycle.accept(['root-a']);
    lifecycle.accept(['root-b']);
    first.resolve([registration('cfg-a', 'root-a')]);
    await tick();
    await tick();
    await lifecycle.dispose();

    assert.ok(!calls.includes('register:cfg-a'));
    assert.ok(calls.includes('register:cfg-b'));
    assert.ok(calls.includes('load:cfg-b'));
    assert.ok(calls.includes('loaded:cfg-b'));
    assert.ok(calls.includes('watcher-dispose:cfg-b'));
    assert.ok(calls.includes('unregister:cfg-b'));
    assert.strictEqual(active.size, 0);
  });

  test('root lifecycle reports duplicate identity/root snapshots without partial registration', async () => {
    const errors: unknown[] = [];
    let registered = 0;
    const lifecycle = new SupportRootRegistrationLifecycle({
      registry: {
        registerConfiguration: () => { registered += 1; },
        unregisterConfiguration: () => undefined,
      },
      watcher: { register: () => ({ dispose: () => undefined }) },
      resolveRegistrations: async () => [
        registration('same', 'one'),
        registration('same', 'two'),
      ],
      loadRegistration: async () => undefined,
      onDidLoad: () => undefined,
      onError: (error) => errors.push(error),
    });
    lifecycle.accept(['one', 'two']);
    await tick();
    await tick();
    assert.strictEqual(registered, 0);
    assert.strictEqual(errors.length, 1);
    await lifecycle.dispose();
  });

  test('SupportStateCache loads ready status without metadataUniverse and indexes master cleanly', async () => {
    const configurationId = 'cfg-ready-no-universe' as ConfigurationId;
    const root = path.resolve('no-universe-root');
    const cache = new SupportStateCache({
      getStatus: async () => ({
        status: 'available',
        master: {
          kind: 'ready' as const,
          snapshot: {
            configurationId,
            generationId: 'gen-no-universe',
            semanticDigest: 'gen-no-universe'.padEnd(64, '0').slice(0, 64),
            filePath: path.join(root, 'Ext', 'ParentConfigurations.bin'),
            formatRevision: '1',
            globalEditability: 'enabled',
            configurationMode: 'editable' as const,
            objectModes: new Map(),
            supplierConfigurations: [],
          },
        },
        metadataUniverse: undefined,
      }),
    });
    cache.register(root, configurationId);
    const loaded = await cache.load(root);

    assert.strictEqual(loaded.status, 'available');
    assert.strictEqual(loaded.configurationId, configurationId);
    assert.strictEqual(loaded.generationId, 'gen-no-universe');
    assert.strictEqual(loaded.master.kind, 'ready');
    assert.strictEqual('metadataUniverse' in loaded, false);
    assert.strictEqual(loaded.metadataUniverseIdentityIndex, undefined);
    assert.strictEqual(cache.get(root), loaded);
  });

  test('createSupportStateCacheFacade forwards getMasterStatus and attaches lastRun without invoking getStatus', async () => {
    const configurationId = 'cfg-adapter' as ConfigurationId;
    let getMasterStatusCalls = 0;
    let getLastRunCalls = 0;
    let getStatusCalls = 0;

    const mockFacade = {
      getMasterStatus: async (request: { configurationId: ConfigurationId }) => {
        getMasterStatusCalls += 1;
        assert.strictEqual(request.configurationId, configurationId);
        return {
          status: 'available' as const,
          master: {
            kind: 'ready' as const,
            snapshot: {
              configurationId,
              generationId: 'gen-adapter',
              semanticDigest: 'gen-adapter'.padEnd(64, '0').slice(0, 64),
              filePath: path.resolve('Ext', 'ParentConfigurations.bin'),
              formatRevision: '1',
              globalEditability: 'enabled' as const,
              configurationMode: 'mixed' as const,
              objectModes: new Map(),
              supplierConfigurations: [],
            },
          },
        };
      },
      getLastRun: async (request: { configurationId: ConfigurationId }) => {
        getLastRunCalls += 1;
        assert.strictEqual(request.configurationId, configurationId);
        return {
          status: 'available' as const,
          run: {
            runId: 'run-1',
            configurationId,
            desiredGenerationId: 'gen-adapter',
            operation: 'sync' as const,
            scope: 'masterOnly' as const,
            targets: [] as const,
            state: 'complete' as const,
            completedAt: '2026-09-20T12:00:00.000Z',
          },
        };
      },
      getStatus: async () => {
        getStatusCalls += 1;
        throw new Error('getStatus must NOT be called by UI cache');
      },
    };

    const cacheFacade = createSupportStateCacheFacade(mockFacade);
    const result = await cacheFacade.getStatus({ configurationId });

    assert.strictEqual(getMasterStatusCalls, 1);
    assert.strictEqual(getLastRunCalls, 1);
    assert.strictEqual(getStatusCalls, 0);
    assert.strictEqual(result.status, 'available');
    assert.strictEqual(result.master.kind, 'ready');
    assert.strictEqual(result.metadataUniverse, undefined);
    assert.strictEqual(result.lastRun?.runId, 'run-1');
  });

  test('createSupportStateCacheFacade throws on rejected getMasterStatus and handles unmanaged/no lastRun', async () => {
    const configurationId = 'cfg-unmanaged' as ConfigurationId;
    const mockFacade = {
      getMasterStatus: async () => ({
        status: 'available' as const,
        master: {
          kind: 'unmanaged' as const,
          reason: 'missing' as const,
          configurationId,
          expectedFilePath: path.resolve('missing', 'Ext', 'ParentConfigurations.bin'),
        },
      }),
      getLastRun: async () => ({
        status: 'available' as const,
        run: undefined,
      }),
    };

    const cacheFacade = createSupportStateCacheFacade(mockFacade);
    const result = await cacheFacade.getStatus({ configurationId });
    assert.strictEqual(result.status, 'available');
    assert.strictEqual(result.master.kind, 'unmanaged');
    assert.strictEqual('lastRun' in result, false);

    const rejectingFacade = {
      getMasterStatus: async () => ({
        status: 'operationRejected' as const,
        errorCode: 'SUPPORT_OPERATION_FAILED' as const,
        retryable: true as const,
      }),
      getLastRun: async () => ({
        status: 'available' as const,
        run: undefined,
      }),
    };

    const rejectingCacheFacade = createSupportStateCacheFacade(rejectingFacade);
    await assert.rejects(
      () => rejectingCacheFacade.getStatus({ configurationId }),
      /Support status is unavailable: SUPPORT_OPERATION_FAILED/,
    );
  });
});

function status(configurationId: ConfigurationId, generationId: string): SupportStatusResult {
  return {
    status: 'available',
    master: {
      kind: 'ready',
      snapshot: {
        configurationId,
        generationId,
        semanticDigest: generationId.padEnd(64, '0').slice(0, 64),
        filePath: path.resolve('Ext', 'ParentConfigurations.bin'),
        formatRevision: '1',
        globalEditability: 'enabled',
        configurationMode: 'mixed',
        objectModes: new Map(),
        supplierConfigurations: [],
      },
    },
    metadataUniverse: {
      configRoot: path.resolve('root'),
      metadataUniverseGenerationId: `universe-${generationId}`,
      entries: [],
    },
  };
}

function registration(id: string, root: string): SupportConfigurationRegistration {
  return {
    configurationId: id as ConfigurationId,
    configRoot: path.resolve(root),
    workspaceFolderName: `ws-${id}`,
    configRelativePath: 'Configuration.xml',
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class FakeWatcher implements SupportFileSystemWatcher {
  private readonly createListeners: Array<(uri: SupportWatcherUri) => void> = [];
  private readonly changeListeners: Array<(uri: SupportWatcherUri) => void> = [];
  private readonly deleteListeners: Array<(uri: SupportWatcherUri) => void> = [];
  disposed = false;

  onDidCreate(listener: (uri: SupportWatcherUri) => void): SupportWatcherDisposable {
    this.createListeners.push(listener);
    return disposable(this.createListeners, listener);
  }

  onDidChange(listener: (uri: SupportWatcherUri) => void): SupportWatcherDisposable {
    this.changeListeners.push(listener);
    return disposable(this.changeListeners, listener);
  }

  onDidDelete(listener: (uri: SupportWatcherUri) => void): SupportWatcherDisposable {
    this.deleteListeners.push(listener);
    return disposable(this.deleteListeners, listener);
  }

  change(fsPath: string): void {
    for (const listener of [...this.changeListeners]) {
      listener({ fsPath });
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}

function disposable<T>(items: T[], item: T): SupportWatcherDisposable {
  return {
    dispose: () => {
      const index = items.indexOf(item);
      if (index >= 0) {
        items.splice(index, 1);
      }
    },
  };
}
