import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

interface FixtureCopierModule {
  copyRegularDirectory(sourcePath: string, destinationPath: string): void;
  copyTestFixtures(projectRoot?: string): void;
}

const { copyRegularDirectory, copyTestFixtures } = require(path.resolve(__dirname, '../../../scripts/copy-test-fixtures.js')) as FixtureCopierModule;

interface TemporaryProject {
  root: string;
  ownerToken: string;
  projectRoot: string;
}

function createTemporaryProject(): TemporaryProject {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-test-fixtures-306-'));
  const ownerToken = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(root, '.owner-token'), ownerToken, 'utf8');
  const projectRoot = path.join(root, 'проект-тестирования');
  fs.mkdirSync(projectRoot);
  return { root, ownerToken, projectRoot };
}

function removeTemporaryProject(temp: TemporaryProject): void {
  const resolvedRoot = path.resolve(temp.root);
  const resolvedTempDirectory = path.resolve(os.tmpdir());
  const relativePath = path.relative(resolvedTempDirectory, resolvedRoot);
  const ownerTokenPath = path.join(resolvedRoot, '.owner-token');

  assert.notStrictEqual(relativePath, '');
  assert.notStrictEqual(relativePath, '..');
  assert.ok(!relativePath.startsWith(`..${path.sep}`));
  assert.ok(!path.isAbsolute(relativePath));
  assert.strictEqual(fs.readFileSync(ownerTokenPath, 'utf8'), temp.ownerToken);
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}

function withTemporaryProject(action: (projectRoot: string, tempRoot: string) => void): void {
  const temp = createTemporaryProject();
  try {
    action(temp.projectRoot, temp.root);
  } finally {
    removeTemporaryProject(temp);
  }
}

function createFixtureLayout(projectRoot: string): { source: string; destination: string } {
  const source = path.join(projectRoot, 'test', 'fixtures');
  const destination = path.join(projectRoot, 'out', 'test', 'fixtures');
  fs.mkdirSync(source, { recursive: true });
  return { source, destination };
}

function writeFixture(source: string, relativePath: string, contents: string | Buffer): string {
  const filePath = path.join(source, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function createDirectoryLink(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

function collectFiles(rootPath: string, currentPath = rootPath): string[] {
  const relativePaths: string[] = [];
  for (const entryName of fs.readdirSync(currentPath)) {
    const entryPath = path.join(currentPath, entryName);
    const relativePath = path.relative(rootPath, entryPath);
    if (fs.lstatSync(entryPath).isDirectory()) {
      relativePaths.push(...collectFiles(rootPath, entryPath));
    } else {
      relativePaths.push(relativePath);
    }
  }
  return relativePaths.sort();
}

suite('Test fixture copier', () => {
  test('copies regular directories between Unicode source and destination paths', () => {
    withTemporaryProject((projectRoot) => {
      const source = path.join(projectRoot, 'источник', 'дерево');
      const destination = path.join(projectRoot, 'приёмник', 'копия');
      const binaryContents = Buffer.from(Array.from({ length: 256 }, (_value, index) => index));
      writeFixture(source, path.join('вложенный-каталог', 'данные.bin'), binaryContents);
      fs.mkdirSync(path.join(source, 'пустой-каталог'));

      copyRegularDirectory(source, destination);

      assert.deepStrictEqual(collectFiles(source), collectFiles(destination));
      assert.deepStrictEqual(fs.readFileSync(path.join(destination, 'вложенный-каталог', 'данные.bin')), binaryContents);
      assert.ok(fs.statSync(path.join(destination, 'пустой-каталог')).isDirectory());
      copyRegularDirectory(source, destination);
      assert.deepStrictEqual(collectFiles(source), collectFiles(destination));
    });
  });

  test('rejects equal and ancestor/descendant source and destination paths before writing', () => {
    withTemporaryProject((projectRoot) => {
      const source = path.join(projectRoot, 'источник');
      fs.mkdirSync(source);
      writeFixture(source, 'must-stay-in-source.txt', 'sentinel');

      assert.strictEqual(typeof copyRegularDirectory, 'function');
      assert.throws(() => copyRegularDirectory(source, source), /overlap/);
      assert.throws(() => copyRegularDirectory(source, path.join(source, 'потомок')), /overlap/);
      assert.throws(() => copyRegularDirectory(path.join(source, 'потомок'), source), /overlap/);
      assert.deepStrictEqual(fs.readdirSync(source), ['must-stay-in-source.txt']);
      assert.strictEqual(fs.readFileSync(path.join(source, 'must-stay-in-source.txt'), 'utf8'), 'sentinel');
    });
  });

  test('rejects paths that resolve to the same canonical directory', () => {
    withTemporaryProject((projectRoot) => {
      const source = path.join(projectRoot, 'canonical-source');
      const destination = path.join(projectRoot, 'canonical-destination');
      fs.mkdirSync(source);
      fs.mkdirSync(destination);

      const mutableFs = require('fs') as { realpathSync: typeof fs.realpathSync };
      const originalRealpathSync = mutableFs.realpathSync;
      try {
        mutableFs.realpathSync = ((entryPath: fs.PathLike, ...args: unknown[]) => {
          if (path.resolve(String(entryPath)) === path.resolve(destination)) {
            return originalRealpathSync(source, ...(args as []));
          }
          return originalRealpathSync(entryPath, ...(args as []));
        }) as typeof fs.realpathSync;
        assert.throws(() => copyRegularDirectory(source, destination), /overlap/);
      } finally {
        mutableFs.realpathSync = originalRealpathSync;
      }
      assert.deepStrictEqual(fs.readdirSync(destination), []);
    });
  });

  test('matrix helper copies the Unicode checkout fixture into a Unicode temp path in a child process', () => {
    withTemporaryProject((_projectRoot, tempRoot) => {
      const unicodeTemp = path.join(tempRoot, 'матрица-временные-файлы');
      fs.mkdirSync(unicodeTemp);
      const helperPath = path.resolve(__dirname, '../helpers/matrixTestPaths.js');
      const script = [
        "console.log('BEFORE_COPY');",
        `const destination = require(${JSON.stringify(helperPath)}).copyEmptyConfFixtureToTemp();`,
        "console.log('AFTER_COPY');",
        "console.log('DESTINATION:' + destination);",
      ].join('\n');
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: path.resolve(__dirname, '../../..'),
        encoding: 'utf8',
        env: { ...process.env, TEMP: unicodeTemp, TMP: unicodeTemp, TMPDIR: unicodeTemp },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60_000,
        windowsHide: true,
      });

      assert.strictEqual(result.status, 0, `matrix helper child failed: ${result.error?.message ?? result.stderr}`);
      assert.ok(result.stdout.includes('BEFORE_COPY'));
      assert.ok(result.stdout.includes('AFTER_COPY'));
      const destination = result.stdout.split('DESTINATION:').pop()?.trim();
      assert.ok(destination);
      assert.ok(destination!.includes('матрица-временные-файлы'));

      const source = path.resolve(__dirname, '../../..', 'FormatSamples', 'empty_conf');
      assert.deepStrictEqual(collectFiles(source), collectFiles(destination!));
      for (const relativePath of collectFiles(source)) {
        assert.deepStrictEqual(fs.readFileSync(path.join(source, relativePath)), fs.readFileSync(path.join(destination!, relativePath)));
      }
    });
  });

  test('copies binary files and empty directories, overwrites in place, and stays idempotent under a Unicode project path', () => {
    withTemporaryProject((projectRoot) => {
      assert.ok(projectRoot.includes('проект-тестирования'));
      const { source, destination } = createFixtureLayout(projectRoot);
      const binaryContents = Buffer.from(Array.from({ length: 256 }, (_value, index) => index));
      const overwriteSource = writeFixture(source, path.join('nested', 'overwrite.txt'), 'first copy');
      writeFixture(source, path.join('nested', 'binary.bin'), binaryContents);
      fs.mkdirSync(path.join(source, 'empty-directory'));

      const destinationNested = path.join(destination, 'nested');
      fs.mkdirSync(destinationNested, { recursive: true });
      fs.writeFileSync(path.join(destinationNested, 'overwrite.txt'), 'old copy');
      fs.writeFileSync(path.join(destination, 'kept-extra.txt'), 'keep this destination entry');
      const outArtifact = path.join(projectRoot, 'out', 'acceptance-artifact.txt');
      fs.mkdirSync(path.dirname(outArtifact), { recursive: true });
      fs.writeFileSync(outArtifact, 'keep this out artifact');

      copyTestFixtures(projectRoot);
      assert.strictEqual(fs.readFileSync(path.join(destinationNested, 'overwrite.txt'), 'utf8'), 'first copy');
      assert.deepStrictEqual(fs.readFileSync(path.join(destinationNested, 'binary.bin')), binaryContents);
      assert.ok(fs.statSync(path.join(destination, 'empty-directory')).isDirectory());
      assert.strictEqual(fs.readFileSync(path.join(destination, 'kept-extra.txt'), 'utf8'), 'keep this destination entry');
      assert.strictEqual(fs.readFileSync(outArtifact, 'utf8'), 'keep this out artifact');

      copyTestFixtures(projectRoot);
      assert.ok(!fs.existsSync(path.join(destination, 'fixtures')));
      fs.writeFileSync(overwriteSource, 'updated source');
      copyTestFixtures(projectRoot);
      assert.strictEqual(fs.readFileSync(path.join(destinationNested, 'overwrite.txt'), 'utf8'), 'updated source');
    });
  });

  test('rejects a symlink at the source root without following it', () => {
    withTemporaryProject((projectRoot, tempRoot) => {
      const { source, destination } = createFixtureLayout(projectRoot);
      const externalDirectory = path.join(tempRoot, 'external-source');
      fs.mkdirSync(externalDirectory);
      fs.writeFileSync(path.join(externalDirectory, 'sentinel.txt'), 'external source sentinel');
      fs.rmdirSync(source);
      createDirectoryLink(externalDirectory, source);

      assert.throws(() => copyTestFixtures(projectRoot), /symbolic links/);
      assert.strictEqual(fs.readFileSync(path.join(externalDirectory, 'sentinel.txt'), 'utf8'), 'external source sentinel');
      assert.ok(!fs.existsSync(destination));
    });
  });

  test('rejects a nested source symlink before copying any fixture', () => {
    withTemporaryProject((projectRoot, tempRoot) => {
      const { source, destination } = createFixtureLayout(projectRoot);
      writeFixture(source, 'A-first.txt', 'must not be copied');
      const externalDirectory = path.join(tempRoot, 'external-source');
      fs.mkdirSync(externalDirectory);
      fs.writeFileSync(path.join(externalDirectory, 'sentinel.txt'), 'external source sentinel');
      createDirectoryLink(externalDirectory, path.join(source, 'linked-directory'));

      assert.throws(() => copyTestFixtures(projectRoot), /symbolic links/);
      assert.ok(!fs.existsSync(destination));
      assert.strictEqual(fs.readFileSync(path.join(externalDirectory, 'sentinel.txt'), 'utf8'), 'external source sentinel');
    });
  });

  test('rejects a symlink at the destination root without writing through it', () => {
    withTemporaryProject((projectRoot, tempRoot) => {
      const { source, destination } = createFixtureLayout(projectRoot);
      writeFixture(source, 'fixture.txt', 'copied fixture');
      const externalDirectory = path.join(tempRoot, 'external-destination');
      fs.mkdirSync(externalDirectory);
      fs.writeFileSync(path.join(externalDirectory, 'sentinel.txt'), 'external destination sentinel');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      createDirectoryLink(externalDirectory, destination);
      const outArtifact = path.join(projectRoot, 'out', 'acceptance-artifact.txt');
      fs.writeFileSync(outArtifact, 'keep this out artifact');

      assert.throws(() => copyTestFixtures(projectRoot), /symbolic links/);
      assert.strictEqual(fs.readFileSync(path.join(externalDirectory, 'sentinel.txt'), 'utf8'), 'external destination sentinel');
      assert.ok(!fs.existsSync(path.join(externalDirectory, 'fixture.txt')));
      assert.strictEqual(fs.readFileSync(outArtifact, 'utf8'), 'keep this out artifact');
    });
  });

  test('rejects a nested destination symlink without writing through it', () => {
    withTemporaryProject((projectRoot, tempRoot) => {
      const { source, destination } = createFixtureLayout(projectRoot);
      writeFixture(source, path.join('nested', 'fixture.txt'), 'copied fixture');
      const externalDirectory = path.join(tempRoot, 'external-destination');
      fs.mkdirSync(externalDirectory);
      fs.writeFileSync(path.join(externalDirectory, 'sentinel.txt'), 'external destination sentinel');
      fs.mkdirSync(destination, { recursive: true });
      createDirectoryLink(externalDirectory, path.join(destination, 'nested'));

      assert.throws(() => copyTestFixtures(projectRoot), /symbolic links/);
      assert.strictEqual(fs.readFileSync(path.join(externalDirectory, 'sentinel.txt'), 'utf8'), 'external destination sentinel');
      assert.ok(!fs.existsSync(path.join(externalDirectory, 'fixture.txt')));
    });
  });

  test('rejects source and destination ancestor symlinks without writing through them', () => {
    withTemporaryProject((projectRoot, tempRoot) => {
      const sourceTarget = path.join(tempRoot, 'source-target');
      const destinationTarget = path.join(tempRoot, 'destination-target');
      fs.mkdirSync(sourceTarget);
      fs.mkdirSync(destinationTarget);
      writeFixture(sourceTarget, 'source.txt', 'source sentinel');
      fs.writeFileSync(path.join(destinationTarget, 'destination-sentinel.txt'), 'destination sentinel');
      const linkedSource = path.join(projectRoot, 'источник-ссылка', 'tree');
      const linkedDestination = path.join(projectRoot, 'приёмник-ссылка', 'tree');
      const ordinarySource = path.join(projectRoot, 'обычный-источник');
      fs.mkdirSync(ordinarySource);
      createDirectoryLink(sourceTarget, path.dirname(linkedSource));
      createDirectoryLink(destinationTarget, path.dirname(linkedDestination));

      assert.throws(() => copyRegularDirectory(linkedSource, path.join(projectRoot, 'обычный-приёмник')), /symbolic links/);
      assert.throws(() => copyRegularDirectory(ordinarySource, linkedDestination), /symbolic links/);
      assert.strictEqual(fs.readFileSync(path.join(sourceTarget, 'source.txt'), 'utf8'), 'source sentinel');
      assert.deepStrictEqual(fs.readdirSync(destinationTarget), ['destination-sentinel.txt']);
      assert.ok(!fs.existsSync(path.join(projectRoot, 'обычный-приёмник')));
      assert.ok(fs.statSync(ordinarySource).isDirectory());
    });
  });

  test('rejects unsupported source and destination entries before copying', () => {
    withTemporaryProject((projectRoot) => {
      const source = path.join(projectRoot, 'source');
      const destination = path.join(projectRoot, 'destination');
      const unsupportedSourcePath = path.join(source, 'unsupported.entry');
      const unsupportedDestinationPath = path.join(destination, 'unsupported.entry');
      fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, 'fixture.txt'), 'fixture');
      fs.writeFileSync(unsupportedSourcePath, 'source sentinel');
      const unsupportedStats = {
        isSymbolicLink: () => false,
        isDirectory: () => false,
        isFile: () => false,
      } as unknown as fs.Stats;
      const mutableFs = require('fs') as { lstatSync: typeof fs.lstatSync };
      const originalLstatSync = mutableFs.lstatSync;

      try {
        mutableFs.lstatSync = ((entryPath: fs.PathLike, ...args: unknown[]) => {
          if (path.resolve(String(entryPath)) === path.resolve(unsupportedSourcePath)) {
            return unsupportedStats;
          }
          return originalLstatSync(entryPath, ...(args as []));
        }) as typeof fs.lstatSync;
        assert.throws(() => copyRegularDirectory(source, destination), /unsupported filesystem entries/);
      } finally {
        mutableFs.lstatSync = originalLstatSync;
      }
      assert.ok(!fs.existsSync(destination));
      assert.strictEqual(fs.readFileSync(unsupportedSourcePath, 'utf8'), 'source sentinel');

      fs.mkdirSync(destination);
      fs.writeFileSync(unsupportedDestinationPath, 'destination sentinel');
      try {
        mutableFs.lstatSync = ((entryPath: fs.PathLike, ...args: unknown[]) => {
          if (path.resolve(String(entryPath)) === path.resolve(unsupportedDestinationPath)) {
            return unsupportedStats;
          }
          return originalLstatSync(entryPath, ...(args as []));
        }) as typeof fs.lstatSync;
        assert.throws(() => copyRegularDirectory(source, destination), /unsupported filesystem entries/);
      } finally {
        mutableFs.lstatSync = originalLstatSync;
      }
      assert.ok(!fs.existsSync(path.join(destination, 'fixture.txt')));
      assert.strictEqual(fs.readFileSync(unsupportedDestinationPath, 'utf8'), 'destination sentinel');
    });
  });
});
