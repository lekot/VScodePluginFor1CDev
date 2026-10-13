import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const cleanerSourcePath = path.join(repoRoot, 'scripts', 'clean-production-dist.cjs');

function hashFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createProjectFixture(): { root: string; cleanerPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdt304-dist-clean-'));
  const scriptsDirectory = path.join(root, 'scripts');
  fs.mkdirSync(scriptsDirectory, { recursive: true });
  fs.copyFileSync(cleanerSourcePath, path.join(scriptsDirectory, 'clean-production-dist.cjs'));
  return { root, cleanerPath: path.join(scriptsDirectory, 'clean-production-dist.cjs') };
}

function runCleaner(cleanerPath: string, cwd: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [cleanerPath], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
}

function removeOwnedOutsideFixture(root: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTemp = path.resolve(os.tmpdir());
  assert.ok(
    resolvedRoot.startsWith(resolvedTemp + path.sep) &&
      path.basename(resolvedRoot).startsWith('cdt304-dist-outside-'),
    `refusing to remove unexpected outside fixture path: ${resolvedRoot}`
  );
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}

function removeOwnedFixture(root: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTemp = path.resolve(os.tmpdir());
  assert.ok(
    resolvedRoot.startsWith(resolvedTemp + path.sep) &&
      path.basename(resolvedRoot).startsWith('cdt304-dist-clean-'),
    `refusing to remove unexpected fixture path: ${resolvedRoot}`
  );
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}

suite('production dist cleanup', () => {
  test('compile removes stale JavaScript, declarations and maps while preserving other build outputs', function () {
    this.timeout(120000);

    const distDirectory = path.join(repoRoot, 'dist');
    const distStat = fs.lstatSync(distDirectory);
    assert.ok(
      distStat.isDirectory() && !distStat.isSymbolicLink(),
      'dist must be a real directory'
    );

    const staleDirectory = path.join(distDirectory, '__cdt304_stale__');
    const staleFiles = ['removedModule.js', 'removedModule.d.ts', 'removedModule.js.map'];
    assert.strictEqual(fs.existsSync(staleDirectory), false, 'stale test path must start absent');

    const outSentinel = path.join(repoRoot, 'out', `.cdt304-preserve-${process.pid}`);
    const outSentinelContent = 'out belongs to the test toolchain';
    const sourcePath = path.join(repoRoot, 'src', 'extension.ts');
    const resourcePath = path.join(repoRoot, 'resources', 'UPSTREAM.md');
    const dependencyPath = path.join(repoRoot, 'node_modules', 'typescript', 'package.json');
    const originalVersion = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
    ).version;
    const preservedHashes = [sourcePath, resourcePath, dependencyPath].map(hashFile);

    fs.mkdirSync(staleDirectory, { recursive: true });
    for (const staleFile of staleFiles) {
      fs.writeFileSync(path.join(staleDirectory, staleFile), 'stale build artifact', 'utf8');
    }
    fs.writeFileSync(outSentinel, outSentinelContent, 'utf8');

    try {
      const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm';
      const commandArgs =
        process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run compile'] : ['run', 'compile'];
      const result = spawnSync(command, commandArgs, {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 120000,
        windowsHide: true,
      });
      assert.strictEqual(result.error, undefined, result.error?.message);
      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);

      for (const staleFile of staleFiles) {
        assert.strictEqual(
          fs.existsSync(path.join(staleDirectory, staleFile)),
          false,
          `${staleFile} must not survive compile`
        );
      }
      assert.ok(fs.existsSync(path.join(distDirectory, 'extension.js')));
      assert.ok(fs.existsSync(path.join(distDirectory, 'agent', 'mcpAdapter', 'sessionRouter.js')));
      assert.ok(fs.existsSync(path.join(distDirectory, 'rolesEditor', 'rolesEditorWebview.html')));
      assert.strictEqual(fs.readFileSync(outSentinel, 'utf8'), outSentinelContent);
      assert.deepStrictEqual(
        [sourcePath, resourcePath, dependencyPath].map(hashFile),
        preservedHashes,
        'compile must leave src, resources and node_modules unchanged'
      );
      assert.strictEqual(
        JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version,
        originalVersion,
        'compile must not bump the package version'
      );
    } finally {
      fs.rmSync(staleDirectory, { recursive: true, force: true });
      fs.rmSync(outSentinel, { force: true });
    }
  });

  test('cleans a regular dist and unlinks nested directory symlinks without touching their target', () => {
    const fixture = createProjectFixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cdt304-dist-outside-'));
    const sentinel = path.join(outside, 'sentinel.txt');
    const distDirectory = path.join(fixture.root, 'dist');
    fs.mkdirSync(path.join(distDirectory, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(distDirectory, 'nested', 'stale.js'), 'stale', 'utf8');
    fs.writeFileSync(sentinel, 'outside survives', 'utf8');

    try {
      try {
        fs.symlinkSync(
          outside,
          path.join(distDirectory, 'external'),
          process.platform === 'win32' ? 'junction' : 'dir'
        );
      } catch (error) {
        assert.fail(`could not create directory symlink fixture: ${String(error)}`);
      }

      const result = runCleaner(fixture.cleanerPath, fixture.root);
      assert.strictEqual(result.error, undefined, result.error?.message);
      assert.strictEqual(result.status, 0, String(result.stderr));
      assert.strictEqual(fs.existsSync(distDirectory), false, 'regular dist should be removed');
      assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'outside survives');
    } finally {
      removeOwnedFixture(fixture.root);
      removeOwnedOutsideFixture(outside);
    }
  });

  test('fails closed for a root dist symlink or junction', () => {
    const fixture = createProjectFixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cdt304-dist-outside-'));
    const sentinel = path.join(outside, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'outside survives', 'utf8');
    const distDirectory = path.join(fixture.root, 'dist');

    try {
      fs.symlinkSync(outside, distDirectory, process.platform === 'win32' ? 'junction' : 'dir');
      const result = runCleaner(fixture.cleanerPath, fixture.root);
      assert.strictEqual(result.error, undefined, result.error?.message);
      assert.notStrictEqual(result.status, 0, 'root link must be rejected');
      assert.ok(fs.lstatSync(distDirectory).isSymbolicLink(), 'root link must remain untouched');
      assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'outside survives');
    } finally {
      removeOwnedFixture(fixture.root);
      removeOwnedOutsideFixture(outside);
    }
  });

  test('treats an absent dist as a successful no-op and rejects a regular file', () => {
    const fixture = createProjectFixture();
    const distPath = path.join(fixture.root, 'dist');

    try {
      const absentResult = runCleaner(fixture.cleanerPath, fixture.root);
      assert.strictEqual(absentResult.error, undefined, absentResult.error?.message);
      assert.strictEqual(absentResult.status, 0, String(absentResult.stderr));
      assert.strictEqual(fs.existsSync(distPath), false);

      fs.writeFileSync(distPath, 'keep this unexpected file', 'utf8');
      const fileResult = runCleaner(fixture.cleanerPath, fixture.root);
      assert.strictEqual(fileResult.error, undefined, fileResult.error?.message);
      assert.notStrictEqual(fileResult.status, 0, 'regular file at dist path must be rejected');
      assert.strictEqual(fs.readFileSync(distPath, 'utf8'), 'keep this unexpected file');
    } finally {
      removeOwnedFixture(fixture.root);
    }
  });
});
