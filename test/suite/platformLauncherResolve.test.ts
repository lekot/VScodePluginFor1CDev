import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveLaunchExecutable } from '../../src/services/platformLauncher';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

suite('platformLauncher resolveLaunchExecutable', () => {
  setup(() => {
    resetVscodeTestState();
  });

  function baseEntry(): InfobaseEntry {
    return {
      id: 'e1',
      name: 'Demo',
      type: 'file',
      filePath: path.join(os.tmpdir(), 'demo-base'),
      hasStoredPassword: false,
      createdAt: '2020-01-01',
    };
  }

  test('returns explicit thick exe from settings when file exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '1c-plat-'));
    const thickName = process.platform === 'win32' ? '1cv8.exe' : '1cv8';
    const thickPath = path.join(dir, thickName);
    fs.writeFileSync(thickPath, '');
    vscodeTestState.workspaceConfig['1cMetadataTree.platform.path'] = thickPath;

    const exe = await resolveLaunchExecutable(baseEntry(), 'enterprise');
    assert.strictEqual(exe, thickPath);

    fs.rmSync(dir, { recursive: true, force: true });
    delete vscodeTestState.workspaceConfig['1cMetadataTree.platform.path'];
  });

  test('designer rejects thin client path from settings', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '1c-plat-'));
    const thinName = process.platform === 'win32' ? '1cv8c.exe' : '1cv8c';
    const thinPath = path.join(dir, thinName);
    fs.writeFileSync(thinPath, '');
    vscodeTestState.workspaceConfig['1cMetadataTree.platform.path'] = thinPath;

    const exe = await resolveLaunchExecutable(baseEntry(), 'designer');
    assert.strictEqual(exe, undefined);
    assert.ok(
      vscodeTestState.errorLog.some((m) => m.includes('Конфигуратор') && m.includes('толстый')),
      `expected designer error, got: ${JSON.stringify(vscodeTestState.errorLog)}`,
    );

    fs.rmSync(dir, { recursive: true, force: true });
    delete vscodeTestState.workspaceConfig['1cMetadataTree.platform.path'];
  });

  test('non-empty settings path that cannot be resolved shows error', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.platform.path'] = path.join(
      os.tmpdir(),
      'nonexistent-1cv8-path-xyz',
      '1cv8.exe',
    );

    const exe = await resolveLaunchExecutable(baseEntry(), 'enterprise');
    assert.strictEqual(exe, undefined);
    assert.ok(
      vscodeTestState.errorLog.some((m) => m.includes('не найден')),
      `expected not-found error, got: ${JSON.stringify(vscodeTestState.errorLog)}`,
    );
    delete vscodeTestState.workspaceConfig['1cMetadataTree.platform.path'];
  });

  test('resolves directory setting to bin thick client', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '1c-plat-'));
    const thickName = process.platform === 'win32' ? '1cv8.exe' : '1cv8';
    const binDir = path.join(dir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const thickPath = path.join(binDir, thickName);
    fs.writeFileSync(thickPath, '');
    vscodeTestState.workspaceConfig['1cMetadataTree.platform.path'] = dir;

    const exe = await resolveLaunchExecutable(baseEntry(), 'enterprise');
    assert.strictEqual(exe, thickPath);

    fs.rmSync(dir, { recursive: true, force: true });
    delete vscodeTestState.workspaceConfig['1cMetadataTree.platform.path'];
  });

  test('discovery + loose platformVersion matches full build number (WOW §1F #24)', async () => {
    const thick = path.join(os.tmpdir(), 'mock-1cv8-thick');
    const thin = path.join(os.tmpdir(), 'mock-1cv8c-thin');
    const entry = {
      ...baseEntry(),
      launchSettings: { platformVersion: '8.3.24' },
    };

    const exe = await resolveLaunchExecutable(entry, 'enterprise', {
      discoverInstalls: () => [
        {
          version: '8.3.24.1',
          bitness: '64',
          thickExe: thick,
          thinExe: thin,
        },
      ],
    });

    assert.strictEqual(exe, thin);
    assert.strictEqual(vscodeTestState.errorLog.length, 0);
  });

  test('discovery + loose match still errors when no install matches version prefix', async () => {
    const thick = path.join(os.tmpdir(), 'mock-1cv8-no-match');
    const entry = {
      ...baseEntry(),
      launchSettings: { platformVersion: '8.3.24' },
    };

    const exe = await resolveLaunchExecutable(entry, 'enterprise', {
      discoverInstalls: () => [
        {
          version: '8.3.20.0',
          bitness: '64',
          thickExe: thick,
          thinExe: undefined,
        },
      ],
    });

    assert.strictEqual(exe, undefined);
    assert.ok(
      vscodeTestState.errorLog.some((m) => m.includes('8.3.24') && m.includes('не найдена')),
      `expected version not-found error, got: ${JSON.stringify(vscodeTestState.errorLog)}`,
    );
  });

  test('discovery trims platformVersion before loose match', async () => {
    const thick = path.join(os.tmpdir(), 'mock-1cv8-trim-thick');
    const thin = path.join(os.tmpdir(), 'mock-1cv8-trim-thin');
    const entry = {
      ...baseEntry(),
      launchSettings: { platformVersion: '  8.3.24  ' },
    };

    const exe = await resolveLaunchExecutable(entry, 'enterprise', {
      discoverInstalls: () => [
        {
          version: '8.3.24.99',
          bitness: '64',
          thickExe: thick,
          thinExe: thin,
        },
      ],
    });

    assert.strictEqual(exe, thin);
    assert.strictEqual(vscodeTestState.errorLog.length, 0);
  });

  test('discovery errors when bitness filter leaves no installs', async () => {
    const thick = path.join(os.tmpdir(), 'mock-1cv8-bitness');
    const entry = {
      ...baseEntry(),
      launchSettings: { bitness: '32' as const },
    };

    const exe = await resolveLaunchExecutable(entry, 'enterprise', {
      discoverInstalls: () => [
        {
          version: '8.3.25.0',
          bitness: '64',
          thickExe: thick,
          thinExe: undefined,
        },
      ],
    });

    assert.strictEqual(exe, undefined);
    assert.ok(
      vscodeTestState.errorLog.some((m) => m.includes('32') && m.includes('разрядност')),
      `expected bitness error, got: ${JSON.stringify(vscodeTestState.errorLog)}`,
    );
  });

  test('enterprise + clientType thick uses thick exe when thin exists', async () => {
    const thick = path.join(os.tmpdir(), 'mock-1cv8-thick-only');
    const thin = path.join(os.tmpdir(), 'mock-1cv8c-thin-only');
    const entry = {
      ...baseEntry(),
      launchSettings: { clientType: 'thick' as const },
    };

    const exe = await resolveLaunchExecutable(entry, 'enterprise', {
      discoverInstalls: () => [
        {
          version: '8.3.24.1',
          bitness: '64',
          thickExe: thick,
          thinExe: thin,
        },
      ],
    });

    assert.strictEqual(exe, thick);
  });

  test('enterprise + clientType web prefers thin like default thin', async () => {
    const thick = path.join(os.tmpdir(), 'mock-web-thick');
    const thin = path.join(os.tmpdir(), 'mock-web-thin');
    const entry = {
      ...baseEntry(),
      launchSettings: { clientType: 'web' as const },
    };

    const exe = await resolveLaunchExecutable(entry, 'enterprise', {
      discoverInstalls: () => [
        {
          version: '8.3.24.1',
          bitness: '64',
          thickExe: thick,
          thinExe: thin,
        },
      ],
    });

    assert.strictEqual(exe, thin);
  });

  test('designer from discovery always resolves thick client', async () => {
    const thick = path.join(os.tmpdir(), 'mock-designer-thick');
    const thin = path.join(os.tmpdir(), 'mock-designer-thin');
    const entry = { ...baseEntry(), launchSettings: { clientType: 'thin' as const } };

    const exe = await resolveLaunchExecutable(entry, 'designer', {
      discoverInstalls: () => [
        {
          version: '8.3.24.1',
          bitness: '64',
          thickExe: thick,
          thinExe: thin,
        },
      ],
    });

    assert.strictEqual(exe, thick);
  });

  test('exact platformVersion match uses that install without requiring full scan equality', async () => {
    const thick = path.join(os.tmpdir(), 'mock-exact-thick');
    const entry = {
      ...baseEntry(),
      launchSettings: { platformVersion: '8.3.24.1' },
    };

    const exe = await resolveLaunchExecutable(entry, 'enterprise', {
      discoverInstalls: () => [
        {
          version: '8.3.24.1',
          bitness: '64',
          thickExe: thick,
          thinExe: undefined,
        },
        {
          version: '8.3.25.0',
          bitness: '64',
          thickExe: path.join(os.tmpdir(), 'other-thick'),
          thinExe: undefined,
        },
      ],
    });

    assert.strictEqual(exe, thick);
  });

  test('multiple installs uses quickPick selection', async () => {
    const thickA = path.join(os.tmpdir(), 'mock-qp-a-thick');
    const thickB = path.join(os.tmpdir(), 'mock-qp-b-thick');
    const installB = {
      version: '8.3.26.0',
      bitness: '64' as const,
      thickExe: thickB,
      thinExe: undefined,
    };
    vscodeTestState.quickPickQueue = [{ label: 'pick-b', install: installB }];

    const exe = await resolveLaunchExecutable(baseEntry(), 'enterprise', {
      discoverInstalls: () => [
        {
          version: '8.3.25.0',
          bitness: '64',
          thickExe: thickA,
          thinExe: undefined,
        },
        installB,
      ],
    });

    assert.strictEqual(exe, thickB);
  });

  test('multiple installs returns undefined when quickPick dismissed', async () => {
    vscodeTestState.quickPickQueue = [];

    const exe = await resolveLaunchExecutable(baseEntry(), 'enterprise', {
      discoverInstalls: () => [
        {
          version: '8.3.25.0',
          bitness: '64',
          thickExe: path.join(os.tmpdir(), 'dismiss-a'),
          thinExe: undefined,
        },
        {
          version: '8.3.24.0',
          bitness: '64',
          thickExe: path.join(os.tmpdir(), 'dismiss-b'),
          thinExe: undefined,
        },
      ],
    });

    assert.strictEqual(exe, undefined);
    assert.strictEqual(vscodeTestState.errorLog.length, 0);
  });
});
