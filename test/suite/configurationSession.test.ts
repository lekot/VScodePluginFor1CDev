import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceRegistry, WorkspaceRegistryError } from '../../src/services/configurationSession/WorkspaceRegistry';
import { resolveAgentConfiguration } from '../../src/agent/agentConfigurationResolver';

suite('ConfigurationSession and WorkspaceRegistry', () => {
  let tempDir: string;

  setup(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'configuration-session-'));
  });

  teardown(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test('requires an exact selector in multi-root and preserves single-root legacy routing', async () => {
    const rootA = await createConfiguration(tempDir, 'a', '11111111-1111-1111-1111-111111111111');
    const rootB = await createConfiguration(tempDir, 'b', '22222222-2222-2222-2222-222222222222');
    const registry = new WorkspaceRegistry();
    try {
      await registry.refresh([{ configPath: rootA }, { configPath: rootB }]);
      assert.throws(
        () => resolveAgentConfiguration(registry, {}, 'write'),
        (error: WorkspaceRegistryError) => error.code === 'CONFIGURATION_SELECTION_REQUIRED',
      );

      const descriptors = registry.list();
      assert.strictEqual(descriptors.length, 2);
      const selected = resolveAgentConfiguration(
        registry,
        { configurationId: descriptors.find((item) => item.rootPath === rootB)!.configurationId },
        'write',
      );
      assert.strictEqual(selected.identity.rootPath, rootB);

      await registry.refresh([{ configPath: rootA }]);
      assert.strictEqual(resolveAgentConfiguration(registry, {}, 'write').identity.rootPath, rootA);
    } finally {
      await registry.dispose();
    }
  });

  test('deduplicates a physical configuration discovered through a junction alias', async function () {
    const root = await createConfiguration(tempDir, 'physical', '33333333-3333-3333-3333-333333333333');
    const alias = path.join(tempDir, 'alias');
    try {
      await fs.promises.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      this.skip();
      return;
    }
    const registry = new WorkspaceRegistry();
    try {
      await registry.refresh([{ configPath: root }, { configPath: alias }]);
      assert.strictEqual(registry.list().length, 1);
    } finally {
      await registry.dispose();
    }
  });

  test('serializes one configuration FIFO without blocking another configuration', async () => {
    const rootA = await createConfiguration(tempDir, 'queue-a', '44444444-4444-4444-4444-444444444444');
    const rootB = await createConfiguration(tempDir, 'queue-b', '55555555-5555-5555-5555-555555555555');
    const registry = new WorkspaceRegistry();
    await registry.refresh([{ configPath: rootA }, { configPath: rootB }]);
    const [sessionA, sessionB] = registry.list().map((descriptor) => registry.require(descriptor.configurationId));
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = sessionA.enqueue({
      kind: 'first',
      execute: async () => {
        order.push('a1-start');
        await firstGate;
        order.push('a1-end');
        return 1;
      },
    });
    const second = sessionA.enqueue({
      kind: 'second',
      execute: async () => {
        order.push('a2');
        return 2;
      },
    });
    const independent = sessionB.enqueue({
      kind: 'independent',
      execute: async () => {
        order.push('b1');
        return 3;
      },
    });

    await independent;
    assert.deepStrictEqual(order, ['a1-start', 'b1']);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepStrictEqual(order, ['a1-start', 'b1', 'a1-end', 'a2']);
    await registry.dispose();
  });

  test('persists random identity, promotes degraded discovery and tombstones descriptor replacement', async () => {
    const root = path.join(tempDir, 'persistent');
    const storePath = path.join(tempDir, 'registry', 'identities.json');
    await fs.promises.mkdir(root, { recursive: true });
    const degradedRegistry = new WorkspaceRegistry(storePath);
    await degradedRegistry.refresh([{ configPath: root }]);
    const degraded = degradedRegistry.list()[0]!;
    assert.strictEqual(degraded.health, 'degraded');
    assert.strictEqual(degraded.capabilities.write, false);
    assert.match(degraded.configurationId, /^cfg-[0-9a-f-]{36}$/i);
    await degradedRegistry.dispose();

    await fs.promises.writeFile(
      path.join(root, 'Configuration.xml'),
      '<MetaDataObject><Configuration uuid="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"/></MetaDataObject>',
      'utf8',
    );
    const promotedRegistry = new WorkspaceRegistry(storePath);
    await promotedRegistry.refresh([{ configPath: root }]);
    const promoted = promotedRegistry.list()[0]!;
    assert.strictEqual(promoted.configurationId, degraded.configurationId);
    assert.strictEqual(promoted.health, 'ready');
    await promotedRegistry.dispose();

    await fs.promises.writeFile(
      path.join(root, 'Configuration.xml'),
      '<MetaDataObject><Configuration uuid="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"/></MetaDataObject>',
      'utf8',
    );
    const replacedRegistry = new WorkspaceRegistry(storePath);
    await replacedRegistry.refresh([{ configPath: root }]);
    const replaced = replacedRegistry.list()[0]!;
    assert.notStrictEqual(replaced.configurationId, promoted.configurationId);
    const persisted = JSON.parse(await fs.promises.readFile(storePath, 'utf8')) as {
      tombstones: Array<{ configurationId: string; reason: string }>;
    };
    assert.ok(persisted.tombstones.some(
      (entry) => entry.configurationId === promoted.configurationId && entry.reason === 'descriptor-replaced',
    ));
    await replacedRegistry.dispose();
  });
});

async function createConfiguration(parent: string, name: string, uuid: string): Promise<string> {
  const root = path.join(parent, name);
  await fs.promises.mkdir(root, { recursive: true });
  await fs.promises.writeFile(
    path.join(root, 'Configuration.xml'),
    `<MetaDataObject><Configuration uuid="${uuid}"><ChildObjects/></Configuration></MetaDataObject>`,
    'utf8',
  );
  return fs.promises.realpath(root);
}
