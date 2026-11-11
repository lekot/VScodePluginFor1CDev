import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  createConfigurationCompareBackupRootPath,
  executeConfigurationCompareCommand,
  resolveConfigurationCompareLeftRoot,
} from '../../../src/commands/configurationCompareCommands';
import { ConfigurationCompareCancelledError } from '../../../src/compareMerge/compareCancellation';
import type {
  ConfigurationCompareInput,
  ConfigurationCompareResult,
} from '../../../src/compareMerge/configurationCompareService';
import type { CompareBuildProgress } from '../../../src/compareMerge/compareProgress';

suite('ConfigurationCompareCommands', () => {
  test('resolves left root from command node before tree fallback', () => {
    const selectedNode = { id: 'selected' };
    const commandNode = { id: 'command' };
    const state = {
      treeView: { selection: [selectedNode] },
      treeDataProvider: {
        getConfigPathForNode: (node: { id: string }) =>
          node.id === 'command' ? 'C:/configs/command' : 'C:/configs/selected',
        getConfigPath: () => 'C:/configs/fallback',
      },
    };

    assert.strictEqual(
      resolveConfigurationCompareLeftRoot(
        state as unknown as Parameters<typeof resolveConfigurationCompareLeftRoot>[0],
        commandNode as unknown as Parameters<typeof resolveConfigurationCompareLeftRoot>[1]
      ),
      'C:/configs/command'
    );
  });

  test('falls back to provider config path when no node config is resolved', () => {
    const state = {
      treeDataProvider: {
        getConfigPathForNode: () => null,
        getConfigPath: () => 'C:/configs/fallback',
      },
    };

    assert.strictEqual(
      resolveConfigurationCompareLeftRoot(
        state as unknown as Parameters<typeof resolveConfigurationCompareLeftRoot>[0]
      ),
      'C:/configs/fallback'
    );
  });

  test('opens loading before extension-base, resource-context and build work, then forwards progress', async () => {
    const harness = createCommandHarness({
      buildCompare: async (input) => {
        const progress: CompareBuildProgress = { phase: 'inventory', completed: 2, total: 4 };
        input.onProgress?.(progress);
        return createCompareResult({ id: 'workspace', dispose: () => undefined });
      },
    });

    await withExtensionBaseMarker(harness.events, async () => {
      await executeConfigurationCompareCommand(harness.deps);
    });

    assert.deepStrictEqual(harness.events, [
      'choose-right',
      'loading',
      'begin-generation',
      'extension-base',
      'resource-context',
      'build',
      'complete',
    ]);
    assert.strictEqual(harness.loadingCalls.length, 1);
    assert.deepStrictEqual(harness.loadingCalls[0].labels, { target: 'left', source: 'right' });
    assert.match(harness.loadingCalls[0].title, /left.*right/);
    assert.strictEqual(harness.generations.length, 1);
    assert.strictEqual(harness.buildInputs.length, 1);
    assert.strictEqual(harness.buildInputs[0].cancellation, harness.generations[0].token);
    assert.deepStrictEqual(harness.generations[0].reported, [
      { phase: 'inventory', completed: 2, total: 4 },
    ]);
    assert.strictEqual(harness.generations[0].completed.length, 1);
    assert.strictEqual(
      (harness.generations[0].completed[0] as { id?: string }).id,
      'workspace'
    );
  });

  test('treats cancellation during build as a cancelled generation, not a failure', async () => {
    const harness = createCommandHarness({
      buildCompare: async (_input, generation) => {
        generation.token.isCancellationRequested = true;
        throw new ConfigurationCompareCancelledError();
      },
    });

    await executeConfigurationCompareCommand(harness.deps);

    assert.strictEqual(harness.generations.length, 1);
    assert.deepStrictEqual(harness.generations[0].failed, []);
    assert.deepStrictEqual(harness.generations[0].completed, []);
  });

  test('disposes a workspace returned by a generation that became stale', async () => {
    let disposed = 0;
    const harness = createCommandHarness({
      buildCompare: async (_input, generation) => {
        generation.current = false;
        return createCompareResult({ id: 'stale', dispose: () => disposed++ });
      },
    });

    await executeConfigurationCompareCommand(harness.deps);

    assert.strictEqual(disposed, 1);
    assert.deepStrictEqual(harness.generations[0].completed, []);
    assert.deepStrictEqual(harness.generations[0].failed, []);
  });

  test('fails the current generation and retry reuses the chosen roots in a new generation', async () => {
    const firstError = new Error('initial build failed');
    const attempts: Array<{ left: string; right: string }> = [];
    const retryWorkspace = { id: 'retry', dispose: () => undefined };
    const harness = createCommandHarness({
      buildCompare: async (input) => {
        attempts.push({ left: input.leftRootPath, right: input.rightRootPath });
        if (attempts.length === 1) {
          throw firstError;
        }
        return createCompareResult(retryWorkspace);
      },
    });

    await executeConfigurationCompareCommand(harness.deps);

    assert.deepStrictEqual(harness.generations[0].failed, [firstError]);
    const retryHandler = harness.retryHandler;
    assert.ok(retryHandler, 'loading view should have a retry handler');
    retryHandler();
    await waitForGenerationSettlement(harness.generations, 2);

    assert.strictEqual(harness.loadingCalls.length, 1);
    assert.strictEqual(harness.events.filter((event) => event === 'choose-right').length, 1);
    assert.strictEqual(harness.generations.length, 2);
    assert.deepStrictEqual(attempts, [
      { left: harness.leftRootPath, right: harness.rightRootPath },
      { left: harness.leftRootPath, right: harness.rightRootPath },
    ]);
    assert.deepStrictEqual(harness.generations[1].completed, [retryWorkspace]);
  });

  test('passes backup root under extension global storage to compare builder', async () => {
    const globalStoragePath = path.join('C:', 'extension-storage');
    const harness = createCommandHarness({
      buildCompare: async () => createCompareResult({ id: 'workspace', dispose: () => undefined }),
      globalStoragePath,
    });

    await executeConfigurationCompareCommand(harness.deps);

    assert.strictEqual(harness.buildInputs.length, 1);
    assert.strictEqual(harness.buildInputs[0].leftRootPath, harness.leftRootPath);
    assert.strictEqual(harness.buildInputs[0].rightRootPath, harness.rightRootPath);
    assert.ok(
      isPathInside(globalStoragePath, harness.buildInputs[0].backupRootPath),
      `backupRootPath must be under global storage: ${harness.buildInputs[0].backupRootPath}`
    );
    assert.match(harness.buildInputs[0].backupRootPath, /merge-backups/);
  });

  test('creates backup root under global storage merge-backups directory', () => {
    const root = createConfigurationCompareBackupRootPath(
      { globalStorageUri: { fsPath: path.join('C:', 'extension-storage') } } as unknown as Parameters<
        typeof createConfigurationCompareBackupRootPath
      >[0],
      path.join('C:', 'configs', 'left'),
      path.join('C:', 'configs', 'right')
    );

    assert.ok(isPathInside(path.join('C:', 'extension-storage', 'merge-backups'), root));
  });
});

interface FakeGeneration {
  current: boolean;
  token: { isCancellationRequested: boolean };
  reported: unknown[];
  completed: unknown[];
  failed: unknown[];
  isCurrent(): boolean;
}

function createCommandHarness(options: {
  buildCompare: (
    input: ConfigurationCompareInput,
    generation: FakeGeneration
  ) => Promise<ConfigurationCompareResult>;
  globalStoragePath?: string;
}): {
  deps: Parameters<typeof executeConfigurationCompareCommand>[0];
  events: string[];
  generations: FakeGeneration[];
  buildInputs: ConfigurationCompareInput[];
  loadingCalls: Array<{ title: string; labels: { target: string; source: string } }>;
  retryHandler?: () => void;
  leftRootPath: string;
  rightRootPath: string;
} {
  const leftRootPath = path.join('C:', 'configs', 'left');
  const rightRootPath = path.join('C:', 'configs', 'right');
  const events: string[] = [];
  const generations: FakeGeneration[] = [];
  const buildInputs: ConfigurationCompareInput[] = [];
  const loadingCalls: Array<{ title: string; labels: { target: string; source: string } }> = [];
  let retryHandler: (() => void) | undefined;

  const deps = {
    context: {
      globalStorageUri: { fsPath: options.globalStoragePath ?? path.join('C:', 'extension-storage') },
    },
    state: {
      treeDataProvider: {
        getConfigPathForNode: () => null,
        getConfigPath: () => leftRootPath,
      },
      configurationContextResolver: {
        resolveFromResource: async () => {
          events.push('resource-context');
          return { configurationId: 'configuration-id' };
        },
      },
    },
    pickRightRoot: async () => {
      events.push('choose-right');
      return rightRootPath;
    },
    showCompareLoading: (
      _context: vscode.ExtensionContext,
      title: string,
      labels: { target: string; source: string }
    ) => {
      events.push('loading');
      loadingCalls.push({ title, labels });
      return {
        beginGeneration: () => {
          events.push('begin-generation');
          const generation: FakeGeneration = {
            current: true,
            token: { isCancellationRequested: false },
            reported: [],
            completed: [],
            failed: [],
            isCurrent: () => generation.current && !generation.token.isCancellationRequested,
          };
          generations.push(generation);
          return {
            token: generation.token,
            report: (progress: unknown) => generation.reported.push(progress),
            complete: (workspace: unknown) => {
              events.push('complete');
              generation.completed.push(workspace);
            },
            fail: (error: unknown) => generation.failed.push(error),
            isCurrent: generation.isCurrent,
          };
        },
        setRetryHandler: (handler: () => void) => {
          retryHandler = handler;
        },
      };
    },
    buildCompare: async (input: ConfigurationCompareInput) => {
      events.push('build');
      buildInputs.push(input);
      const generation = generations[generations.length - 1];
      return options.buildCompare(input, generation);
    },
  };

  return {
    deps: deps as unknown as Parameters<typeof executeConfigurationCompareCommand>[0],
    events,
    generations,
    buildInputs,
    loadingCalls,
    get retryHandler() {
      return retryHandler;
    },
    leftRootPath,
    rightRootPath,
  };
}

async function withExtensionBaseMarker(events: string[], task: () => Promise<void>): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
  Object.defineProperty(vscode.workspace, 'workspaceFolders', {
    configurable: true,
    enumerable: true,
    get: () => {
      events.push('extension-base');
      return [];
    },
  });
  try {
    await task();
  } finally {
    if (descriptor) {
      Object.defineProperty(vscode.workspace, 'workspaceFolders', descriptor);
    } else {
      Reflect.deleteProperty(vscode.workspace, 'workspaceFolders');
    }
  }
}

async function waitForGenerationSettlement(generations: FakeGeneration[], expectedCount: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const generation = generations[expectedCount - 1];
    if (generation && (generation.completed.length > 0 || generation.failed.length > 0)) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`Generation ${expectedCount} did not settle`);
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function createCompareResult(workspace: unknown): ConfigurationCompareResult {
  return { workspace } as unknown as ConfigurationCompareResult;
}
