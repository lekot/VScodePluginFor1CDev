import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  applyReadonlyIncludeForDeploy,
  resetReadonlyIncludeDeployLocksForTests,
} from '../../src/bindings/deployService';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

suite('deployService applyReadonlyIncludeForDeploy (#186)', () => {
  const wsRoot = path.normalize('C:/mock/workspace');

  setup(() => {
    resetVscodeTestState();
    vscodeTestState.vscodeVersion = '1.88.0';
    resetReadonlyIncludeDeployLocksForTests?.();
  });

  teardown(() => {
    resetVscodeTestState();
    resetReadonlyIncludeDeployLocksForTests?.();
  });

  test('overlapping locks with different patterns do not prematurely unlock each other (#186)', async () => {
    const scope = vscode.Uri.file(wsRoot);
    const cfg = vscode.workspace.getConfiguration('files', scope);
    await cfg.update('readonlyInclude', { 'user/**': true }, vscode.ConfigurationTarget.WorkspaceFolder);

    // Deploy A starts on pattern A
    const lockA = await applyReadonlyIncludeForDeploy(wsRoot, 'cfgA/**');
    assert.ok(lockA, 'lockA should be acquired');

    let current = cfg.get<Record<string, boolean>>('readonlyInclude');
    assert.strictEqual(current?.['user/**'], true, 'user baseline preserved');
    assert.strictEqual(current?.['cfgA/**'], true, 'cfgA locked');

    // Deploy B starts concurrently on pattern B
    const lockB = await applyReadonlyIncludeForDeploy(wsRoot, 'cfgB/**');
    assert.ok(lockB, 'lockB should be acquired');

    current = cfg.get<Record<string, boolean>>('readonlyInclude');
    assert.strictEqual(current?.['user/**'], true, 'user baseline preserved');
    assert.strictEqual(current?.['cfgA/**'], true, 'cfgA still locked');
    assert.strictEqual(current?.['cfgB/**'], true, 'cfgB locked');

    // Deploy A finishes first and disposes its lock
    await lockA.dispose();

    current = cfg.get<Record<string, boolean>>('readonlyInclude');
    assert.strictEqual(current?.['cfgA/**'], undefined, 'cfgA should be unlocked after lockA dispose');
    assert.strictEqual(current?.['cfgB/**'], true, 'cfgB MUST REMAIN LOCKED while Deploy B is still active (#186)');
    assert.strictEqual(current?.['user/**'], true, 'user baseline preserved');

    // Deploy B finishes and disposes its lock
    await lockB.dispose();

    current = cfg.get<Record<string, boolean>>('readonlyInclude');
    assert.strictEqual(current?.['cfgA/**'], undefined, 'cfgA unlocked');
    assert.strictEqual(current?.['cfgB/**'], undefined, 'cfgB unlocked');
    assert.strictEqual(current?.['user/**'], true, 'user baseline restored after all deploys complete');
  });

  test('overlapping locks with same pattern track refcount properly (#186)', async () => {
    const scope = vscode.Uri.file(wsRoot);
    const cfg = vscode.workspace.getConfiguration('files', scope);
    await cfg.update('readonlyInclude', undefined, vscode.ConfigurationTarget.WorkspaceFolder);

    const lock1 = await applyReadonlyIncludeForDeploy(wsRoot, 'shared/**');
    const lock2 = await applyReadonlyIncludeForDeploy(wsRoot, 'shared/**');
    assert.ok(lock1 && lock2);

    let current = cfg.get<Record<string, boolean>>('readonlyInclude');
    assert.strictEqual(current?.['shared/**'], true);

    // Disposing first lock should keep pattern locked because second lock is still active
    await lock1.dispose();
    current = cfg.get<Record<string, boolean>>('readonlyInclude');
    assert.strictEqual(current?.['shared/**'], true, 'Pattern must remain locked with active refcount');

    // Disposing second lock clears pattern
    await lock2.dispose();
    current = cfg.get<Record<string, boolean>>('readonlyInclude');
    assert.strictEqual(current?.['shared/**'], undefined, 'Pattern must be unlocked when refcount reaches 0');
  });

  test('double dispose is idempotent and does not corrupt refcounts (#186 broad test)', async () => {
    const scope = vscode.Uri.file(wsRoot);
    const cfg = vscode.workspace.getConfiguration('files', scope);
    await cfg.update('readonlyInclude', undefined, vscode.ConfigurationTarget.WorkspaceFolder);

    const lock1 = await applyReadonlyIncludeForDeploy(wsRoot, 'shared/**');
    const lock2 = await applyReadonlyIncludeForDeploy(wsRoot, 'shared/**');
    assert.ok(lock1 && lock2);

    // Dispose lock1 twice
    await lock1.dispose();
    await lock1.dispose();

    // lock2 is still active, pattern must still be locked
    const current = cfg.get<Record<string, boolean>>('readonlyInclude');
    assert.strictEqual(current?.['shared/**'], true, 'Pattern must still be locked after redundant dispose on lock1');

    await lock2.dispose();
    const after = cfg.get<Record<string, boolean>>('readonlyInclude');
    assert.strictEqual(after?.['shared/**'], undefined);
  });

  test('locks on multiple distinct workspace roots are completely isolated (#186 broad test)', async () => {
    const root1 = path.normalize('C:/mock/ws1');
    const root2 = path.normalize('C:/mock/ws2');

    const lock1 = await applyReadonlyIncludeForDeploy(root1, 'pat1/**');
    const lock2 = await applyReadonlyIncludeForDeploy(root2, 'pat2/**');
    assert.ok(lock1 && lock2);

    const cfg1 = vscode.workspace.getConfiguration('files', vscode.Uri.file(root1));
    const cfg2 = vscode.workspace.getConfiguration('files', vscode.Uri.file(root2));

    assert.strictEqual(cfg1.get<Record<string, boolean>>('readonlyInclude')?.['pat1/**'], true);
    assert.strictEqual(cfg2.get<Record<string, boolean>>('readonlyInclude')?.['pat2/**'], true);

    await lock1.dispose();
    assert.strictEqual(cfg1.get<Record<string, boolean>>('readonlyInclude')?.['pat1/**'], undefined);
    assert.strictEqual(cfg2.get<Record<string, boolean>>('readonlyInclude')?.['pat2/**'], true, 'Root2 remains locked');

    await lock2.dispose();
    assert.strictEqual(cfg2.get<Record<string, boolean>>('readonlyInclude')?.['pat2/**'], undefined);
  });

  test('returns undefined when vscode version does not support readonly lock (#186 broad test)', async () => {
    vscodeTestState.vscodeVersion = '1.80.0';
    const lock = await applyReadonlyIncludeForDeploy(wsRoot, 'pat/**');
    assert.strictEqual(lock, undefined, 'Must return undefined on unsupported VS Code versions');
  });

  test('concurrent configuration edits made during deploy are preserved on dispose (#186 review)', async () => {
    const scope = vscode.Uri.file(wsRoot);
    const cfg = vscode.workspace.getConfiguration('files', scope);
    await cfg.update('readonlyInclude', { 'user/**': true }, vscode.ConfigurationTarget.WorkspaceFolder);

    // Deploy starts and acquires lock on 'deploy/**'
    const lock = await applyReadonlyIncludeForDeploy(wsRoot, 'deploy/**');
    assert.ok(lock);

    let current = cfg.get<Record<string, boolean>>('readonlyInclude');
    assert.strictEqual(current?.['user/**'], true);
    assert.strictEqual(current?.['deploy/**'], true);

    // Concurrently, while deploy is active, user adds 'new/**' to readonlyInclude
    const externalUpdate = { ...current, 'new/**': true };
    await cfg.update('readonlyInclude', externalUpdate, vscode.ConfigurationTarget.WorkspaceFolder);

    // Deploy finishes and disposes
    await lock.dispose();

    current = cfg.get<Record<string, boolean>>('readonlyInclude');
    assert.strictEqual(current?.['deploy/**'], undefined, 'deploy pattern must be removed');
    assert.strictEqual(current?.['user/**'], true, 'original baseline user pattern must be preserved');
    assert.strictEqual(current?.['new/**'], true, 'concurrently added pattern must NOT be wiped by baseline restoration (#186)');
  });
});
