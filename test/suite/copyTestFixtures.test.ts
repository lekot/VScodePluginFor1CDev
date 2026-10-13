import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface FixtureCopierModule {
  copyTestFixtures(projectRoot?: string): void;
}

const { copyTestFixtures } = require(path.resolve(__dirname, '../../../scripts/copy-test-fixtures.js')) as FixtureCopierModule;

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

suite('Test fixture copier', () => {
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
});
