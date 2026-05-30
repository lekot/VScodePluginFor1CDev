import * as assert from 'assert';

import { resolveConfigurationCompareLeftRoot } from '../../../src/commands/configurationCompareCommands';

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
      resolveConfigurationCompareLeftRoot(state as any, commandNode as any),
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

    assert.strictEqual(resolveConfigurationCompareLeftRoot(state as any), 'C:/configs/fallback');
  });
});
