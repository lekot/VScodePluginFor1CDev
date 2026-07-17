import * as assert from 'assert';
import * as vscode from 'vscode';
import { MESSAGES } from '../../src/constants/messages';
import { createMetadataTreeLifecycle } from '../../src/extension/metadataTreeLifecycle';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { FormatDetector } from '../../src/parsers/formatDetector';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { ExtensionState } from '../../src/state/extensionState';
import {
  resetVscodeTestState,
  vscodeTestState,
} from '../helpers/vscodeModuleStub';

suite('MetadataTreeLifecycle', () => {
  const originalFindAllConfigurationRoots = FormatDetector.findAllConfigurationRoots;
  const originalFindAllConfigurationPackageFiles = FormatDetector.findAllConfigurationPackageFiles;

  function stubDiscovery(options?: {
    configs?: Array<{ configPath: string; workspaceFolderPath: string }>;
    packages?: Array<{ filePath: string; workspaceFolderPath: string }>;
  }): void {
    (FormatDetector.findAllConfigurationRoots as unknown as typeof FormatDetector.findAllConfigurationRoots) =
      async () => options?.configs ?? [];
    (FormatDetector.findAllConfigurationPackageFiles as unknown as typeof FormatDetector.findAllConfigurationPackageFiles) =
      async () => options?.packages ?? [];
  }

  function createStateWithProvider(): {
    state: ExtensionState;
    provider: MetadataTreeDataProvider;
    messages: Array<string | undefined>;
  } {
    const state = new ExtensionState();
    const provider = new MetadataTreeDataProvider();
    const messages: Array<string | undefined> = [];
    provider.setMessageUpdater((message) => messages.push(message));
    state.treeDataProvider = provider;
    return { state, provider, messages };
  }

  setup(() => {
    resetVscodeTestState();
    stubDiscovery();
  });

  teardown(() => {
    (FormatDetector.findAllConfigurationRoots as unknown as typeof FormatDetector.findAllConfigurationRoots) =
      originalFindAllConfigurationRoots;
    (FormatDetector.findAllConfigurationPackageFiles as unknown as typeof FormatDetector.findAllConfigurationPackageFiles) =
      originalFindAllConfigurationPackageFiles;
    resetVscodeTestState();
  });

  test('no configuration clears roots and uses contextual empty state without a global warning', async () => {
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'non-1c', index: 0, uri: vscode.Uri.file('C:/workspace/non-1c') },
    ];
    const { state, provider, messages } = createStateWithProvider();
    const existingRoot: TreeNode = {
      id: 'existing-configuration',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
    };
    provider.setRootNode(existingRoot);

    await createMetadataTreeLifecycle(state).loadMetadataTree();

    assert.deepStrictEqual(vscodeTestState.warningLog, []);
    assert.deepStrictEqual(provider.getRootNodes(), []);
    assert.strictEqual(messages.at(-1), MESSAGES.EMPTY_TREE_MESSAGE);
  });

  test('no workspace preserves NO_WORKSPACE warning and clears the tree', async () => {
    vscodeTestState.mockWorkspaceFolders = [];
    const { state, provider, messages } = createStateWithProvider();

    await createMetadataTreeLifecycle(state).loadMetadataTree();

    assert.deepStrictEqual(vscodeTestState.warningLog, [MESSAGES.NO_WORKSPACE]);
    assert.deepStrictEqual(provider.getRootNodes(), []);
    assert.strictEqual(messages.at(-1), MESSAGES.EMPTY_TREE_MESSAGE);
  });

  test('a real metadata load error is still reported', async () => {
    const workspaceFolderPath = 'C:/workspace/1c';
    vscodeTestState.mockWorkspaceFolders = [
      { name: '1c', index: 0, uri: vscode.Uri.file(workspaceFolderPath) },
    ];
    stubDiscovery({
      configs: [{ configPath: 'C:/missing-configuration', workspaceFolderPath }],
    });
    const { state } = createStateWithProvider();

    await createMetadataTreeLifecycle(state).loadMetadataTree();

    assert.strictEqual(vscodeTestState.warningLog.length, 0);
    assert.strictEqual(vscodeTestState.errorLog.length, 1);
    assert.match(vscodeTestState.errorLog[0], new RegExp(`^${MESSAGES.ERROR_LOADING}:`));
  });
});
