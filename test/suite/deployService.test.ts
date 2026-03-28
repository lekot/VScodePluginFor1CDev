import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';
import {
  DeployService,
  listDeployTargetLabels,
  resolveConfigurationXmlDirectory,
  resolveDeployTargetsForBinding,
} from '../../src/bindings/deployService';
import type { ConfigurationBinding } from '../../src/bindings/models/configurationBinding';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import type { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';
import { resetIbcmdServiceSingletonForTests } from '../../src/services/ibcmd/ibcmdServiceSingleton';

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
    const r = resolveConfigurationXmlDirectory(dir, 'Configuration.xml');
    assert.strictEqual(r.ok, false);
    if (!r.ok) {
      assert.ok(r.message.includes('не найден'));
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
  });

  test('returns error when ibcmd executable cannot be resolved', async () => {
    const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), '1cv-ibcmd-miss-')), 'ibcmd-absent');
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
  });

  test('cancellation before run writes Итого with mid-chain tail', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    resetIbcmdServiceSingletonForTests();

    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-cancel-tail-'));
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
  });

  test('cancellation before run skips all targets and sets cancelledMidChain', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    resetIbcmdServiceSingletonForTests();

    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-cancel-'));
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
  });
});
