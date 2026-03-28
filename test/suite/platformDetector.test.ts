import * as assert from 'assert';
import * as path from 'path';

const W = path.win32;
import {
  discoverPlatformInstallations,
  filterPlatformInstallsForLaunch,
  inferVersionFromExePath,
  pickPlatformClientExecutable,
  type PlatformDetectorDeps,
  type PlatformInstall,
} from '../../src/services/platformDetector';

suite('platformDetector', () => {
  function makeDeps(over: Partial<PlatformDetectorDeps> & Pick<PlatformDetectorDeps, 'existsSync'>): PlatformDetectorDeps {
    return {
      readdirSync: () => [],
      statSync: () => ({ isDirectory: () => true }),
      env: {},
      platform: 'linux',
      findOnSystemPath: () => null,
      ...over,
    } as PlatformDetectorDeps;
  }

  test('discoverPlatformInstallations finds windows bin with thick and thin', () => {
    const root = W.join('C:', 'Program Files', '1cv8', '8.3.24.1', 'bin');
    const thick = W.join(root, '1cv8.exe');
    const thin = W.join(root, '1cv8c.exe');
    const deps = makeDeps({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      existsSync: (p: string) =>
        p === thick ||
        p === thin ||
        p === root ||
        p === W.join('C:', 'Program Files', '1cv8', '8.3.24.1') ||
        p === W.join('C:', 'Program Files', '1cv8'),
      readdirSync: (p: string) => {
        if (p === W.join('C:', 'Program Files', '1cv8')) {
          return ['8.3.24.1'];
        }
        return [];
      },
      statSync: (p: string) => ({
        isDirectory: () =>
          p === W.join('C:', 'Program Files', '1cv8') ||
          p === W.join('C:', 'Program Files', '1cv8', '8.3.24.1') ||
          p === root,
      }),
    });
    const got = discoverPlatformInstallations(deps);
    const hit = got.find((g) => g.version === '8.3.24.1');
    assert.ok(hit);
    assert.strictEqual(hit!.bitness, '64');
    assert.strictEqual(hit!.thickExe, thick);
    assert.strictEqual(hit!.thinExe, thin);
  });

  test('discoverPlatformInstallations marks 32-bit under Program Files (x86)', () => {
    const base = W.join('C:', 'Program Files (x86)', '1cv8', '8.3.20.5');
    const binDir = W.join(base, 'bin');
    const thick = W.join(binDir, '1cv8.exe');
    const deps = makeDeps({
      platform: 'win32',
      env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
      existsSync: (p: string) =>
        p === thick || p === binDir || p === base || p === W.join('C:', 'Program Files (x86)', '1cv8'),
      readdirSync: (p: string) => (p === W.join('C:', 'Program Files (x86)', '1cv8') ? ['8.3.20.5'] : []),
      statSync: (p: string) => ({
        isDirectory: () =>
          p === W.join('C:', 'Program Files (x86)', '1cv8') || p === base || p === binDir,
      }),
    });
    const got = discoverPlatformInstallations(deps);
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].bitness, '32');
    assert.strictEqual(got[0].thickExe, thick);
    assert.strictEqual(got[0].thinExe, undefined);
  });

  test('discoverPlatformInstallations scans nested version folder (level2 bin)', () => {
    const p1 = '/opt/1cv8/8.3.24';
    const p2 = '/opt/1cv8/8.3.24/8.3.24.99';
    const bin2 = `${p2}/bin`;
    const thick = `${bin2}/1cv8`;
    const deps = makeDeps({
      platform: 'linux',
      env: {},
      existsSync: (p: string) =>
        [thick, bin2, p2, p1, '/opt/1cv8'].includes(p),
      readdirSync: (p: string) => {
        if (p === '/opt/1cv8') {
          return ['8.3.24'];
        }
        if (p === p1) {
          return ['8.3.24.99'];
        }
        return [];
      },
      statSync: (p: string) => ({
        isDirectory: () => ['/opt/1cv8', p1, p2, bin2].includes(p),
      }),
    });
    const got = discoverPlatformInstallations(deps);
    const hit = got.find((g) => g.version === '8.3.24.99');
    assert.ok(hit);
    assert.strictEqual(hit!.thickExe, thick);
  });

  test('discoverPlatformInstallations merges PATH hit and dedupes same thickExe', () => {
    const thick = '/opt/1cv8/8.3.22/bin/1cv8';
    const binDir = '/opt/1cv8/8.3.22/bin';
    const rootVer = '/opt/1cv8/8.3.22';
    const deps = makeDeps({
      platform: 'linux',
      env: {},
      existsSync: (p: string) => p === thick || p === binDir || p === rootVer || p === '/opt/1cv8',
      readdirSync: (p: string) => (p === '/opt/1cv8' ? ['8.3.22'] : []),
      statSync: (p: string) => ({
        isDirectory: () => ['/opt/1cv8', rootVer, binDir].includes(p),
      }),
      findOnSystemPath: () => thick,
    });
    const got = discoverPlatformInstallations(deps);
    const same = got.filter((g) => g.thickExe === thick);
    assert.strictEqual(same.length, 1);
  });

  test('discoverPlatformInstallations ignores PATH when basename is not thick client', () => {
    const deps = makeDeps({
      platform: 'linux',
      env: {},
      existsSync: () => false,
      findOnSystemPath: () => '/usr/bin/not1cv8',
    });
    const got = discoverPlatformInstallations(deps);
    assert.strictEqual(got.length, 0);
  });

  test('filterPlatformInstallsForLaunch filters by bitness and exact version', () => {
    const installs: PlatformInstall[] = [
      {
        version: '8.3.20.1',
        bitness: '32',
        thickExe: '/x/1cv8',
        thinExe: undefined,
      },
      {
        version: '8.3.24.1',
        bitness: '64',
        thickExe: '/y/1cv8',
        thinExe: '/y/1cv8c',
      },
    ];
    const b64 = filterPlatformInstallsForLaunch(installs, { bitness: '64' });
    assert.strictEqual(b64.length, 1);
    assert.strictEqual(b64[0].version, '8.3.24.1');
    const ver = filterPlatformInstallsForLaunch(installs, { platformVersion: '8.3.24.1' });
    assert.strictEqual(ver.length, 1);
    assert.strictEqual(ver[0].version, '8.3.24.1');
  });

  test('filterPlatformInstallsForLaunch uses loose version match when exact missing', () => {
    const installs: PlatformInstall[] = [
      { version: '8.3.24.1', bitness: '64', thickExe: '/a/1cv8', thinExe: undefined },
      { version: '8.3.20.0', bitness: '64', thickExe: '/b/1cv8', thinExe: undefined },
    ];
    const got = filterPlatformInstallsForLaunch(installs, { platformVersion: '8.3.24' });
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].version, '8.3.24.1');
  });

  test('filterPlatformInstallsForLaunch returns empty when version constraint matches nothing', () => {
    const installs: PlatformInstall[] = [
      { version: '8.3.20.0', bitness: '64', thickExe: '/b/1cv8', thinExe: undefined },
    ];
    const got = filterPlatformInstallsForLaunch(installs, { platformVersion: '9.0.0.0' });
    assert.strictEqual(got.length, 0);
  });

  test('filterPlatformInstallsForLaunch trims platformVersion and treats undefined launch settings as no-op', () => {
    const installs: PlatformInstall[] = [
      { version: '8.3.1', bitness: '64', thickExe: '/z/1cv8', thinExe: undefined },
    ];
    assert.strictEqual(filterPlatformInstallsForLaunch(installs, { platformVersion: '  8.3.1  ' }).length, 1);
    assert.strictEqual(filterPlatformInstallsForLaunch(installs, undefined).length, 1);
    assert.strictEqual(filterPlatformInstallsForLaunch(installs, { platformVersion: '   ' }).length, 1);
  });

  test('filterPlatformInstallsForLaunch applies bitness then version', () => {
    const installs: PlatformInstall[] = [
      { version: '8.3.24.1', bitness: '32', thickExe: '/32/1cv8', thinExe: undefined },
      { version: '8.3.24.1', bitness: '64', thickExe: '/64/1cv8', thinExe: undefined },
    ];
    const got = filterPlatformInstallsForLaunch(installs, { bitness: '64', platformVersion: '8.3.24.1' });
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].thickExe, '/64/1cv8');
  });

  test('inferVersionFromExePath resolves folder before bin on Windows and Linux', () => {
    assert.strictEqual(
      inferVersionFromExePath(String.raw`C:\Program Files\1cv8\8.3.24.1467\bin\1cv8.exe`, 'win32'),
      '8.3.24.1467',
    );
    assert.strictEqual(inferVersionFromExePath('/opt/1cv8/8.3.22.1/bin/1cv8', 'linux'), '8.3.22.1');
    assert.strictEqual(inferVersionFromExePath('C:\\only\\1cv8.exe', 'win32'), undefined);
    assert.strictEqual(inferVersionFromExePath('bin/1cv8', 'linux'), undefined);
  });

  test('pickPlatformClientExecutable designer always uses thick', () => {
    const install: PlatformInstall = {
      version: '8.3.1',
      bitness: '64',
      thickExe: '/t/1cv8',
      thinExe: '/t/1cv8c',
    };
    const d = pickPlatformClientExecutable(install, { clientType: 'thin' }, 'designer');
    assert.deepStrictEqual(d, { exe: '/t/1cv8', usedClient: 'thick' });
  });

  test('pickPlatformClientExecutable enterprise prefers thin when allowed and present', () => {
    const install: PlatformInstall = {
      version: '8.3.1',
      bitness: '64',
      thickExe: '/t/1cv8',
      thinExe: '/t/1cv8c',
    };
    assert.deepStrictEqual(pickPlatformClientExecutable(install, undefined, 'enterprise'), {
      exe: '/t/1cv8c',
      usedClient: 'thin',
    });
    assert.deepStrictEqual(pickPlatformClientExecutable(install, { clientType: 'web' }, 'enterprise'), {
      exe: '/t/1cv8c',
      usedClient: 'thin',
    });
  });

  test('pickPlatformClientExecutable enterprise uses thick when thin missing or thick requested', () => {
    const noThin: PlatformInstall = {
      version: '8.3.1',
      bitness: '64',
      thickExe: '/t/1cv8',
      thinExe: undefined,
    };
    assert.deepStrictEqual(pickPlatformClientExecutable(noThin, { clientType: 'thin' }, 'enterprise'), {
      exe: '/t/1cv8',
      usedClient: 'thick',
    });
    const withThin: PlatformInstall = { ...noThin, thinExe: '/t/1cv8c' };
    assert.deepStrictEqual(pickPlatformClientExecutable(withThin, { clientType: 'thick' }, 'enterprise'), {
      exe: '/t/1cv8',
      usedClient: 'thick',
    });
  });
});
