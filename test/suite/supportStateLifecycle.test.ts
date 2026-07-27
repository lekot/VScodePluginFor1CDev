import * as assert from 'assert';
import * as path from 'path';
import type { ConfigurationId } from '../../src/services/configurationSession/types';
import {
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
