import * as assert from 'assert';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  AtomicFileStorage,
  hashContent,
  type AtomicFileSystem,
} from '../../src/services/configurationSession/atomicFileStorage';

suite('AtomicFileStorage', () => {
  let tempDir: string;

  setup(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atomic-file-storage-'));
  });

  teardown(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  test('commits only when expected hash still matches', async () => {
    const target = path.join(tempDir, 'Configuration.xml');
    await fsp.writeFile(target, 'old', 'utf8');
    const storage = new AtomicFileStorage(tempDir);

    const stale = await storage.replace(target, 'new', hashContent('another value'));
    assert.strictEqual(stale.status, 'conflict');
    assert.strictEqual(await fsp.readFile(target, 'utf8'), 'old');

    const committed = await storage.replace(target, 'new', hashContent('old'));
    assert.strictEqual(committed.status, 'committed');
    assert.strictEqual(await fsp.readFile(target, 'utf8'), 'new');
  });

  test('create-if-absent never replaces an existing target', async () => {
    const target = path.join(tempDir, 'Configuration.xml');
    await fsp.writeFile(target, 'existing', 'utf8');

    const outcome = await new AtomicFileStorage(tempDir).createIfAbsent(target, 'replacement');

    assert.strictEqual(outcome.status, 'conflict');
    assert.strictEqual(outcome.code, 'TARGET_ALREADY_EXISTS');
    assert.strictEqual(await fsp.readFile(target, 'utf8'), 'existing');
    assert.deepStrictEqual((await fsp.readdir(tempDir)).filter((name) => name.startsWith('.cdt-')), []);
  });

  test('classifies a create link that publishes then reports failure', async () => {
    const target = path.join(tempDir, 'Configuration.xml');
    const ambiguousFileSystem: AtomicFileSystem = {
      readFile: (filePath) => fsp.readFile(filePath),
      open: (filePath, flags) => fsp.open(filePath, flags),
      link: async (existingPath, newPath) => {
        await fsp.link(existingPath, newPath);
        throw new Error('injected create acknowledgement loss');
      },
      rename: (oldPath, newPath) => fsp.rename(oldPath, newPath),
      rm: (filePath, options) => fsp.rm(filePath, options),
    };

    const outcome = await new AtomicFileStorage(tempDir, ambiguousFileSystem)
      .createIfAbsent(target, 'created');

    assert.strictEqual(outcome.status, 'committed');
    assert.strictEqual(await fsp.readFile(target, 'utf8'), 'created');
    assert.deepStrictEqual((await fsp.readdir(tempDir)).filter((name) => name.startsWith('.cdt-')), []);
  });

  test('rolls back a create publication failure before the target appears', async () => {
    const target = path.join(tempDir, 'Configuration.xml');
    const failingFileSystem: AtomicFileSystem = {
      readFile: (filePath) => fsp.readFile(filePath),
      open: (filePath, flags) => fsp.open(filePath, flags),
      link: async () => { throw Object.assign(new Error('injected link denial'), { code: 'EACCES' }); },
      rename: (oldPath, newPath) => fsp.rename(oldPath, newPath),
      rm: (filePath, options) => fsp.rm(filePath, options),
    };

    const outcome = await new AtomicFileStorage(tempDir, failingFileSystem)
      .createIfAbsent(target, 'new content');

    assert.strictEqual(outcome.status, 'rolledBack');
    assert.strictEqual(outcome.code, 'WRITE_FAILED');
    assert.ok(outcome.message.includes('injected link denial'));
    await assert.rejects(fsp.readFile(target), { code: 'ENOENT' });
    assert.deepStrictEqual((await fsp.readdir(tempDir)).filter((name) => name.startsWith('.cdt-')), []);
  });

  test('keeps the original file and removes temp when rename fails', async () => {
    const target = path.join(tempDir, 'Configuration.xml');
    await fsp.writeFile(target, 'old', 'utf8');
    const failingFileSystem: AtomicFileSystem = {
      readFile: (filePath) => fsp.readFile(filePath),
      open: (filePath, flags) => fsp.open(filePath, flags),
      link: (existingPath, newPath) => fsp.link(existingPath, newPath),
      rename: async () => { throw new Error('injected rename failure'); },
      rm: (filePath, options) => fsp.rm(filePath, options),
    };

    const outcome = await new AtomicFileStorage(tempDir, failingFileSystem)
      .replace(target, 'new', hashContent('old'));

    assert.strictEqual(outcome.status, 'rolledBack');
    assert.strictEqual(await fsp.readFile(target, 'utf8'), 'old');
    assert.deepStrictEqual((await fsp.readdir(tempDir)).filter((name) => name.startsWith('.cdt-')), []);
  });

  test('classifies effect-then-throw rename by the committed content hash', async () => {
    const target = path.join(tempDir, 'Configuration.xml');
    await fsp.writeFile(target, 'old', 'utf8');
    const ambiguousFileSystem: AtomicFileSystem = {
      readFile: (filePath) => fsp.readFile(filePath),
      open: (filePath, flags) => fsp.open(filePath, flags),
      link: (existingPath, newPath) => fsp.link(existingPath, newPath),
      rename: async (source, destination) => {
        await fsp.rename(source, destination);
        throw new Error('injected acknowledgement loss');
      },
      rm: (filePath, options) => fsp.rm(filePath, options),
    };

    const outcome = await new AtomicFileStorage(tempDir, ambiguousFileSystem)
      .replace(target, 'new', hashContent('old'));

    assert.strictEqual(outcome.status, 'committed');
    assert.strictEqual(await fsp.readFile(target, 'utf8'), 'new');
  });

  test('serializes competing compare-and-swap writers for the same canonical target', async () => {
    const target = path.join(tempDir, 'Configuration.xml');
    await fsp.writeFile(target, 'old', 'utf8');
    const expected = hashContent('old');

    const [first, second] = await Promise.all([
      new AtomicFileStorage(tempDir).replace(target, 'first', expected),
      new AtomicFileStorage(tempDir).replace(target, 'second', expected),
    ]);

    assert.deepStrictEqual([first.status, second.status].sort(), ['committed', 'conflict']);
    assert.ok(['first', 'second'].includes(await fsp.readFile(target, 'utf8')));
  });

  test('rejects a target reached through a symlink escape', async function () {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'atomic-outside-'));
    const outsideTarget = path.join(outside, 'Configuration.xml');
    await fsp.writeFile(outsideTarget, 'outside', 'utf8');
    const link = path.join(tempDir, 'linked');
    try {
      await fsp.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      await fsp.rm(outside, { recursive: true, force: true });
      this.skip();
      return;
    }
    try {
      const outcome = await new AtomicFileStorage(tempDir).replace(
        path.join(link, 'Configuration.xml'),
        'changed',
        hashContent('outside'),
      );
      assert.strictEqual(outcome.status, 'conflict');

      const createOutcome = await new AtomicFileStorage(tempDir)
        .createIfAbsent(path.join(link, 'NewConfiguration.xml'), 'must not escape');
      assert.strictEqual(createOutcome.status, 'conflict');
      assert.strictEqual(await fsp.readFile(outsideTarget, 'utf8'), 'outside');
      await assert.rejects(fsp.readFile(path.join(outside, 'NewConfiguration.xml')), { code: 'ENOENT' });
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  test('rejects lexical parent traversal before disk effects', async () => {
    const outsideTarget = path.join(path.dirname(tempDir), `outside-${Date.now()}.xml`);
    fs.writeFileSync(outsideTarget, 'outside', 'utf8');
    try {
      const outcome = await new AtomicFileStorage(tempDir).replace(
        outsideTarget,
        'changed',
        hashContent('outside'),
      );
      assert.strictEqual(outcome.status, 'conflict');
      assert.strictEqual(await fsp.readFile(outsideTarget, 'utf8'), 'outside');
    } finally {
      await fsp.rm(outsideTarget, { force: true });
    }
  });
});
