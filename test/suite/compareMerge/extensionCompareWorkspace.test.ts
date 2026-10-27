import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'url';
import * as vscode from 'vscode';

import {
  executeConfigurationCompareCommand,
  resolveConfigurationCompareExtensionBaseRoots,
} from '../../../src/commands/configurationCompareCommands';
import {
  bindConfigurationCompareWebview,
} from '../../../src/compareMerge/configCompareProvider';
import type { ConfigCompareHostToWebviewMessage } from '../../../src/compareMerge/configCompareMessages';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import {
  ConfigurationCompareWorkspace,
  type ConfigurationCompareInfo,
  type ConfigurationCompareWorkspaceState,
  type ExecutableCandidateFactory,
  type WorkspaceSelectionMaterializer,
} from '../../../src/compareMerge/configurationCompareWorkspace';
import { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import type { CompareSource } from '../../../src/compareMerge/domain/compareContracts';
import {
  MISSING_TARGET_HASH,
  type MergeCandidate,
} from '../../../src/compareMerge/merge/mergePlanner';
import type { MergeExecutionResult } from '../../../src/compareMerge/merge/mergeExecutor';

const FIRST_NODE_ID = 'extension:Catalog:First';
const SECOND_NODE_ID = 'extension:Catalog:Second';
const REGISTRATION_NODE_ID = 'extension:registration';
const LEGACY_NODE_ID = 'legacy:row';

suite('Issue 336 configuration compare workspace and UI', () => {
  test('uses empty factories and one batch materialization for selected outputs and one root registration', async () => {
    const session = makeSession();
    const requested: string[][] = [];
    const state = makeExtensionState(session, [FIRST_NODE_ID, SECOND_NODE_ID], async (nodeIds) => {
      requested.push([...nodeIds]);
      return {
        ok: true,
        candidates: [
          makeFileWriteCandidate(FIRST_NODE_ID, path.join('Catalogs', 'First.xml')),
          makeFileWriteCandidate(SECOND_NODE_ID, path.join('Catalogs', 'Second.xml')),
          makeFileWriteCandidate(REGISTRATION_NODE_ID, 'Configuration.xml', {
            effect: 'replace',
            expectedOldHash: 'a'.repeat(64),
          }),
        ],
      };
    });
    const workspace = makeWorkspace(state);

    assert.strictEqual(state.candidateFactories.size, 0);
    assert.deepStrictEqual(workspace.listMergeableNodeIds(), [FIRST_NODE_ID, SECOND_NODE_ID]);
    assert.deepStrictEqual(
      workspace.selectNodeIds([SECOND_NODE_ID, 'forged-node']).executableNodeIds,
      [SECOND_NODE_ID]
    );

    const preview = await workspace.createPreviewForNodeIds([FIRST_NODE_ID, SECOND_NODE_ID]);

    assert.strictEqual(preview.ok, true, preview.ok ? undefined : JSON.stringify(preview));
    assert.deepStrictEqual(requested, [[FIRST_NODE_ID, SECOND_NODE_ID]]);
    if (preview.ok) {
      assert.strictEqual(preview.preview.operationCount, 3);
      assert.strictEqual(
        preview.preview.items.filter((item) => item.previewPath === 'Configuration.xml').length,
        1,
        'the selected batch should carry one combined root registration output'
      );
    }
    workspace.dispose();
  });

  test('keeps legacy factory selection and preview behavior when no materializer is supplied', async () => {
    const candidate = makeFileWriteCandidate(LEGACY_NODE_ID, 'Legacy.xml');
    let factoryCalls = 0;
    const factories = new Map<string, ExecutableCandidateFactory>([
      [LEGACY_NODE_ID, async () => {
        factoryCalls += 1;
        return { ok: true, candidate };
      }],
    ]);
    const workspace = makeWorkspace({
      session: makeSession(),
      projection: makeProjection([LEGACY_NODE_ID]),
      candidateFactories: factories,
    });

    assert.deepStrictEqual(workspace.listMergeableNodeIds(), [LEGACY_NODE_ID]);
    assert.deepStrictEqual(workspace.selectNodeIds([LEGACY_NODE_ID]).executableNodeIds, [LEGACY_NODE_ID]);
    const preview = await workspace.createPreviewForNodeIds([LEGACY_NODE_ID]);

    assert.strictEqual(preview.ok, true, preview.ok ? undefined : JSON.stringify(preview));
    assert.strictEqual(factoryCalls, 1);
    if (preview.ok) {
      assert.strictEqual(preview.preview.operationCount, 1);
    }
    workspace.dispose();
  });

  test('replaces materializer, mergeable ids, and comparison info together on refresh', async () => {
    const oldSession = makeSession('old-session');
    const newSession = makeSession('new-session');
    const refreshGate = deferred<ConfigurationCompareWorkspaceState>();
    const refreshStarted = deferred<void>();
    let oldMaterializations = 0;
    let newMaterializations = 0;
    const oldInfo = comparisonInfo('Target before refresh', 'Incoming before refresh');
    const newInfo = comparisonInfo('Target after refresh', 'Incoming after refresh');
    const oldState = makeExtensionState(oldSession, [FIRST_NODE_ID], async () => {
      oldMaterializations += 1;
      return { ok: true, candidates: [makeFileWriteCandidate(FIRST_NODE_ID, 'old.xml')] };
    }, oldInfo);
    const nextState = makeExtensionState(newSession, [SECOND_NODE_ID], async () => {
      newMaterializations += 1;
      return { ok: true, candidates: [makeFileWriteCandidate(SECOND_NODE_ID, 'new.xml')] };
    }, newInfo);
    const workspace = makeWorkspace(oldState, {
      refreshWorkspace: async () => {
        refreshStarted.resolve();
        return refreshGate.promise;
      },
    });

    const refreshPromise = workspace.refresh();
    await refreshStarted.promise;
    assert.strictEqual(workspace.payload.locked, true);
    assert.deepStrictEqual(workspace.listMergeableNodeIds(), [FIRST_NODE_ID]);
    assert.deepStrictEqual(workspace.payload.comparisonInfo, oldInfo);

    refreshGate.resolve(nextState);
    const refresh = await refreshPromise;
    const preview = await workspace.createPreviewForNodeIds([SECOND_NODE_ID]);

    assert.strictEqual(refresh.ok, true);
    assert.deepStrictEqual(workspace.listMergeableNodeIds(), [SECOND_NODE_ID]);
    assert.deepStrictEqual(workspace.payload.comparisonInfo, newInfo);
    assert.strictEqual(preview.ok, true, preview.ok ? undefined : JSON.stringify(preview));
    assert.strictEqual(oldMaterializations, 0);
    assert.strictEqual(newMaterializations, 1);
    workspace.dispose();
  });

  test('does not publish a deferred batch after the user changes selection', async () => {
    const batch = deferred<{ ok: true; candidates: readonly MergeCandidate[] }>();
    const entered = deferred<void>();
    const session = makeSession();
    const workspace = makeWorkspace(makeExtensionState(session, [FIRST_NODE_ID, SECOND_NODE_ID], async () => {
      entered.resolve();
      return batch.promise;
    }));

    const pendingPreview = workspace.createPreviewForNodeIds([FIRST_NODE_ID]);
    await entered.promise;
    workspace.selectNodeIds([SECOND_NODE_ID]);
    batch.resolve({ ok: true, candidates: [makeFileWriteCandidate(FIRST_NODE_ID, 'first.xml')] });

    const result = await pendingPreview;
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.diagnostics[0]?.code, 'CONFIG_COMPARE_SELECTION_STALE');
    }
    assert.strictEqual(session.state.previews.length, 0);
    workspace.dispose();
  });

  test('does not publish a deferred batch after refresh replaces the session', async () => {
    const batch = deferred<{ ok: true; candidates: readonly MergeCandidate[] }>();
    const entered = deferred<void>();
    const oldSession = makeSession('old-session');
    const refreshedSession = makeSession('refreshed-session');
    const oldWorkspaceState = makeExtensionState(oldSession, [FIRST_NODE_ID], async () => {
      entered.resolve();
      return batch.promise;
    });
    const newWorkspaceState = makeExtensionState(refreshedSession, [SECOND_NODE_ID], async () => ({
      ok: true,
      candidates: [makeFileWriteCandidate(SECOND_NODE_ID, 'second.xml')],
    }));
    const workspace = makeWorkspace(oldWorkspaceState, {
      refreshWorkspace: async () => newWorkspaceState,
    });

    const pendingPreview = workspace.createPreviewForNodeIds([FIRST_NODE_ID]);
    await entered.promise;
    assert.strictEqual((await workspace.refresh()).ok, true);
    batch.resolve({ ok: true, candidates: [makeFileWriteCandidate(FIRST_NODE_ID, 'first.xml')] });

    const result = await pendingPreview;
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.diagnostics[0]?.code, 'CONFIG_COMPARE_SELECTION_STALE');
    }
    assert.strictEqual(refreshedSession.state.previews.length, 0);
    workspace.dispose();
  });

  test('does not publish a deferred batch after workspace disposal', async () => {
    const batch = deferred<{ ok: true; candidates: readonly MergeCandidate[] }>();
    const entered = deferred<void>();
    const session = makeSession();
    const workspace = makeWorkspace(makeExtensionState(session, [FIRST_NODE_ID], async () => {
      entered.resolve();
      return batch.promise;
    }));

    const pendingPreview = workspace.createPreviewForNodeIds([FIRST_NODE_ID]);
    await entered.promise;
    workspace.dispose();
    batch.resolve({ ok: true, candidates: [makeFileWriteCandidate(FIRST_NODE_ID, 'first.xml')] });

    const result = await pendingPreview;
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.diagnostics[0]?.code, 'CONFIG_COMPARE_WORKSPACE_DISPOSED');
    }
    assert.strictEqual(session.state.previews.length, 0);
  });

  test('does not publish a deferred batch after execution locks the workspace', async () => {
    const pendingBatch = deferred<{ ok: true; candidates: readonly MergeCandidate[] }>();
    const materializationEntered = deferred<void>();
    const executeGate = deferred<MergeExecutionResult>();
    const executeEntered = deferred<void>();
    const session = makeSession();
    let materializationCount = 0;
    const state = makeExtensionState(session, [FIRST_NODE_ID], async () => {
      materializationCount += 1;
      if (materializationCount === 1) {
        return { ok: true, candidates: [makeFileWriteCandidate(FIRST_NODE_ID, 'first.xml')] };
      }
      materializationEntered.resolve();
      return pendingBatch.promise;
    });
    const workspace = makeWorkspace(state, {
      executeMerge: async () => {
        executeEntered.resolve();
        return executeGate.promise;
      },
    });

    const approvedPreview = await workspace.createPreviewForNodeIds([FIRST_NODE_ID]);
    assert.strictEqual(approvedPreview.ok, true);
    if (!approvedPreview.ok) {
      workspace.dispose();
      return;
    }
    assert.strictEqual(workspace.approvePreview(approvedPreview.preview.previewId).ok, true);

    const execution = workspace.executeApprovedPreview(approvedPreview.preview.previewId);
    await executeEntered.promise;
    const pendingPreview = workspace.createPreviewForNodeIds([FIRST_NODE_ID]);
    await materializationEntered.promise;
    executeGate.resolve({
      ...emptyExecutionResult(approvedPreview.preview.previewId),
      receipt: {
        status: 'recoveryRequired',
        code: 'RECOVERY_REQUIRED',
        message: 'Recovery required for test lock.',
        kind: 'configuration-compare-merge',
        resourcePath: 'target',
      } as any,
    });
    const executionResult = await execution;
    pendingBatch.resolve({ ok: true, candidates: [makeFileWriteCandidate(FIRST_NODE_ID, 'late.xml')] });

    const result = await pendingPreview;
    assert.strictEqual(executionResult.ok, false);
    assert.strictEqual(executionResult.locked, true);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.diagnostics[0]?.code, 'CONFIG_COMPARE_WORKSPACE_LOCKED');
    }
    assert.strictEqual(session.state.previews.length, 1, 'only the earlier approved preview may exist');
    workspace.dispose();
  });

  test('ignores role=base snapshots in side guards even when a base source is listed last', async () => {
    const session = makeSession('base-guard-session', true);
    const workspace = makeWorkspace(makeExtensionState(session, [FIRST_NODE_ID], async () => ({
      ok: true,
      candidates: [makeFileWriteCandidate(FIRST_NODE_ID, 'first.xml')],
    })));

    const preview = await workspace.createPreviewForNodeIds([FIRST_NODE_ID]);

    assert.strictEqual(preview.ok, true);
    const stored = session.state.previews[0];
    assert.deepStrictEqual(stored?.snapshotIds, {
      left: 'snapshot-left-1',
      right: 'snapshot-right-1',
    });
    assert.strictEqual(workspace.approvePreview('preview-1').ok, true);
    workspace.dispose();
  });

  test('redacts file-write bytes while previewing per-file paths, effects, and actual destructive operations', async () => {
    const candidates = [
      makeFileWriteCandidate(FIRST_NODE_ID, path.join('Catalogs', 'Created.xml')),
      makeFileWriteCandidate(SECOND_NODE_ID, path.join('Catalogs', 'Replaced.xml'), {
        effect: 'replace',
        expectedOldHash: 'a'.repeat(64),
        content: 'private captured bytes for replacement',
      }),
      makeFileDeleteCandidate(SECOND_NODE_ID, path.join('Catalogs', 'Removed.xml')),
    ];
    let executionCalls = 0;
    const workspace = makeWorkspace(makeExtensionState(makeSession(), [FIRST_NODE_ID, SECOND_NODE_ID], async () => ({
      ok: true,
      candidates,
    })), {
      executeMerge: async (input) => {
        executionCalls += 1;
        return emptyExecutionResult(input.preflight.previewId);
      },
      refreshWorkspace: async () => makeExtensionState(makeSession('after-execution'), [], async () => ({
        ok: true,
        candidates: [],
      })),
    });

    const preview = await workspace.createPreviewForNodeIds([FIRST_NODE_ID, SECOND_NODE_ID]);
    assert.strictEqual(preview.ok, true, preview.ok ? undefined : JSON.stringify(preview));
    if (!preview.ok) {
      workspace.dispose();
      return;
    }
    assert.strictEqual(preview.preview.destructiveCount, 2);
    assert.deepStrictEqual(
      preview.preview.items.map((item) => [item.previewPath, item.previewEffect, item.destructive === true]),
      [
        [normalizePreviewPath(path.join('Catalogs', 'Created.xml')), 'create', false],
        [normalizePreviewPath(path.join('Catalogs', 'Replaced.xml')), 'replace', true],
        [normalizePreviewPath(path.join('Catalogs', 'Removed.xml')), 'delete', true],
      ]
    );
    const serialized = JSON.stringify(preview.preview);
    assert.doesNotMatch(serialized, /private captured bytes|contentBase64|targetUri|expectedOldHash|newHash/);
    assert.strictEqual(workspace.approvePreview(preview.preview.previewId).ok, true);

    const rejected = await workspace.executeApprovedPreview(preview.preview.previewId);
    assert.strictEqual(rejected.ok, false);
    if (!rejected.ok) {
      assert.strictEqual(rejected.diagnostics[0]?.code, 'CONFIG_COMPARE_DESTRUCTIVE_CONFIRMATION_REQUIRED');
    }
    assert.strictEqual(executionCalls, 0);

    const accepted = await workspace.executeApprovedPreview(preview.preview.previewId, {
      destructiveConfirmed: true,
    });
    assert.strictEqual(accepted.ok, true);
    assert.strictEqual(executionCalls, 1);
    workspace.dispose();
  });

  test('connects provider and actual webview DOM through selection, preview, approval, and destructive execute', async () => {
    const secret = 'private-extension-sidecar-bytes';
    const nodeId = FIRST_NODE_ID;
    const contentBase64 = Buffer.from(secret, 'utf8').toString('base64');
    const materializedSelections: string[][] = [];
    const session = makeSession('webview-session');
    const state = makeExtensionState(session, [nodeId], async (nodeIds) => {
      materializedSelections.push([...nodeIds]);
      return {
        ok: true,
        candidates: [makeFileWriteCandidate(nodeId, path.join('Catalogs', 'First.xml'), {
          content: secret,
          effect: 'replace',
          expectedOldHash: 'a'.repeat(64),
        })],
      };
    }, comparisonInfo('Тестовая цель CFE', 'Тестовый источник CF'));
    const workspace = makeWorkspace(state, {
      executeMerge: async (input) => emptyExecutionResult(input.preflight.previewId),
      refreshWorkspace: async () => makeExtensionState(
        makeSession('after-webview-execute'),
        [nodeId],
        async () => ({ ok: true, candidates: [] }),
        comparisonInfo('Тестовая цель CFE', 'Тестовый источник CF')
      ),
    });

    const inbound: unknown[] = [];
    const outbound: ConfigCompareHostToWebviewMessage[] = [];
    const pendingHandlers: Promise<void>[] = [];
    const pendingWindowMessages: ConfigCompareHostToWebviewMessage[] = [];
    let receiveMessage: ((message: unknown) => Promise<void>) | undefined;
    let dom: JSDOM | undefined;
    let confirmCalls = 0;
    const disposable = { dispose() {} };
    const webview = {
      cspSource: 'vscode-webview-resource:',
      html: '',
      onDidReceiveMessage(listener: (message: unknown) => Promise<void>) {
        receiveMessage = listener;
        return disposable;
      },
      async postMessage(message: ConfigCompareHostToWebviewMessage) {
        outbound.push(JSON.parse(JSON.stringify(message)) as ConfigCompareHostToWebviewMessage);
        if (dom) {
          dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message }));
        } else {
          pendingWindowMessages.push(message);
        }
        return true;
      },
    };
    const panel = {
      webview,
      onDidDispose() {
        return disposable;
      },
    };
    const binding = bindConfigurationCompareWebview(panel as any, workspace, 'Extension compare');

    dom = new JSDOM(webview.html, {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window) {
        (window as any).acquireVsCodeApi = () => ({
          postMessage(message: unknown) {
            inbound.push(JSON.parse(JSON.stringify(message)) as unknown);
            if (receiveMessage) {
              pendingHandlers.push(receiveMessage(message));
            }
          },
        });
        (window as any).confirm = () => {
          confirmCalls += 1;
          return true;
        };
      },
    });
    for (const message of pendingWindowMessages.splice(0)) {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message }));
    }
    await drainHandlers(pendingHandlers);

    const document = dom.window.document;
    assert.strictEqual(document.getElementById('comparisonSides')?.textContent, 'Приёмник (слева) ← Источник (справа)');
    assert.match(document.getElementById('comparisonInfo')?.textContent ?? '', /Тестовая цель CFE/);
    assert.match(document.getElementById('comparisonInfo')?.textContent ?? '', /Тестовый источник CF/);
    assert.match(document.getElementById('comparisonInfo')?.textContent ?? '', /Динамические BSL-ссылки проверяются ограниченно/);
    assert.strictEqual(document.getElementById('strategyControls')?.classList.contains('hidden'), true);

    const checkbox = document.querySelector<HTMLInputElement>('#tree input[type="checkbox"]');
    assert.ok(checkbox);
    checkbox!.click();
    await drainHandlers(pendingHandlers);
    assert.deepStrictEqual(materializedSelections, []);
    const previewButton = document.getElementById('previewButton') as HTMLButtonElement;
    assert.strictEqual(previewButton.disabled, false);
    previewButton.click();
    await drainHandlers(pendingHandlers);

    assert.deepStrictEqual(materializedSelections, [[nodeId]]);
    const previewText = document.getElementById('preview')?.textContent ?? '';
    assert.strictEqual(previewText.includes(normalizePreviewPath(path.join('Catalogs', 'First.xml'))), true, JSON.stringify({
      previewText,
      notice: document.getElementById('notice')?.textContent,
      outbound,
    }));
    assert.match(previewText, /эффект: замена/);
    assert.doesNotMatch(previewText, new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(outbound), /contentBase64|targetUri|expectedOldHash|newHash/);
    assert.doesNotMatch(JSON.stringify(outbound), new RegExp(contentBase64));

    (document.getElementById('approveButton') as HTMLButtonElement).click();
    await drainHandlers(pendingHandlers);
    assert.strictEqual((document.getElementById('executeButton') as HTMLButtonElement).disabled, false);
    (document.getElementById('executeButton') as HTMLButtonElement).click();
    await drainHandlers(pendingHandlers);

    const executeMessage = inbound.find((message) =>
      (message as { type?: string }).type === 'executeMerge'
    ) as { previewId: string; destructiveConfirmed?: boolean } | undefined;
    assert.ok(executeMessage);
    assert.strictEqual(executeMessage?.destructiveConfirmed, true);
    assert.strictEqual(confirmCalls, 1);
    assert.ok(outbound.some((message) => message.type === 'mergeSuccess'));
    assert.match(document.getElementById('result')?.textContent ?? '', /Merge выполнен/);

    binding.dispose();
    workspace.dispose();
    dom.window.close();
  });
});

suite('Issue 336 CFE manifest base-root resolution', () => {
  test('resolves canonical CFE bases in both selected-target directions', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'issue336-manifest-'));
    try {
      const workspaceRoot = path.join(temporaryRoot, 'workspace');
      const baseRoot = path.join(workspaceRoot, 'base');
      const extensionRoot = path.join(workspaceRoot, 'extension');
      await fs.mkdir(baseRoot, { recursive: true });
      await fs.mkdir(extensionRoot, { recursive: true });
      await writeManifest(workspaceRoot, [{
        baseConfiguration: 'base',
        extensionConfiguration: 'extension',
        extensionName: 'SampleExtension',
      }]);
      const workspaceFolders = [workspaceFolder(workspaceRoot)];
      const extensionAlias = `${extensionRoot}${path.sep}..${path.sep}extension`;

      const cfeTarget = await resolveConfigurationCompareExtensionBaseRoots(
        extensionAlias,
        baseRoot,
        workspaceFolders as any
      );
      const cfTarget = await resolveConfigurationCompareExtensionBaseRoots(
        baseRoot,
        extensionAlias,
        workspaceFolders as any
      );

      assert.deepStrictEqual(cfeTarget, { left: await fs.realpath(baseRoot) });
      assert.deepStrictEqual(cfTarget, { right: await fs.realpath(baseRoot) });
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('propagates malformed workspace manifests instead of silently falling back', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'issue336-malformed-manifest-'));
    try {
      const workspaceRoot = path.join(temporaryRoot, 'workspace');
      const leftRoot = path.join(temporaryRoot, 'left');
      const rightRoot = path.join(temporaryRoot, 'right');
      await fs.mkdir(path.join(workspaceRoot, '.vscode'), { recursive: true });
      await fs.mkdir(leftRoot, { recursive: true });
      await fs.mkdir(rightRoot, { recursive: true });
      await fs.writeFile(path.join(workspaceRoot, '.vscode', 'cfe-projects.json'), '{"version":1,"projects":[', 'utf8');

      await assert.rejects(
        resolveConfigurationCompareExtensionBaseRoots(
          leftRoot,
          rightRoot,
          [workspaceFolder(workspaceRoot)] as any
        ),
        /Manifest CFE-проектов повреждён/
      );
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('rejects conflicting canonical extension-to-base relations across workspace folders', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'issue336-conflicting-manifest-'));
    try {
      const outerRoot = path.join(temporaryRoot, 'outer');
      const nestedRoot = path.join(outerRoot, 'nested');
      const extensionRoot = path.join(nestedRoot, 'extension');
      const outerBase = path.join(outerRoot, 'base-outer');
      const nestedBase = path.join(nestedRoot, 'base-inner');
      await Promise.all([
        fs.mkdir(extensionRoot, { recursive: true }),
        fs.mkdir(outerBase, { recursive: true }),
        fs.mkdir(nestedBase, { recursive: true }),
      ]);
      await writeManifest(outerRoot, [{
        baseConfiguration: 'base-outer',
        extensionConfiguration: 'nested/extension',
        extensionName: 'OuterExtension',
      }]);
      await writeManifest(nestedRoot, [{
        baseConfiguration: 'base-inner',
        extensionConfiguration: 'extension',
        extensionName: 'NestedExtension',
      }]);

      await assert.rejects(
        resolveConfigurationCompareExtensionBaseRoots(
          extensionRoot,
          outerBase,
          [workspaceFolder(outerRoot), workspaceFolder(nestedRoot)] as any
        ),
        /противоречащие связи/
      );
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('passes resolved manifest bases through the existing compare command input', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'issue336-command-manifest-'));
    try {
      const workspaceRoot = path.join(temporaryRoot, 'workspace');
      const baseRoot = path.join(workspaceRoot, 'base');
      const extensionRoot = path.join(workspaceRoot, 'extension');
      const rightRoot = path.join(temporaryRoot, 'right');
      await Promise.all([
        fs.mkdir(baseRoot, { recursive: true }),
        fs.mkdir(extensionRoot, { recursive: true }),
        fs.mkdir(rightRoot, { recursive: true }),
      ]);
      await writeManifest(workspaceRoot, [{
        baseConfiguration: 'base',
        extensionConfiguration: 'extension',
        extensionName: 'SampleExtension',
      }]);
      const buildInputs: unknown[] = [];
      const workspaceFoldersDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        configurable: true,
        enumerable: true,
        value: [workspaceFolder(workspaceRoot)],
        writable: true,
      });

      try {
        await executeConfigurationCompareCommand({
          context: { globalStorageUri: { fsPath: path.join(temporaryRoot, 'storage') } } as any,
          state: {
            treeDataProvider: {
              getConfigPathForNode: () => null,
              getConfigPath: () => extensionRoot,
            },
          } as any,
          pickRightRoot: async () => rightRoot,
          withCompareProgress: async (_title, task) => task(),
          buildCompare: async (input) => {
            buildInputs.push(input);
            return {
              projection: { root: { children: [] }, stats: { total: 0, different: 0, mergeable: 0 } },
              workspace: { id: 'test' },
            } as any;
          },
          showCompare: () => undefined as any,
        });
      } finally {
        if (workspaceFoldersDescriptor) {
          Object.defineProperty(vscode.workspace, 'workspaceFolders', workspaceFoldersDescriptor);
        } else {
          Reflect.deleteProperty(vscode.workspace, 'workspaceFolders');
        }
      }

      assert.strictEqual(buildInputs.length, 1);
      assert.deepStrictEqual((buildInputs[0] as any).extensionBaseRoots, {
        left: await fs.realpath(baseRoot),
      });
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

function makeWorkspace(
  state: ConfigurationCompareWorkspaceState,
  options: Partial<ConstructorParameters<typeof ConfigurationCompareWorkspace>[0]> = {}
): ConfigurationCompareWorkspace {
  return new ConfigurationCompareWorkspace({
    ...state,
    leftRootPath: path.resolve('workspace-target'),
    rightRootPath: path.resolve('workspace-source'),
    backupRootPath: path.resolve('workspace-backups'),
    createdAt: new Date('2026-10-27T10:00:00.000Z'),
    ...options,
  });
}

function makeExtensionState(
  session: CompareSession,
  mergeableNodeIds: readonly string[],
  materializeSelection: WorkspaceSelectionMaterializer,
  info = comparisonInfo('Целевая конфигурация', 'Входящая конфигурация')
): ConfigurationCompareWorkspaceState {
  return {
    session,
    projection: makeProjection(mergeableNodeIds),
    candidateFactories: new Map(),
    mergeableNodeIds,
    materializeSelection,
    comparisonInfo: info,
  };
}

function makeSession(sessionId = 'session-1', includeBase = false): CompareSession {
  const sources: CompareSource[] = [
    {
      sourceId: 'left-source',
      side: 'left',
      kind: 'workspace',
      displayName: 'Target',
      rootUri: pathToFileURL(path.resolve('compare-target')).toString(),
      writable: true,
    },
    {
      sourceId: 'right-source',
      side: 'right',
      kind: 'file',
      displayName: 'Incoming',
      rootUri: pathToFileURL(path.resolve('compare-source')).toString(),
      writable: false,
    },
  ];
  if (includeBase) {
    sources.push({
      sourceId: 'left-base-source',
      side: 'left',
      role: 'base',
      kind: 'workspace',
      displayName: 'Base of target',
      rootUri: pathToFileURL(path.resolve('compare-base')).toString(),
      writable: false,
    });
  }
  const session = CompareSession.create({
    sessionId,
    createdAt: '2026-10-27T10:00:00.000Z',
    sources,
  });
  session.registerSnapshot(snapshotContract('snapshot-left-1', 'left-source', 'left'));
  session.registerSnapshot(snapshotContract('snapshot-right-1', 'right-source', 'right'));
  if (includeBase) {
    session.registerSnapshot(snapshotContract('snapshot-left-base-1', 'left-base-source', 'left-base'));
  }
  return session;
}

function snapshotContract(snapshotId: string, sourceId: string, side: string) {
  return {
    snapshotId,
    sourceId,
    snapshotRoot: `file:///snapshots/${side}`,
    origin: `file:///${side}`,
    createdAt: '2026-10-27T10:00:00.000Z',
    retentionUntil: '2026-10-27T12:00:00.000Z',
    sourceRevision: `test:${side}`,
    readOnly: side !== 'left',
    cleanupPolicy: 'manual' as const,
    contentHash: `sha256:${side}`,
  };
}

function makeProjection(nodeIds: readonly string[]): { root: CompareTreeNode; stats: { total: number; different: number; mergeable: number } } {
  const children: CompareTreeNode[] = nodeIds.map((nodeId) => ({
    id: nodeId,
    label: nodeId,
    kind: nodeId === REGISTRATION_NODE_ID ? 'configurationRegistration' : 'metadataObject',
    status: 'changed',
    mergeable: true,
    mergeState: { state: 'ready' },
    children: [],
  }));
  return {
    root: {
      id: 'configCompare',
      label: 'Compare',
      kind: 'configCompare',
      status: 'changed',
      children,
    },
    stats: { total: children.length, different: children.length, mergeable: children.length },
  };
}

function makeFileWriteCandidate(
  nodeId: string,
  previewPath: string,
  options: { effect?: 'create' | 'replace'; expectedOldHash?: string; content?: string } = {}
): MergeCandidate {
  const content = options.content ?? `captured:${nodeId}:${previewPath}`;
  const contentBase64 = Buffer.from(content, 'utf8').toString('base64');
  const expectedOldHash = options.expectedOldHash ?? MISSING_TARGET_HASH;
  const effect = options.effect ?? 'create';
  return {
    kind: 'fileWrite',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId,
    targetUri: pathToFileURL(path.resolve('issue336-target', ...previewPath.split(/[\\/]/))).toString(),
    previewPath,
    previewEffect: effect,
    expectedOldHash,
    newHash: createHash('sha256').update(content, 'utf8').digest('hex'),
    fileWrite: {
      contentBase64,
      witnesses: [
        {
          sourceId: 'right-source',
          relativePath: 'Configuration.xml',
          expectedHash: 'b'.repeat(64),
          kind: 'file',
        },
      ],
    },
  };
}

function makeFileDeleteCandidate(nodeId: string, previewPath: string): MergeCandidate {
  const targetUri = pathToFileURL(path.resolve('issue336-target', ...previewPath.split(/[\\/]/))).toString();
  const expectedOldHash = 'c'.repeat(64);
  return {
    kind: 'fileDelete',
    sourceId: 'right-source',
    snapshotId: 'snapshot-right-1',
    nodeId,
    targetUri,
    previewPath,
    previewEffect: 'delete',
    expectedOldHash,
    fileOperation: {
      kind: 'fileDelete',
      targetPath: targetUri,
      expectedOldHash,
      destructive: true,
    },
  };
}

function normalizePreviewPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function comparisonInfo(targetLabel: string, sourceLabel: string): ConfigurationCompareInfo {
  return {
    mode: 'extension',
    targetLabel,
    sourceLabel,
    limitations: ['Динамические BSL-ссылки проверяются ограниченно.'],
  };
}

function emptyExecutionResult(previewId: string): MergeExecutionResult {
  return {
    previewId,
    approvedPreviewId: previewId,
    applied: [],
    skipped: [],
    failed: [],
    backupPaths: [],
    diagnostics: [],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function drainHandlers(pending: Promise<void>[]): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    await Promise.resolve();
    if (pending.length === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (pending.length === 0) {
        return;
      }
    }
    const batch = pending.splice(0);
    await Promise.all(batch);
  }
  assert.fail('Webview message handlers did not become idle.');
}

function workspaceFolder(root: string) {
  return { uri: { fsPath: root }, name: path.basename(root), index: 0 };
}

async function writeManifest(
  workspaceRoot: string,
  projects: readonly { baseConfiguration: string; extensionConfiguration: string; extensionName: string }[]
): Promise<void> {
  const vscodeDirectory = path.join(workspaceRoot, '.vscode');
  await fs.mkdir(vscodeDirectory, { recursive: true });
  await fs.writeFile(
    path.join(vscodeDirectory, 'cfe-projects.json'),
    JSON.stringify({ version: 1, projects }, null, 2),
    'utf8'
  );
}
