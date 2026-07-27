import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SupportPayloadCache } from '../../src/support/supportPayloadCache';
import type {
  FileDatabaseStamp,
  SupportPayloadCacheKey,
} from '../../src/support/supportTypes';
import type { ConfigurationId } from '../../src/services/configurationSession/types';

suite('SupportPayloadCache', () => {
  let root: string;

  setup(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'support-payload-cache-test-'));
  });

  teardown(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('publishes immutable manifest through pointer and copies caller bytes', async () => {
    const cache = new SupportPayloadCache(root);
    const bytes = Buffer.from('supplier-payload');
    const stored = await cache.store({
      key: key(),
      databaseStamp: stamp(1),
      observedSemanticDigest: digest('a'),
      supplierFiles: [{
        supplierConfigurationId: 'supplier-a',
        relativePath: 'suppliers/a.cf',
        content: bytes,
      }],
    });
    bytes.fill(0);

    assert.strictEqual(Buffer.from(stored.supplierFiles[0]!.content).toString(), 'supplier-payload');
    const loaded = await cache.load(key(), stamp(1));
    assert.ok(loaded);
    assert.strictEqual(Buffer.from(loaded!.supplierFiles[0]!.content).toString(), 'supplier-payload');
    assert.strictEqual(Object.isFrozen(loaded), true);
    assert.strictEqual(Object.isFrozen(loaded!.supplierFiles), true);

    const keyRoot = await onlyDirectory(path.join(root, 'support-payload-cache-v1'));
    const pointer = JSON.parse(await fs.readFile(path.join(keyRoot, 'current.json'), 'utf8')) as {
      version: number;
      versionId: string;
    };
    const versionRoot = path.join(keyRoot, 'versions', pointer.versionId);
    const manifest = JSON.parse(await fs.readFile(path.join(versionRoot, 'manifest.json'), 'utf8')) as {
      versionId: string;
      supplierFiles: Array<{ storedName: string; sha256: string }>;
    };
    assert.strictEqual(pointer.version, 1);
    assert.strictEqual(manifest.versionId, pointer.versionId);
    assert.match(manifest.supplierFiles[0]!.sha256, /^[0-9a-f]{64}$/);
    await assert.rejects(
      fs.open(path.join(versionRoot, manifest.supplierFiles[0]!.storedName), 'wx'),
      /EEXIST/,
    );
  });

  test('acknowledge is stamp CAS and atomically publishes a new immutable version', async () => {
    const cache = new SupportPayloadCache(root);
    await cache.store(write(stamp(1)));
    const acknowledged = await cache.acknowledge(
      key(),
      stamp(1),
      stamp(2),
      digest('b'),
    );
    assert.ok(acknowledged);
    assert.strictEqual(acknowledged!.acknowledgedGenerationId, digest('b'));
    assert.deepStrictEqual(acknowledged!.databaseStamp, stamp(2));
    assert.strictEqual((await cache.load(key(), stamp(2)))?.acknowledgedGenerationId, digest('b'));

    const keyRoot = await onlyDirectory(path.join(root, 'support-payload-cache-v1'));
    const versions = await fs.readdir(path.join(keyRoot, 'versions'));
    assert.strictEqual(versions.filter((name) => !name.startsWith('.tmp-')).length, 1);

    const stale = await cache.acknowledge(key(), stamp(1), stamp(3), digest('c'));
    assert.strictEqual(stale, undefined);
    assert.strictEqual(await cache.load(key(), stamp(2)), undefined);
  });

  test('stamp mismatch or corrupt pointer fails closed and invalidates the key', async () => {
    const cache = new SupportPayloadCache(root);
    await cache.store(write(stamp(1)));
    assert.strictEqual(await cache.load(key(), stamp(9)), undefined);
    assert.strictEqual(await cache.load(key(), stamp(1)), undefined);

    await cache.store(write(stamp(1)));
    const keyRoot = await onlyDirectory(path.join(root, 'support-payload-cache-v1'));
    await fs.writeFile(path.join(keyRoot, 'current.json'), '{"version":1,"versionId":"../../escape"}');
    assert.strictEqual(await cache.load(key(), stamp(1)), undefined);
    await assert.rejects(fs.access(keyRoot));
  });
});

function key(): SupportPayloadCacheKey {
  return {
    canonicalTargetId: 'file:c:/db/base.1cd',
    platformVersion: '8.3.27.1000',
    configurationId: 'cfg-cache' as ConfigurationId,
    supplierConfigurationIds: ['supplier-a'],
    formatRevision: '6',
  };
}

function stamp(version: number): FileDatabaseStamp {
  return {
    resolvedPath: path.resolve(`base-${version}.1cd`),
    fileId: `file-${version}`,
    length: version,
    lastWriteTimeUtcTicks: String(version),
  };
}

function write(databaseStamp: FileDatabaseStamp) {
  return {
    key: key(),
    databaseStamp,
    observedSemanticDigest: digest('a'),
    supplierFiles: [{
      supplierConfigurationId: 'supplier-a',
      relativePath: 'suppliers/a.cf',
      content: Buffer.from('supplier-payload'),
    }],
  };
}

function digest(character: string): string {
  return character.repeat(64);
}

async function onlyDirectory(parent: string): Promise<string> {
  const names = await fs.readdir(parent);
  assert.strictEqual(names.length, 1);
  return path.join(parent, names[0]!);
}
