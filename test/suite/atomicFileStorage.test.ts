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

  test('keeps the original file and removes temp when rename fails', async () => {
    const target = path.join(tempDir, 'Configuration.xml');
    await fsp.writeFile(target, 'old', 'utf8');
    const failingFileSystem: AtomicFileSystem = {
      readFile: (filePath) => fsp.readFile(filePath),
      open: (filePath, flags) => fsp.open(filePath, flags),
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
      assert.strictEqual(await fsp.readFile(outsideTarget, 'utf8'), 'outside');
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
