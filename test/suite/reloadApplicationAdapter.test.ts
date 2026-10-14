import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ReloadCoordinatorService } from '../../src/services/reloadCoordinatorService';
import type { ReloadOperationResult, ReloadReason } from '../../src/types/reloadContracts';

interface ReloadRequester {
  (configPath: string, reason: ReloadReason): Promise<void>;
}

interface RequesterModule {
  createRequestConfigurationReload(state: { reloadCoordinator: ReloadCoordinatorService | null }): ReloadRequester;
}

interface TypeScriptSource {
  relativePath: string;
  content: string;
}

const lifecycleOwners = new Set([
  'src/extension/metadataTreeLifecycle.ts',
  'src/extension/extensionWorkspaceSetup.ts',
]);
const lifecycleSchedulingPattern = /\b(?:invalidateCacheAndReload|reloadConfiguration)\b/u;
const lifecycleExecutorPattern = /\bexecuteConfigurationReload\b/u;
const lifecycleExecutorForwardingPattern = /\bexecuteConfigurationReload\s*:/u;

function loadRequesterModule(): RequesterModule {
  // Keep the module lookup dynamic so this suite compiles on Red before the adapter exists.
  return require('../../src/reload/requestConfigurationReload') as RequesterModule;
}

function collectProductionTypeScriptSources(directory: string, projectRoot: string): TypeScriptSource[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectProductionTypeScriptSources(entryPath, projectRoot);
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts')) {
      return [];
    }
    return [{
      relativePath: path.relative(projectRoot, entryPath).replace(/\\/gu, '/'),
      content: fs.readFileSync(entryPath, 'utf8'),
    }];
  });
}

function findLifecycleBypasses(sources: readonly TypeScriptSource[]): string[] {
  return sources
    .filter(({ relativePath, content }) => lifecycleSchedulingPattern.test(content)
      || (lifecycleExecutorPattern.test(content)
        && (!lifecycleOwners.has(relativePath)
          || (relativePath === 'src/extension/extensionWorkspaceSetup.ts'
            && lifecycleExecutorForwardingPattern.test(content)))))
    .map(({ relativePath }) => relativePath)
    .sort();
}

suite('requestConfigurationReload application adapter', () => {
  test('waits for the real coordinator batch shared by command, watcher and repository origins', async () => {
    let releaseRunner!: () => void;
    let runnerStarted!: () => void;
    const runnerGate = new Promise<void>((resolve) => { releaseRunner = resolve; });
    const started = new Promise<void>((resolve) => { runnerStarted = resolve; });
    const runnerReasons: ReloadReason[] = [];
    const coordinator = new ReloadCoordinatorService(async ({ reason }) => {
      runnerReasons.push(reason);
      runnerStarted();
      await runnerGate;
    }, { defaultDebounceMs: 5 });
    const request = loadRequesterModule().createRequestConfigurationReload({ reloadCoordinator: coordinator });

    let settled = false;
    const requests = Promise.all([
      request('C:/config', 'create-command'),
      request('C:/config', 'watcher'),
      request('C:/config', 'repository' as ReloadReason),
    ]).then(() => { settled = true; });

    await started;
    await Promise.resolve();
    assert.strictEqual(settled, false, 'application call must remain pending while the coordinator runner is pending');
    assert.deepStrictEqual(runnerReasons, ['repository'], 'the requests should enter one coordinator batch');
    releaseRunner();
    await requests;
    assert.strictEqual(settled, true);
    await coordinator.dispose();
  });

  test('rejects an awaited request with the coordinator typed failure code and message', async () => {
    const coordinator = new ReloadCoordinatorService(async () => {
      throw Object.assign(new Error('Configuration parse failed.'), { code: 'CONFIGURATION_PARSE_FAILED' });
    }, { defaultDebounceMs: 0 });
    const request = loadRequesterModule().createRequestConfigurationReload({ reloadCoordinator: coordinator });

    await assert.rejects(request('C:/config', 'rename-command'), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.strictEqual((error as Error & { code?: string }).code, 'CONFIGURATION_PARSE_FAILED');
      assert.strictEqual((error as Error).message, 'Configuration parse failed.');
      return true;
    });
    await coordinator.dispose();
  });

  test('maps legacy failed results without optional failure details to the public fallback contract', async () => {
    const cases: Array<{ result: ReloadOperationResult; expectedCode: string; expectedMessage: string }> = [
      {
        result: {
          operationId: 'legacy-error',
          reason: 'repository',
          succeeded: false,
          error: 'Unclassified reload failure.',
          completedAt: Date.now(),
        },
        expectedCode: 'UNKNOWN_RELOAD_FAILURE',
        expectedMessage: 'Unclassified reload failure.',
      },
      {
        result: {
          operationId: 'legacy-no-error',
          reason: 'repository',
          succeeded: false,
          completedAt: Date.now(),
        },
        expectedCode: 'UNKNOWN_RELOAD_FAILURE',
        expectedMessage: 'Перезагрузка конфигурации завершилась ошибкой.',
      },
    ];

    for (const { result, expectedCode, expectedMessage } of cases) {
      const coordinator = {
        requestReload: () => ({ operationId: result.operationId, completed: Promise.resolve(result) }),
      } as unknown as ReloadCoordinatorService;
      const request = loadRequesterModule().createRequestConfigurationReload({ reloadCoordinator: coordinator });

      await assert.rejects(request('C:/config', 'repository'), (error: unknown) => {
        assert.strictEqual((error as Error & { code?: string }).code, expectedCode);
        assert.strictEqual((error as Error).message, expectedMessage);
        return true;
      });
    }
  });

  test('rejects pending application requests when the coordinator is disposed', async () => {
    const coordinator = new ReloadCoordinatorService(async () => undefined, { defaultDebounceMs: 10_000 });
    const request = loadRequesterModule().createRequestConfigurationReload({ reloadCoordinator: coordinator });
    const pending = request('C:/config', 'create-command');
    await coordinator.dispose();

    await assert.rejects(pending, (error: unknown) => {
      assert.strictEqual((error as Error & { code?: string }).code, 'RELOAD_DISPOSED');
      return true;
    });
  });

  test('fails closed when no coordinator is available and does not use lifecycle fallback', async () => {
    let fallbackCalls = 0;
    const state = {
      reloadCoordinator: null,
      lifecycle: { invalidateCacheAndReload: async () => { fallbackCalls++; } },
    };
    const request = loadRequesterModule().createRequestConfigurationReload(state);

    await assert.rejects(request('C:/config', 'repository' as ReloadReason), (error: unknown) => {
      assert.strictEqual((error as Error & { code?: string }).code, 'RELOAD_COORDINATOR_UNAVAILABLE');
      assert.strictEqual((error as Error).message, 'Координатор перезагрузки конфигурации недоступен.');
      return true;
    });
    assert.strictEqual(fallbackCalls, 0);
  });

  test('keeps targeted feature callers routed through the shared application entrypoint', () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..');
    const sources = collectProductionTypeScriptSources(path.join(projectRoot, 'src'), projectRoot);
    assert.deepStrictEqual(findLifecycleBypasses(sources), []);

    const injectedFeature = {
      relativePath: 'src/commands/injectedReloadBypass.ts',
      content: 'lifecycle.invalidateCacheAndReload(configPath);',
    };
    assert.deepStrictEqual(
      findLifecycleBypasses([...sources, injectedFeature]),
      ['src/commands/injectedReloadBypass.ts'],
      'the recursive source guard must detect bypasses in newly added feature files',
    );

    const injectedExecutor = {
      relativePath: 'src/commands/injectedExecutorBypass.ts',
      content: 'lifecycle.executeConfigurationReload(configPath, canPublish);',
    };
    assert.deepStrictEqual(
      findLifecycleBypasses([...sources, injectedExecutor]),
      ['src/commands/injectedExecutorBypass.ts'],
      'only the composition root may call the single-attempt lifecycle executor',
    );

    const injectedForwarding = {
      relativePath: 'src/extension/extensionWorkspaceSetup.ts',
      content: 'const trackedLifecycle = { executeConfigurationReload: lifecycle.executeConfigurationReload };',
    };
    assert.deepStrictEqual(
      findLifecycleBypasses([...sources, injectedForwarding]),
      ['src/extension/extensionWorkspaceSetup.ts'],
      'the composition root must not forward its single-attempt executor to feature registrations',
    );
  });
});
