import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { resolveBindingCommand } from '../../src/agent/agentBindingResolver';
import { findWorkspaceFolderForPath } from '../../src/agent/agentWorkspaceContext';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';
import type { ConfigurationBinding } from '../../src/bindings/models/configurationBinding';

suite('Agent Multi-Root Fail-Closed Routing (Issue #197)', () => {
  let tmpA: string;
  let tmpB: string;

  setup(async () => {
    resetVscodeTestState();
    const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mr-routing-'));
    tmpA = path.join(base, 'wsA');
    tmpB = path.join(base, 'wsB');
    await fs.promises.mkdir(tmpA, { recursive: true });
    await fs.promises.mkdir(tmpB, { recursive: true });

    vscodeTestState.mockWorkspaceFolders = [
      { uri: { fsPath: tmpA, scheme: 'file' }, name: 'folderA', index: 0 },
      { uri: { fsPath: tmpB, scheme: 'file' }, name: 'folderB', index: 1 },
    ];

  });

  teardown(async () => {
    resetVscodeTestState();
    const parent = path.dirname(tmpA);
    await fs.promises.rm(parent, { recursive: true, force: true }).catch(() => undefined);
  });

  test('findWorkspaceFolderForPath returns undefined when path is outside workspace', () => {
    const outside = path.join(os.tmpdir(), 'completely-outside-path');
    const folder = findWorkspaceFolderForPath(outside);
    assert.strictEqual(folder, undefined, 'Path outside workspace must not resolve to any folder');
  });

  test('findWorkspaceFolderForPath matches exact workspace folder', () => {
    const insideB = path.join(tmpB, 'src', 'Configuration.xml');
    const folder = findWorkspaceFolderForPath(insideB);
    assert.ok(folder);
    assert.strictEqual(folder?.name, 'folderB');
  });

  test('resolveBindingCommand fails closed when matched.workspaceFolder does not exist', async () => {
    const binding: ConfigurationBinding = {
      configRelativePath: 'src',
      workspaceFolder: 'nonExistentFolder',
      infobaseIds: [],
      massDeployment: false,
    };
    const deps = {
      bindingManager: { listAll: async () => [binding] },
      infobaseManager: { listAll: async () => [] },
    };

    const result = await resolveBindingCommand({ configPath: 'src' }, deps as any);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('nonExistentFolder') || result.error?.includes('не найдена'));
  });

  test('resolveBindingCommand succeeds when single-root even if workspaceFolder is omitted', async () => {
    vscodeTestState.mockWorkspaceFolders = [
      { uri: { fsPath: tmpA, scheme: 'file' }, name: 'folderA', index: 0 },
    ];
    const binding: ConfigurationBinding = {
      configRelativePath: 'src',
      workspaceFolder: '',
      infobaseIds: [],
      massDeployment: false,
    };
    const deps = {
      bindingManager: { listAll: async () => [binding] },
      infobaseManager: { listAll: async () => [] },
    };

    const result = await resolveBindingCommand({ configPath: 'src' }, deps as any);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data?.configPath, path.join(tmpA, 'src'));
  });

  test('findWorkspaceFolderForPath handles case variations on Windows', () => {
    if (process.platform !== 'win32') {
      return;
    }
    const mixedCase = path.join(tmpB.toUpperCase(), 'src', 'Configuration.xml');
    const folder = findWorkspaceFolderForPath(mixedCase);
    assert.ok(folder);
    assert.strictEqual(folder?.name, 'folderB');
  });
});



