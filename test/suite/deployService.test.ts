import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';
import {
  configurationTreeReadonlyGlob,
  DeployService,
  listDeployTargetLabels,
  readDeployMode,
  readDeployPrecheckXmlBeforeImportSetting,
  resolveConfigurationXmlDirectory,
  resolveDeployTargetsForBinding,
  vscodeSupportsDeployReadonlyLock,
} from '../../src/bindings/deployService';
import type { ConfigurationBinding } from '../../src/bindings/models/configurationBinding';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import type { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';
import { resetIbcmdServiceSingletonForTests } from '../../src/services/ibcmd/ibcmdServiceSingleton';
import { MetadataType } from '../../src/models/treeNode';
import type { TreeNode } from '../../src/models/treeNode';
import type { IbcmdInfobaseOperationResult } from '../../src/services/ibcmd/ibcmdInfobaseOperationResult';
import type { IncrementalImportParams } from '../../src/infobases/infobaseConfigCommands';

function fixtureSmallRoot(): string {
  return path.resolve(__dirname, '../fixtures/matrix/small');
}

function baseBinding(overrides: Partial<ConfigurationBinding> = {}): ConfigurationBinding {
  return {
    workspaceFolder: 'ws',
    configRelativePath: 'Configuration.xml',
    infobaseIds: [],
    massDeployment: false,
    ...overrides,
  };
}

function fileEntry(id: string, name: string, filePath: string): InfobaseEntry {
  return {
    id,
    name,
    type: 'file',
    filePath,
    hasStoredPassword: false,
    createdAt: '2020-01-01T00:00:00.000Z',
  };
}

function webEntry(id: string, name: string): InfobaseEntry {
  return {
    id,
    name,
    type: 'web',
    webUrl: 'http://localhost',
    hasStoredPassword: false,
    createdAt: '2020-01-01T00:00:00.000Z',
  };
}

const mockStorage = {
  async readPasswordSecret(): Promise<string | undefined> {
    return undefined;
  },
} as unknown as InfobaseStorageService;

function rmDirQuiet(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

suite('deployService readDeployMode', () => {
  setup(() => {
    resetVscodeTestState();
  });
  teardown(() => {
    resetVscodeTestState();
  });

  test('defaults to copy when setting absent', () => {
    assert.strictEqual(readDeployMode(), 'copy');
  });

  test('returns block when deploy.mode is block', () => {
    vscodeTestState.workspaceConfig['deploy.mode'] = 'block';
    assert.strictEqual(readDeployMode(), 'block');
  });

  test('unknown value falls back to copy', () => {
    vscodeTestState.workspaceConfig['deploy.mode'] = 'mirror';
    assert.strictEqual(readDeployMode(), 'copy');
  });

  test('explicit copy setting returns copy', () => {
    vscodeTestState.workspaceConfig['deploy.mode'] = 'copy';
    assert.strictEqual(readDeployMode(), 'copy');
  });
});

suite('deployService readDeployPrecheckXmlBeforeImportSetting', () => {
  setup(() => {
    resetVscodeTestState();
  });
  teardown(() => {
    resetVscodeTestState();
  });

  test('defaults to false', () => {
    assert.strictEqual(readDeployPrecheckXmlBeforeImportSetting(), false);
  });

  test('returns true when enabled in settings', () => {
    vscodeTestState.workspaceConfig['deploy.precheckXmlBeforeImport'] = true;
    assert.strictEqual(readDeployPrecheckXmlBeforeImportSetting(), true);
  });
});

suite('deployService vscodeSupportsDeployReadonlyLock', () => {
  setup(() => {
    resetVscodeTestState();
  });
  teardown(() => {
    resetVscodeTestState();
  });

  test('false when version empty (stub / unknown)', () => {
    vscodeTestState.vscodeVersion = undefined;
    assert.strictEqual(vscodeSupportsDeployReadonlyLock(), false);
  });

  test('false below 1.88', () => {
    vscodeTestState.vscodeVersion = '1.87.2';
    assert.strictEqual(vscodeSupportsDeployReadonlyLock(), false);
  });

  test('true at 1.88.0', () => {
    vscodeTestState.vscodeVersion = '1.88.0';
    assert.strictEqual(vscodeSupportsDeployReadonlyLock(), true);
  });

  test('true for 2.x', () => {
    vscodeTestState.vscodeVersion = '2.0.0';
    assert.strictEqual(vscodeSupportsDeployReadonlyLock(), true);
  });

  test('true for two-part semver 1.88 (no patch)', () => {
    vscodeTestState.vscodeVersion = '1.88';
    assert.strictEqual(vscodeSupportsDeployReadonlyLock(), true);
  });

  test('false when version string does not start with major.minor digits', () => {
    vscodeTestState.vscodeVersion = 'dev-insiders';
    assert.strictEqual(vscodeSupportsDeployReadonlyLock(), false);
  });
});

suite('deployService configurationTreeReadonlyGlob', () => {
  test('root Configuration.xml maps to **', () => {
    assert.strictEqual(configurationTreeReadonlyGlob('Configuration.xml'), '**');
  });

  test('nested path maps to directory glob', () => {
    assert.strictEqual(
      configurationTreeReadonlyGlob('export/dump/Configuration.xml'),
      'export/dump/**',
    );
  });

  test('normalizes backslashes', () => {
    assert.strictEqual(configurationTreeReadonlyGlob('src\\cfg\\Configuration.xml'), 'src/cfg/**');
  });

  test('strips leading ./ before building nested glob', () => {
    assert.strictEqual(
      configurationTreeReadonlyGlob('./export/dump/Configuration.xml'),
      'export/dump/**',
    );
  });
});

suite('deployService resolveConfigurationXmlDirectory', () => {
  test('rejects empty relative path', () => {
    const r = resolveConfigurationXmlDirectory('/tmp', '  ');
    assert.strictEqual(r.ok, false);
    if (!r.ok) {
      assert.ok(r.message.includes('Не задан'));
    }
  });

  test('rejects path whose basename is not Configuration.xml', () => {
    const r = resolveConfigurationXmlDirectory('/tmp', 'src/ConfigDump.xml');
    assert.strictEqual(r.ok, false);
    if (!r.ok) {
      assert.ok(r.message.includes('Configuration.xml'));
    }
  });

  test('rejects missing Configuration.xml', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-cfg-'));
    try {
      const r = resolveConfigurationXmlDirectory(dir, 'Configuration.xml');
      assert.strictEqual(r.ok, false);
      if (!r.ok) {
        assert.ok(r.message.includes('не найден'));
      }
    } finally {
      rmDirQuiet(dir);
    }
  });

  test('resolves directory and xml path for existing file', () => {
    const root = fixtureSmallRoot();
    const r = resolveConfigurationXmlDirectory(root, 'Configuration.xml');
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.ok(fs.existsSync(r.configXml));
      assert.strictEqual(path.basename(r.configXml).toLowerCase(), 'configuration.xml');
      assert.strictEqual(path.dirname(r.configXml), path.resolve(root));
    }
  });

  test('normalizes backslashes in relative path', () => {
    const root = fixtureSmallRoot();
    const r = resolveConfigurationXmlDirectory(root, 'Configuration.xml'.replace(/\//g, '\\'));
    assert.strictEqual(r.ok, true);
  });

  test('resolves nested relative path to Configuration.xml', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-nested-'));
    try {
      const nested = path.join(root, 'export', 'dump');
      fs.mkdirSync(nested, { recursive: true });
      const xmlPath = path.join(nested, 'Configuration.xml');
      fs.writeFileSync(xmlPath, '<empty/>');
      const rel = path.join('export', 'dump', 'Configuration.xml').replace(/\\/g, '/');
      const r = resolveConfigurationXmlDirectory(root, rel);
      assert.strictEqual(r.ok, true);
      if (r.ok) {
        assert.strictEqual(path.normalize(r.sourceDir), path.normalize(nested));
        assert.strictEqual(path.normalize(r.configXml), path.normalize(xmlPath));
      }
    } finally {
      rmDirQuiet(root);
    }
  });
});

suite('deployService listDeployTargetLabels', () => {
  const cat = [
    fileEntry('f1', 'File one', 'C:\\1'),
    webEntry('w1', 'Web one'),
  ];

  test('single-target mode lists only first id', () => {
    const labels = listDeployTargetLabels(
      baseBinding({ infobaseIds: ['f1', 'w1'], massDeployment: false }),
      cat,
    );
    assert.strictEqual(labels.length, 1);
    assert.ok(labels[0]!.includes('File one'));
  });

  test('mass deployment lists all ids in order', () => {
    const labels = listDeployTargetLabels(
      baseBinding({ infobaseIds: ['f1', 'w1'], massDeployment: true }),
      cat,
    );
    assert.strictEqual(labels.length, 2);
    assert.ok(labels[0]!.includes('File one'));
    assert.ok(labels[1]!.includes('веб'));
  });

  test('missing catalog entry is reflected in label', () => {
    const labels = listDeployTargetLabels(
      baseBinding({ infobaseIds: ['missing-id'], massDeployment: true }),
      cat,
    );
    assert.strictEqual(labels.length, 1);
    assert.ok(labels[0]!.includes('не найдена'));
  });

  test('empty infobaseIds yields empty label list', () => {
    const labels = listDeployTargetLabels(baseBinding({ infobaseIds: [] }), cat);
    assert.deepStrictEqual(labels, []);
  });
});

suite('deployService resolveDeployTargetsForBinding', () => {
  const cat = [
    fileEntry('f1', 'File one', 'C:\\1'),
    fileEntry('f2', 'File two', 'C:\\2'),
    webEntry('w1', 'Web one'),
  ];
  const byId = new Map(cat.map((e) => [e.id, e] as const));

  test('massDeployment false yields only first resolvable non-web entry', () => {
    const { entries, skipped } = resolveDeployTargetsForBinding(
      baseBinding({ infobaseIds: ['f1', 'f2'], massDeployment: false }),
      byId,
    );
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0]!.id, 'f1');
    assert.strictEqual(skipped.length, 0);
  });

  test('massDeployment false: only first id is considered — missing first does not fall through to second', () => {
    const { entries, skipped } = resolveDeployTargetsForBinding(
      baseBinding({ infobaseIds: ['ghost', 'f1'], massDeployment: false }),
      byId,
    );
    assert.deepStrictEqual(entries, []);
    assert.strictEqual(skipped.length, 1);
    assert.strictEqual(skipped[0]!.infobaseId, 'ghost');
    assert.strictEqual(skipped[0]!.status, 'skipped');
  });

  test('unknown id becomes skipped, not in entries', () => {
    const { entries, skipped } = resolveDeployTargetsForBinding(
      baseBinding({ infobaseIds: ['nope'], massDeployment: true }),
      byId,
    );
    assert.strictEqual(entries.length, 0);
    assert.strictEqual(skipped.length, 1);
    assert.strictEqual(skipped[0]!.status, 'skipped');
    assert.ok(skipped[0]!.message.includes('каталоге'));
  });

  test('web infobase is skipped with stable message', () => {
    const { entries, skipped } = resolveDeployTargetsForBinding(
      baseBinding({ infobaseIds: ['w1'], massDeployment: true }),
      byId,
    );
    assert.strictEqual(entries.length, 0);
    assert.strictEqual(skipped.length, 1);
    assert.ok(skipped[0]!.message.includes('Веб-база'));
  });

  test('massDeployment true preserves order for file targets', () => {
    const { entries } = resolveDeployTargetsForBinding(
      baseBinding({ infobaseIds: ['f2', 'f1'], massDeployment: true }),
      byId,
    );
    assert.deepStrictEqual(
      entries.map((e) => e.id),
      ['f2', 'f1'],
    );
  });

  test('empty infobaseIds yields no entries and no skips', () => {
    const { entries, skipped } = resolveDeployTargetsForBinding(baseBinding({ infobaseIds: [] }), byId);
    assert.deepStrictEqual(entries, []);
    assert.deepStrictEqual(skipped, []);
  });

  test('mass deploy: unknown id then web then file preserves skip order and still imports file', () => {
    const { entries, skipped } = resolveDeployTargetsForBinding(
      baseBinding({ infobaseIds: ['ghost', 'w1', 'f1'], massDeployment: true }),
      byId,
    );
    assert.deepStrictEqual(
      skipped.map((s) => s.infobaseId),
      ['ghost', 'w1'],
    );
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0]!.id, 'f1');
  });
});

suite('DeployService.deployBinding', () => {
  teardown(() => {
    resetIbcmdServiceSingletonForTests();
    resetVscodeTestState();
  });

  test('returns configuration error without calling ibcmd when xml path invalid', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-miss-'));
    try {
      const svc = new DeployService();
      const progress: { messages: string[]; increments: number[] } = { messages: [], increments: [] };
      const summary = await svc.deployBinding({
        binding: baseBinding({ configRelativePath: 'Configuration.xml' }),
        workspaceFolderRoot: dir,
        storage: mockStorage,
        catalog: [fileEntry('f1', 'A', path.join(dir, 'x.1cd'))],
        progress: {
          report(v) {
            if (v.message) {
              progress.messages.push(v.message);
            }
            if (v.increment !== undefined) {
              progress.increments.push(v.increment);
            }
          },
        },
        token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });
      assert.strictEqual(summary.errorCount, 1);
      assert.strictEqual(summary.successCount, 0);
      assert.strictEqual(summary.results[0]!.status, 'error');
      assert.strictEqual(progress.messages.length, 0);
      const tail = vscodeTestState.outputChannelLines.filter((l) => l.includes('[раскатка]'));
      assert.ok(tail.some((l) => l.includes('Итого:')));
    } finally {
      rmDirQuiet(dir);
    }
  });

  test('returns error when ibcmd executable cannot be resolved', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-ibcmd-miss-'));
    const missing = path.join(parent, 'ibcmd-absent');
    try {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = missing;
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
      resetIbcmdServiceSingletonForTests();

      const svc = new DeployService();
      const root = fixtureSmallRoot();
      const summary = await svc.deployBinding({
        binding: baseBinding(),
        workspaceFolderRoot: root,
        storage: mockStorage,
        catalog: [fileEntry('f1', 'A', path.join(root, 'dummy.1cd'))],
        progress: { report: () => undefined },
        token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });
      assert.strictEqual(summary.errorCount, 1);
      assert.ok(summary.results[0]!.message.includes('ibcmd'));
      assert.ok(vscodeTestState.outputChannelLines.some((l) => l.includes('Итого:')));
    } finally {
      rmDirQuiet(parent);
    }
  });

  test('all-web binding yields only skips and zero imports', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    resetIbcmdServiceSingletonForTests();

    const svc = new DeployService();
    const root = fixtureSmallRoot();
    const summary = await svc.deployBinding({
      binding: baseBinding({
        infobaseIds: ['w1', 'w2'],
        massDeployment: true,
      }),
      workspaceFolderRoot: root,
      storage: mockStorage,
      catalog: [webEntry('w1', 'W1'), webEntry('w2', 'W2')],
      progress: { report: () => undefined },
      token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
    });
    assert.strictEqual(summary.successCount, 0);
    assert.strictEqual(summary.errorCount, 0);
    assert.strictEqual(summary.skippedCount, 2);
    assert.strictEqual(summary.cancelledMidChain, false);
    assert.ok(vscodeTestState.outputChannelLines.some((l) => l.includes('Итого:') && l.includes('пропущено')));
  });

  test('continues chain after import error (fake ibcmd)', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.timeout'] = 8000;
    resetIbcmdServiceSingletonForTests();

    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-chain-'));
    try {
      const ibPath = path.join(work, 'placeholder.1cd');
      fs.writeFileSync(ibPath, '');

      const svc = new DeployService();
      const root = fixtureSmallRoot();
      const summary = await svc.deployBinding({
        binding: baseBinding({
          infobaseIds: ['a', 'b'],
          massDeployment: true,
        }),
        workspaceFolderRoot: root,
        storage: mockStorage,
        catalog: [fileEntry('a', 'Alpha', ibPath), fileEntry('b', 'Beta', ibPath)],
        progress: { report: () => undefined },
        token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });
      assert.strictEqual(summary.successCount, 0);
      assert.strictEqual(summary.errorCount, 2);
      assert.strictEqual(summary.results.filter((r) => r.name === 'Alpha' && r.status === 'error').length, 1);
      assert.strictEqual(summary.results.filter((r) => r.name === 'Beta' && r.status === 'error').length, 1);
      const lines = vscodeTestState.outputChannelLines.filter((l) => l.startsWith('[раскатка]'));
      assert.ok(lines.some((l) => l.includes('Alpha') && l.includes('ошибка')));
      assert.ok(lines.some((l) => l.includes('Beta') && l.includes('ошибка')));
      assert.ok(lines.some((l) => l.includes('Итого:') && l.includes('ошибк')));
    } finally {
      rmDirQuiet(work);
    }
  });

  test('cancellation before run writes Итого with mid-chain tail', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    resetIbcmdServiceSingletonForTests();

    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-cancel-tail-'));
    try {
      const ibPath = path.join(work, 'p.1cd');
      fs.writeFileSync(ibPath, '');

      const svc = new DeployService();
      const root = fixtureSmallRoot();
      await svc.deployBinding({
        binding: baseBinding({
          infobaseIds: ['a', 'b'],
          massDeployment: true,
        }),
        workspaceFolderRoot: root,
        storage: mockStorage,
        catalog: [fileEntry('a', 'Alpha', ibPath), fileEntry('b', 'Beta', ibPath)],
        progress: { report: () => undefined },
        token: { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });
      const itogo = vscodeTestState.outputChannelLines.find((l) => l.includes('[раскатка] Итого:'));
      assert.ok(itogo?.includes('Часть баз пропущена'));
    } finally {
      rmDirQuiet(work);
    }
  });

  test('cancellation before run skips all targets and sets cancelledMidChain', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    resetIbcmdServiceSingletonForTests();

    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-cancel-'));
    try {
      const ibPath = path.join(work, 'p.1cd');
      fs.writeFileSync(ibPath, '');

      const svc = new DeployService();
      const root = fixtureSmallRoot();
      const summary = await svc.deployBinding({
        binding: baseBinding({
          infobaseIds: ['a', 'b'],
          massDeployment: true,
        }),
        workspaceFolderRoot: root,
        storage: mockStorage,
        catalog: [fileEntry('a', 'Alpha', ibPath), fileEntry('b', 'Beta', ibPath)],
        progress: { report: () => undefined },
        token: { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });
      assert.strictEqual(summary.cancelledMidChain, true);
      assert.strictEqual(summary.successCount, 0);
      assert.strictEqual(summary.errorCount, 0);
      assert.strictEqual(summary.skippedCount, 2);
      assert.ok(summary.results.every((r) => r.status === 'skipped'));
    } finally {
      rmDirQuiet(work);
    }
  });

  test('empty infobaseIds with valid xml: zero totals and Итого line', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    resetIbcmdServiceSingletonForTests();

    const svc = new DeployService();
    const root = fixtureSmallRoot();
    const summary = await svc.deployBinding({
      binding: baseBinding({ infobaseIds: [], massDeployment: false }),
      workspaceFolderRoot: root,
      storage: mockStorage,
      catalog: [],
      progress: { report: () => undefined },
      token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
    });
    assert.strictEqual(summary.successCount, 0);
    assert.strictEqual(summary.errorCount, 0);
    assert.strictEqual(summary.skippedCount, 0);
    assert.ok(vscodeTestState.outputChannelLines.some((l) => l.includes('[раскатка] Итого:')));
  });

  test('single-target mode skips when only first id is web', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    resetIbcmdServiceSingletonForTests();

    const svc = new DeployService();
    const root = fixtureSmallRoot();
    const summary = await svc.deployBinding({
      binding: baseBinding({
        infobaseIds: ['w1', 'f1'],
        massDeployment: false,
      }),
      workspaceFolderRoot: root,
      storage: mockStorage,
      catalog: [webEntry('w1', 'WebOnly'), fileEntry('f1', 'File', path.join(root, 'z.1cd'))],
      progress: { report: () => undefined },
      token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
    });
    assert.strictEqual(summary.successCount, 0);
    assert.strictEqual(summary.errorCount, 0);
    assert.strictEqual(summary.skippedCount, 1);
    assert.ok(summary.results[0]!.message.includes('Веб-база'));
  });

  test('reports progress increment per target', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.timeout'] = 8000;
    resetIbcmdServiceSingletonForTests();

    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-prog-'));
    try {
      const ibPath = path.join(work, 'p.1cd');
      fs.writeFileSync(ibPath, '');

      const svc = new DeployService();
      const root = fixtureSmallRoot();
      const increments: number[] = [];
      await svc.deployBinding({
        binding: baseBinding({ infobaseIds: ['a', 'b'], massDeployment: true }),
        workspaceFolderRoot: root,
        storage: mockStorage,
        catalog: [fileEntry('a', 'Alpha', ibPath), fileEntry('b', 'Beta', ibPath)],
        progress: {
          report(v) {
            if (v.increment !== undefined) {
              increments.push(v.increment);
            }
          },
        },
        token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });
      assert.deepStrictEqual(increments, [50, 50]);
    } finally {
      rmDirQuiet(work);
    }
  });

  test('precheck gate disabled: deploy does not call preflight runner', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    vscodeTestState.workspaceConfig['deploy.precheckXmlBeforeImport'] = false;
    resetIbcmdServiceSingletonForTests();

    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-nogate-'));
    try {
      const ibPath = path.join(work, 'p.1cd');
      fs.writeFileSync(ibPath, '');
      let calls = 0;
      const svc = new DeployService({
        runXmlPreflight: async () => {
          calls += 1;
          return { ok: true, message: 'ok', durationMs: 1 };
        },
      });
      const root = fixtureSmallRoot();
      await svc.deployBinding({
        binding: baseBinding({ infobaseIds: ['a'], massDeployment: false }),
        workspaceFolderRoot: root,
        storage: mockStorage,
        catalog: [fileEntry('a', 'Alpha', ibPath)],
        progress: { report: () => undefined },
        token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });
      assert.strictEqual(calls, 0);
    } finally {
      rmDirQuiet(work);
    }
  });

  test('precheck gate enabled and failed: blocks deploy and skips rest', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    vscodeTestState.workspaceConfig['deploy.precheckXmlBeforeImport'] = true;
    resetIbcmdServiceSingletonForTests();

    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-gatefail-'));
    try {
      const ibPath = path.join(work, 'p.1cd');
      fs.writeFileSync(ibPath, '');
      let calls = 0;
      const svc = new DeployService({
        runXmlPreflight: async () => {
          calls += 1;
          return { ok: false, message: 'bad xml', durationMs: 10, code: 'IMPORT_FAILED' };
        },
      });
      const root = fixtureSmallRoot();
      const summary = await svc.deployBinding({
        binding: baseBinding({ infobaseIds: ['a', 'b'], massDeployment: true }),
        workspaceFolderRoot: root,
        storage: mockStorage,
        catalog: [fileEntry('a', 'Alpha', ibPath), fileEntry('b', 'Beta', ibPath)],
        progress: { report: () => undefined },
        token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });
      assert.strictEqual(calls, 1);
      assert.strictEqual(summary.errorCount, 1);
      assert.strictEqual(summary.skippedCount, 1);
      assert.ok(summary.results[0]!.message.includes('Preflight XML'));
    } finally {
      rmDirQuiet(work);
    }
  });

  test('copy mode logs snapshot line and completes (fake ibcmd)', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.timeout'] = 8000;
    vscodeTestState.workspaceConfig['deploy.mode'] = 'copy';
    resetIbcmdServiceSingletonForTests();

    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-copy-'));
    try {
      const ibPath = path.join(work, 'p.1cd');
      fs.writeFileSync(ibPath, '');

      const svc = new DeployService();
      const root = fixtureSmallRoot();
      await svc.deployBinding({
        binding: baseBinding({ infobaseIds: ['ib1'], massDeployment: false }),
        workspaceFolderRoot: root,
        storage: mockStorage,
        catalog: [fileEntry('ib1', 'One', ibPath)],
        progress: { report: () => undefined },
        token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });
      assert.ok(
        vscodeTestState.outputChannelLines.some((l) => l.includes('Режим copy') && l.includes('снимок')),
      );
    } finally {
      rmDirQuiet(work);
    }
  });

  test('block mode without VS 1.88+ logs fallback and skips readonlyInclude', async () => {
    vscodeTestState.vscodeVersion = '1.87.0';
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.timeout'] = 8000;
    vscodeTestState.workspaceConfig['deploy.mode'] = 'block';
    vscodeTestState.workspaceConfig.readonlyInclude = { 'keep/**': true };
    resetIbcmdServiceSingletonForTests();

    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-block-old-'));
    try {
      const ibPath = path.join(work, 'p.1cd');
      fs.writeFileSync(ibPath, '');

      const svc = new DeployService();
      const root = fixtureSmallRoot();
      await svc.deployBinding({
        binding: baseBinding({ infobaseIds: ['ib1'], massDeployment: false }),
        workspaceFolderRoot: root,
        storage: mockStorage,
        catalog: [fileEntry('ib1', 'One', ibPath)],
        progress: { report: () => undefined },
        token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });
      assert.ok(
        vscodeTestState.outputChannelLines.some(
          (l) => l.includes('Режим block') && l.includes('недоступна'),
        ),
      );
      assert.deepStrictEqual(vscodeTestState.workspaceConfig.readonlyInclude, { 'keep/**': true });
    } finally {
      rmDirQuiet(work);
    }
  });

  test('block mode when readonlyInclude update throws logs fallback and leaves prior map', async () => {
    vscodeTestState.vscodeVersion = '1.90.0';
    vscodeTestState.filesReadonlyIncludeUpdateThrows = true;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.timeout'] = 8000;
    vscodeTestState.workspaceConfig['deploy.mode'] = 'block';
    vscodeTestState.workspaceConfig.readonlyInclude = { 'keep/**': true };
    resetIbcmdServiceSingletonForTests();

    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-block-updthrow-'));
    try {
      const ibPath = path.join(work, 'p.1cd');
      fs.writeFileSync(ibPath, '');

      const svc = new DeployService();
      const root = fixtureSmallRoot();
      await svc.deployBinding({
        binding: baseBinding({ infobaseIds: ['ib1'], massDeployment: false }),
        workspaceFolderRoot: root,
        storage: mockStorage,
        catalog: [fileEntry('ib1', 'One', ibPath)],
        progress: { report: () => undefined },
        token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });
      assert.ok(
        vscodeTestState.outputChannelLines.some(
          (l) => l.includes('Режим block') && l.includes('недоступна'),
        ),
      );
      assert.deepStrictEqual(vscodeTestState.workspaceConfig.readonlyInclude, { 'keep/**': true });
    } finally {
      rmDirQuiet(work);
    }
  });

  test('block mode on 1.88+ merges readonlyInclude and restores after deploy', async () => {
    vscodeTestState.vscodeVersion = '1.90.0';
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.timeout'] = 8000;
    vscodeTestState.workspaceConfig['deploy.mode'] = 'block';
    vscodeTestState.workspaceConfig.readonlyInclude = { 'keep/**': true };
    resetIbcmdServiceSingletonForTests();

    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-block-new-'));
    try {
      const ibPath = path.join(work, 'p.1cd');
      fs.writeFileSync(ibPath, '');

      const svc = new DeployService();
      const root = fixtureSmallRoot();
      await svc.deployBinding({
        binding: baseBinding({ infobaseIds: ['ib1'], massDeployment: false }),
        workspaceFolderRoot: root,
        storage: mockStorage,
        catalog: [fileEntry('ib1', 'One', ibPath)],
        progress: { report: () => undefined },
        token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });
      assert.ok(
        vscodeTestState.outputChannelLines.some(
          (l) => l.includes('Режим block') && l.includes('readonlyInclude'),
        ),
      );
      assert.deepStrictEqual(vscodeTestState.workspaceConfig.readonlyInclude, { 'keep/**': true });
    } finally {
      rmDirQuiet(work);
    }
  });

  test('block mode does not log copy snapshot line', async () => {
    vscodeTestState.vscodeVersion = '1.90.0';
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.timeout'] = 8000;
    vscodeTestState.workspaceConfig['deploy.mode'] = 'block';
    resetIbcmdServiceSingletonForTests();

    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-nocopylog-'));
    try {
      const ibPath = path.join(work, 'p.1cd');
      fs.writeFileSync(ibPath, '');

      const svc = new DeployService();
      const root = fixtureSmallRoot();
      await svc.deployBinding({
        binding: baseBinding({ infobaseIds: ['ib1'], massDeployment: false }),
        workspaceFolderRoot: root,
        storage: mockStorage,
        catalog: [fileEntry('ib1', 'One', ibPath)],
        progress: { report: () => undefined },
        token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });
      assert.ok(!vscodeTestState.outputChannelLines.some((l) => l.includes('Режим copy')));
    } finally {
      rmDirQuiet(work);
    }
  });
});

suite('deploySelectedObjects: supportMode locked retry', () => {
  teardown(() => {
    resetIbcmdServiceSingletonForTests();
    resetVscodeTestState();
  });

  function makeNode(filePath: string, name: string = 'Foo'): TreeNode {
    return {
      id: `test-node-${name}`,
      name,
      type: MetadataType.CommonModule,
      properties: {},
      filePath,
    };
  }

  function successResult(): IbcmdInfobaseOperationResult {
    return { status: 'success', exitCode: 0, userMessage: 'Операция завершена успешно.', logExcerpt: '' };
  }

  function lockedErrorResult(objectName: string = 'Foo'): IbcmdInfobaseOperationResult {
    return {
      status: 'error',
      exitCode: 1,
      userMessage: 'Ошибка выполнения операции (см. вывод ibcmd).',
      logExcerpt: `редактирование объекта метаданных CommonModule.${objectName} запрещено!`,
      lockedObjects: [{ kind: 'CommonModule', name: objectName, fullName: `CommonModule.${objectName}` }],
    };
  }

  /**
   * Creates a temp configRoot with CommonModules/Foo.xml + Bar.xml so
   * collectFilesForSelection has real files to walk.
   */
  function setupConfigRoot(work: string): { configRoot: string; fooXml: string; barXml: string } {
    const configRoot = path.join(work, 'cfg');
    const modDir = path.join(configRoot, 'CommonModules');
    fs.mkdirSync(modDir, { recursive: true });
    // Write Configuration.xml (required by resolveConfigurationXmlDirectory)
    fs.writeFileSync(path.join(configRoot, 'Configuration.xml'), '<Configuration/>');
    const fooXml = path.join(modDir, 'Foo.xml');
    const barXml = path.join(modDir, 'Bar.xml');
    fs.writeFileSync(fooXml, '<CommonModule/>');
    fs.writeFileSync(barXml, '<CommonModule/>');
    return { configRoot, fooXml, barXml };
  }

  function makeSvc(
    runIncrementalImport: (p: IncrementalImportParams) => Promise<IbcmdInfobaseOperationResult>,
  ): DeployService {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    resetIbcmdServiceSingletonForTests();
    return new DeployService({ runIncrementalImport });
  }

  test('retry without locked: second call made with filtered files, result success', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-locked-retry-'));
    try {
      const ibPath = path.join(work, 'p.1cd');
      fs.writeFileSync(ibPath, '');
      const { configRoot, fooXml, barXml } = setupConfigRoot(work);

      const calls: Array<{ relativeFiles: readonly string[] }> = [];
      const svc = makeSvc(async (p) => {
        calls.push({ relativeFiles: p.relativeFiles });
        if (calls.length === 1) {
          return lockedErrorResult('Foo');
        }
        return successResult();
      });

      vscodeTestState.warningMessageReturnQueue.push('Пропустить залоченные и повторить');

      // Both Foo and Bar nodes selected; only Foo is locked
      const nodes = [makeNode(fooXml, 'Foo'), makeNode(barXml, 'Bar')];
      const summary = await svc.deploySelectedObjects({
        binding: baseBinding({ infobaseIds: ['f1'], massDeployment: false }),
        workspaceFolderRoot: configRoot,
        storage: mockStorage,
        catalog: [fileEntry('f1', 'TestBase', ibPath)],
        selectedNodes: nodes,
        progress: { report: () => undefined },
        token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });

      assert.strictEqual(calls.length, 2, 'second call must be made');
      assert.ok(
        calls[1]!.relativeFiles.every((f) => !f.toLowerCase().startsWith('commonmodules/foo')),
        'second call must not contain locked file',
      );
      assert.ok(
        calls[1]!.relativeFiles.some((f) => f.toLowerCase().startsWith('commonmodules/bar')),
        'second call must still have Bar',
      );
      assert.strictEqual(summary.successCount, 1);
      assert.ok(vscodeTestState.outputChannelLines.some((l) => l.includes('[support-mode]') && l.includes('Отфильтровано')));
    } finally {
      rmDirQuiet(work);
    }
  });

  test('cancel: second call not made', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-locked-cancel-'));
    try {
      const ibPath = path.join(work, 'p.1cd');
      fs.writeFileSync(ibPath, '');
      const { configRoot, fooXml } = setupConfigRoot(work);

      let callCount = 0;
      const svc = makeSvc(async () => {
        callCount += 1;
        return lockedErrorResult('Foo');
      });

      vscodeTestState.warningMessageReturnQueue.push(undefined);

      const summary = await svc.deploySelectedObjects({
        binding: baseBinding({ infobaseIds: ['f1'], massDeployment: false }),
        workspaceFolderRoot: configRoot,
        storage: mockStorage,
        catalog: [fileEntry('f1', 'TestBase', ibPath)],
        selectedNodes: [makeNode(fooXml, 'Foo')],
        progress: { report: () => undefined },
        token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });

      assert.strictEqual(callCount, 1, 'no retry on cancel');
      assert.strictEqual(summary.errorCount, 1);
    } finally {
      rmDirQuiet(work);
    }
  });

  test('all files locked: showErrorMessage called, no second import call', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-locked-all-'));
    try {
      const ibPath = path.join(work, 'p.1cd');
      fs.writeFileSync(ibPath, '');
      const { configRoot, fooXml } = setupConfigRoot(work);

      let callCount = 0;
      const svc = makeSvc(async () => {
        callCount += 1;
        return lockedErrorResult('Foo');
      });

      vscodeTestState.warningMessageReturnQueue.push('Пропустить залоченные и повторить');

      // Only Foo selected — all files belong to locked Foo
      await svc.deploySelectedObjects({
        binding: baseBinding({ infobaseIds: ['f1'], massDeployment: false }),
        workspaceFolderRoot: configRoot,
        storage: mockStorage,
        catalog: [fileEntry('f1', 'TestBase', ibPath)],
        selectedNodes: [makeNode(fooXml, 'Foo')],
        progress: { report: () => undefined },
        token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      });

      assert.strictEqual(callCount, 1, 'no second import when all files are locked');
      assert.ok(vscodeTestState.errorLog.some((m) => m.includes('Все выбранные файлы')));
    } finally {
      rmDirQuiet(work);
    }
  });
});
