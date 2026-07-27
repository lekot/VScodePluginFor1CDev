import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { registerUtilityCommandsLeading } from '../../src/commands/utilityCommands';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

const TEST_COMMAND_IDS = [
  '1c-metadata-tree.getSelectionNameForTest',
  '1c-metadata-tree.getTreeReadyForTest',
  '1c-metadata-tree.diagnoseRevealForTest',
  '1c-metadata-tree.getPropertiesOpenStateForTest',
] as const;

suite('extension manifest contracts', () => {
  test('activates for 1C workspace markers and the explicit BSL debug resolver', () => {
    const pkg = readPackageJson();
    const expectedActivationEvents = [
      'workspaceContains:**/Configuration.xml',
      'workspaceContains:**/ConfigDumpInfo.xml',
      'workspaceContains:**/src/Configuration/Configuration.mdo',
      'workspaceContains:**/*.cf',
      'workspaceContains:**/*.cfe',
      'onDebugResolve:bsl',
    ];

    assert.deepStrictEqual(
      [...pkg.activationEvents].sort(),
      [...expectedActivationEvents].sort()
    );
    assert.ok(!pkg.activationEvents.includes('onStartupFinished'));
    assert.ok(!pkg.activationEvents.includes('workspaceContains:**/.project'));
  });

  test('declares virtual workspaces unsupported because metadata access is filesystem based', () => {
    const pkg = readPackageJson();
    assert.strictEqual(pkg.capabilities?.virtualWorkspaces?.supported, false);
  });

  test('Explorer views are collapsed without a self-hiding context condition', () => {
    const pkg = readPackageJson();
    const views = pkg.contributes.views.explorer as Array<Record<string, unknown>>;

    for (const id of ['1c-metadata-tree', '1c-infobase-manager']) {
      const view = views.find((candidate) => candidate.id === id);
      assert.ok(view, `Missing Explorer view ${id}`);
      assert.strictEqual(view.visibility, 'collapsed');
      assert.ok(!Object.prototype.hasOwnProperty.call(view, 'when'));
    }
  });

  test('test-only commands are absent from command and palette contributions', () => {
    const pkg = readPackageJson();
    const contributed = new Set<string>(
      pkg.contributes.commands.map((entry: { command: string }) => entry.command)
    );
    const palette = new Set<string>(
      pkg.contributes.menus.commandPalette.map((entry: { command: string }) => entry.command)
    );

    for (const commandId of TEST_COMMAND_IDS) {
      assert.ok(!contributed.has(commandId), `${commandId} must not be contributed`);
      assert.ok(!palette.has(commandId), `${commandId} must not be in commandPalette`);
    }
  });

  test('contributes every registered public Agent API command', () => {
    const root = repositoryRoot();
    const source = fs.readFileSync(path.join(root, 'src', 'agent', 'agentCommands.ts'), 'utf8');
    const registered = new Set(
      [...source.matchAll(/['"](1c-metadata-tree\.agent\.[A-Za-z0-9_.-]+)['"]/g)]
        .map((match) => match[1]),
    );
    const contributed = new Set<string>(
      readPackageJson().contributes.commands
        .map((entry: { command: string }) => entry.command)
        .filter((command: string) => command.startsWith('1c-metadata-tree.agent.')),
    );

    assert.strictEqual(registered.size, 69, 'Update the documented Agent API count intentionally.');
    assert.deepStrictEqual([...contributed].sort(), [...registered].sort());
  });

  test('registers test-only commands only in ExtensionMode.Test', () => {
    for (const mode of [vscode.ExtensionMode.Production, vscode.ExtensionMode.Development]) {
      resetVscodeTestState();
      registerLeadingCommands(mode);
      for (const commandId of TEST_COMMAND_IDS) {
        assert.ok(
          !vscodeTestState.registeredCommandIds.includes(commandId),
          `${commandId} unexpectedly registered in mode ${mode}`
        );
      }
    }

    resetVscodeTestState();
    registerLeadingCommands(vscode.ExtensionMode.Test);
    for (const commandId of TEST_COMMAND_IDS) {
      assert.ok(
        vscodeTestState.registeredCommandIds.includes(commandId),
        `${commandId} must be registered in test mode`
      );
    }
  });

  test('ships dist entrypoint while ignoring and excluding legacy build output', () => {
    const root = repositoryRoot();
    const pkg = readPackageJson();
    const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf-8').split(/\r?\n/);
    const vscodeignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf-8').split(/\r?\n/);

    assert.strictEqual(pkg.main, './dist/extension.js');
    assert.ok(gitignore.includes('build/'));
    assert.ok(vscodeignore.includes('build/**'));
  });
});

function registerLeadingCommands(extensionMode: vscode.ExtensionMode): void {
  registerUtilityCommandsLeading({
    state: {} as any,
    loadMetadataTree: async () => undefined,
    extensionContext: { extensionMode } as vscode.ExtensionContext,
  });
}

function readPackageJson(): any {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot(), 'package.json'), 'utf-8'));
}

function repositoryRoot(): string {
  return path.resolve(__dirname, '../../..');
}
