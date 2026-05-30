import * as assert from 'assert';
import * as path from 'path';

import {
  createConfigurationCompareBackupRootPath,
  executeConfigurationCompareCommand,
  resolveConfigurationCompareLeftRoot,
} from '../../../src/commands/configurationCompareCommands';

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

  test('passes backup root under extension global storage to compare builder', async () => {
    const globalStoragePath = path.join('C:', 'extension-storage');
    const buildInputs: unknown[] = [];
    const shownWorkspaces: unknown[] = [];

    await executeConfigurationCompareCommand({
      context: {
        globalStorageUri: { fsPath: globalStoragePath },
      } as any,
      state: {
        treeDataProvider: {
          getConfigPathForNode: () => null,
          getConfigPath: () => path.join('C:', 'configs', 'left'),
        },
      } as any,
      pickRightRoot: async () => path.join('C:', 'configs', 'right'),
      withCompareProgress: async (_title, task) => {
        await task();
      },
      buildCompare: async (input) => {
        buildInputs.push(input);
        return {
          projection: { root: { children: [] }, stats: { total: 0, different: 0, mergeable: 0 } },
          workspace: { id: 'workspace' },
        } as any;
      },
      showCompare: (_context, workspace) => {
        shownWorkspaces.push(workspace);
        return undefined as any;
      },
    });

    assert.strictEqual(buildInputs.length, 1);
    assert.strictEqual((buildInputs[0] as any).leftRootPath, path.join('C:', 'configs', 'left'));
    assert.strictEqual((buildInputs[0] as any).rightRootPath, path.join('C:', 'configs', 'right'));
    assert.ok(
      isPathInside(globalStoragePath, (buildInputs[0] as any).backupRootPath),
      `backupRootPath must be under global storage: ${(buildInputs[0] as any).backupRootPath}`
    );
    assert.match((buildInputs[0] as any).backupRootPath, /merge-backups/);
    assert.deepStrictEqual(shownWorkspaces, [{ id: 'workspace' }]);
  });

  test('creates backup root under global storage merge-backups directory', () => {
    const root = createConfigurationCompareBackupRootPath(
      { globalStorageUri: { fsPath: path.join('C:', 'extension-storage') } } as any,
      path.join('C:', 'configs', 'left'),
      path.join('C:', 'configs', 'right')
    );

    assert.ok(isPathInside(path.join('C:', 'extension-storage', 'merge-backups'), root));
  });
});

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
