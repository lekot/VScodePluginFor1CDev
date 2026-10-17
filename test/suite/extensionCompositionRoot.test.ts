import * as assert from 'assert';
import * as vscode from 'vscode';
import { ExtensionState } from '../../src/state/extensionState';
import {
  ExtensionCompositionRoot,
  type CompositionPipelineStages,
} from '../../src/extension/extensionCompositionRoot';
import { createMetadataTreeLifecycle } from '../../src/extension/metadataTreeLifecycle';
import { resetVscodeTestState } from '../helpers/vscodeModuleStub';

suite('ExtensionCompositionRoot (#261)', () => {
  let context: vscode.ExtensionContext;
  let state: ExtensionState;
  let lifecycle: ReturnType<typeof createMetadataTreeLifecycle>;

  setup(() => {
    resetVscodeTestState();
    state = new ExtensionState();
    lifecycle = createMetadataTreeLifecycle(state);
    context = {
      subscriptions: [],
      globalStorageUri: vscode.Uri.file('C:/tmp/globalStorage'),
      extensionPath: 'C:/tmp/extension',
      globalState: {
        get: () => undefined,
        update: () => Promise.resolve(),
        keys: () => [],
      },
      secrets: {
        get: () => Promise.resolve(undefined),
        store: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        onDidChange: new vscode.EventEmitter<{ key: string }>().event,
      },
    } as unknown as vscode.ExtensionContext;
  });

  teardown(async () => {
    await state.dispose();
    lifecycle.dispose();
    resetVscodeTestState();
  });

  test('composition root builds complete service graph and assigns non-null foundational dependencies to state', async () => {
    const root = new ExtensionCompositionRoot(context, state, lifecycle);
    await root.compose();

    assert.ok(state.infobaseStorage, 'infobaseStorage must be non-null after composition');
    assert.ok(state.bindingManager, 'bindingManager must be non-null after composition');
    assert.ok(state.workspaceRegistry, 'workspaceRegistry must be non-null after composition');
    assert.ok(state.configurationContextResolver, 'configurationContextResolver must be non-null after composition');
    assert.ok(state.configurationMutationEngine, 'configurationMutationEngine must be non-null after composition');
    assert.ok(state.reloadCoordinator, 'reloadCoordinator must be non-null after composition');
    assert.ok(state.treeDataProvider, 'treeDataProvider must be non-null after composition');

    // Teardown cleans up state
    await root.dispose();
    assert.strictEqual(state.workspaceRegistry, null, 'workspaceRegistry must be cleared upon dispose');
    assert.strictEqual(state.configurationMutationEngine, null, 'configurationMutationEngine must be cleared');
    assert.strictEqual(state.reloadCoordinator, null, 'reloadCoordinator must be cleared');
  });

  test('teardown executes disposables in reverse LIFO order with one-time guarantee', async () => {
    const order: string[] = [];
    const root = new ExtensionCompositionRoot(context, state, lifecycle);

    root.registerDisposable('storage', () => {
      order.push('storage');
    });
    root.registerDisposable('registry', () => {
      order.push('registry');
    });
    root.registerDisposable('tree', () => {
      order.push('tree');
    });
    root.registerDisposable('commands', () => {
      order.push('commands');
    });

    await root.dispose();
    // Subsequent dispose must be idempotent
    await root.dispose();

    assert.deepStrictEqual(
      order,
      ['commands', 'tree', 'registry', 'storage'],
      'Teardown order must strictly follow reverse LIFO creation order without duplicate calls',
    );
  });

  test('construction failure during early stage rolls back already created components', async () => {
    const disposed: string[] = [];
    const stages: CompositionPipelineStages = {
      initInfobaseServices: (r) => {
        r.registerDisposable('infobase', () => {
          disposed.push('infobase');
        });
      },
      initConfigurationInfrastructure: () => {
        throw new Error('Simulated failure during ConfigurationInfrastructure creation');
      },
      initTreeAndReload: (r) => {
        r.registerDisposable('tree', () => {
          disposed.push('tree');
        });
      },
    };

    const root = new ExtensionCompositionRoot(context, state, lifecycle, stages);

    await assert.rejects(
      root.compose(),
      /Simulated failure during ConfigurationInfrastructure creation/,
      'compose() must rethrow original stage failure',
    );

    assert.deepStrictEqual(
      disposed,
      ['infobase'],
      'Only components created prior to failure must be disposed during rollback',
    );
  });

  test('construction failure during late command stage rolls back all upstream services', async () => {
    const disposed: string[] = [];
    const stages: CompositionPipelineStages = {
      initInfobaseServices: (r) => {
        r.registerDisposable('infobase', () => {
          disposed.push('infobase');
        });
      },
      initConfigurationInfrastructure: (r) => {
        r.registerDisposable('infra', () => {
          disposed.push('infra');
        });
        return {} as any;
      },
      initTreeAndReload: (r) => {
        r.registerDisposable('tree', () => {
          disposed.push('tree');
        });
      },
      initCommands: () => {
        throw new Error('Simulated command registration failure');
      },
    };

    const root = new ExtensionCompositionRoot(context, state, lifecycle, stages);

    await assert.rejects(
      root.compose(),
      /Simulated command registration failure/,
    );

    assert.deepStrictEqual(
      disposed,
      ['tree', 'infra', 'infobase'],
      'All upstream components must be rolled back in reverse LIFO order upon late failure',
    );
  });

  test('rollback is fault-isolated: error in one disposable does not block downstream disposals', async () => {
    const disposed: string[] = [];
    const stages: CompositionPipelineStages = {
      initInfobaseServices: (r) => {
        r.registerDisposable('storage', () => {
          disposed.push('storage');
        });
        r.registerDisposable('broken', () => {
          disposed.push('broken');
          throw new Error('Disposal exploded');
        });
        r.registerDisposable('manager', () => {
          disposed.push('manager');
        });
      },
      initConfigurationInfrastructure: () => {
        throw new Error('Trigger rollback');
      },
    };

    const root = new ExtensionCompositionRoot(context, state, lifecycle, stages);

    await assert.rejects(root.compose(), /Trigger rollback/);

    assert.deepStrictEqual(
      disposed,
      ['manager', 'broken', 'storage'],
      'Rollback must continue disposing remaining services even when one throws',
    );
  });
});
