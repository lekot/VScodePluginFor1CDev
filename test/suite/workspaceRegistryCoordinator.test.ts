import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceRegistry, WorkspaceRegistryError } from '../../src/services/configurationSession/WorkspaceRegistry';
import { WorkspaceRegistryCoordinator } from '../../src/services/configurationSession/WorkspaceRegistryCoordinator';
import { ConfigFormat, FormatDetector } from '../../src/parsers/formatDetector';

suite('WorkspaceRegistryCoordinator and WorkspaceRegistry Lifecycle (#199)', () => {
  let tempDir: string;
  let workspaceRoot: string;
  let configRootA: string;
  let configRootB: string;

  setup(async () => {
    tempDir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'registry-lifecycle-')));
    workspaceRoot = path.join(tempDir, 'workspace');
    configRootA = await createTestConfiguration(path.join(workspaceRoot, 'configA'), '11111111-1111-1111-1111-111111111111');
    configRootB = await createTestConfiguration(path.join(workspaceRoot, 'configB'), '22222222-2222-2222-2222-222222222222');
  });

  teardown(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  });

  test('repeated 100 resolutions of known configuration do not repeatedly crawl the workspace', async () => {
    let globalScanCount = 0;
    const registry = new WorkspaceRegistry();
    const coordinator = new WorkspaceRegistryCoordinator(registry, {
      getWorkspaceFolders: () => [workspaceRoot],
      findAllConfigurationRoots: async (folders: string[]) => {
        globalScanCount++;
        return FormatDetector.findAllConfigurationRoots(folders);
      },
    });

    try {
      // First resolution triggers initial discovery
      const session1 = await coordinator.resolveResource(configRootA);
      assert.strictEqual(session1.identity.rootPath, await fs.promises.realpath(configRootA));
      assert.strictEqual(globalScanCount, 1, 'Initial discovery must run once');

      // 100 subsequent resolutions
      for (let i = 0; i < 100; i++) {
        const session = await coordinator.resolveResource(configRootA);
        assert.strictEqual(session.identity.configurationId, session1.identity.configurationId);
      }

      assert.strictEqual(globalScanCount, 1, 'Repeated resolutions must NOT trigger repeated global scans');
    } finally {
      await coordinator.dispose();
    }
  });

  test('getRegistry returns initialized registry without rescanning', async () => {
    let globalScanCount = 0;
    const registry = new WorkspaceRegistry();
    const coordinator = new WorkspaceRegistryCoordinator(registry, {
      getWorkspaceFolders: () => [workspaceRoot],
      findAllConfigurationRoots: async (folders: string[]) => {
        globalScanCount++;
        return FormatDetector.findAllConfigurationRoots(folders);
      },
    });

    try {
      const reg1 = await coordinator.getRegistry();
      assert.strictEqual(globalScanCount, 1);
      const reg2 = await coordinator.getRegistry();
      assert.strictEqual(reg2, reg1);
      assert.strictEqual(globalScanCount, 1, 'Subsequent getRegistry calls must not rescan');
      assert.strictEqual(reg1.list().length, 2);
    } finally {
      await coordinator.dispose();
    }
  });

  test('targeted discovery registers a new configuration root without a global scan', async () => {
    let globalScanCount = 0;
    const registry = new WorkspaceRegistry();
    const coordinator = new WorkspaceRegistryCoordinator(registry, {
      getWorkspaceFolders: () => [workspaceRoot],
      findAllConfigurationRoots: async (folders: string[]) => {
        globalScanCount++;
        return FormatDetector.findAllConfigurationRoots(folders);
      },
    });

    try {
      // Initial discovery runs
      await coordinator.getRegistry();
      assert.strictEqual(globalScanCount, 1);

      // Now create a 3rd configuration root dynamically
      const configRootC = await createTestConfiguration(path.join(workspaceRoot, 'configC'), '33333333-3333-3333-3333-333333333333');

      // Resolve configRootC: coordinator performs targeted detection, not full workspace scan
      const sessionC = await coordinator.resolveResource(configRootC);
      assert.strictEqual(sessionC.identity.rootPath, configRootC);
      assert.strictEqual(globalScanCount, 1, 'Targeted resolution must not trigger a full workspace scan');

      // Verify configC is now registered
      assert.strictEqual(registry.list().length, 3);
    } finally {
      await coordinator.dispose();
    }
  });

  test('resolveResource fails closed with CONFIGURATION_NOT_FOUND for non-configuration path', async () => {
    const registry = new WorkspaceRegistry();
    const coordinator = new WorkspaceRegistryCoordinator(registry, {
      getWorkspaceFolders: () => [workspaceRoot],
    });

    try {
      const nonConfigPath = path.join(workspaceRoot, 'notAConfig', 'someFile.txt');
      await fs.promises.mkdir(path.dirname(nonConfigPath), { recursive: true });
      await fs.promises.writeFile(nonConfigPath, 'hello', 'utf8');

      await assert.rejects(
        async () => coordinator.resolveResource(nonConfigPath),
        (err: unknown) => err instanceof WorkspaceRegistryError && err.code === 'CONFIGURATION_NOT_FOUND',
      );
    } finally {
      await coordinator.dispose();
    }
  });

  test('targeted validation invalidates stale session when root directory is deleted on disk', async () => {
    const registry = new WorkspaceRegistry();
    const coordinator = new WorkspaceRegistryCoordinator(registry, {
      getWorkspaceFolders: () => [workspaceRoot],
    });

    try {
      const sessionA = await coordinator.resolveResource(configRootA);
      assert.ok(sessionA);

      // Delete configRootA on disk
      await fs.promises.rm(configRootA, { recursive: true, force: true });

      // Resolving configRootA now must detect stale root, invalidate, and fail closed
      await assert.rejects(
        async () => coordinator.resolveResource(configRootA),
        (err: unknown) => err instanceof WorkspaceRegistryError && err.code === 'CONFIGURATION_NOT_FOUND',
      );

      // Verify configA was removed from descriptors
      const remainingRoots = registry.list().map((d) => d.rootPath);
      assert.ok(!remainingRoots.includes(configRootA));
      assert.ok(remainingRoots.includes(configRootB));
    } finally {
      await coordinator.dispose();
    }
  });

  test('refreshWorkspace explicitly rescans and reconciles workspace roots', async () => {
    let globalScanCount = 0;
    const registry = new WorkspaceRegistry();
    const coordinator = new WorkspaceRegistryCoordinator(registry, {
      getWorkspaceFolders: () => [workspaceRoot],
      findAllConfigurationRoots: async (folders: string[]) => {
        globalScanCount++;
        return FormatDetector.findAllConfigurationRoots(folders);
      },
    });

    try {
      await coordinator.getRegistry();
      assert.strictEqual(globalScanCount, 1);
      assert.strictEqual(registry.list().length, 2);

      // Explicit refresh
      await coordinator.refreshWorkspace();
      assert.strictEqual(globalScanCount, 2, 'refreshWorkspace must trigger scan');
    } finally {
      await coordinator.dispose();
    }
  });

  test('registerTargetedRoot and unregisterTargetedRoot directly manipulate single root in WorkspaceRegistry', async () => {
    const registry = new WorkspaceRegistry();
    try {
      await registry.registerTargetedRoot({ configPath: configRootA, format: ConfigFormat.Designer });
      assert.strictEqual(registry.list().length, 1);
      assert.strictEqual(registry.list()[0]!.rootPath, configRootA);

      await registry.registerTargetedRoot({ configPath: configRootB, format: ConfigFormat.Designer });
      assert.strictEqual(registry.list().length, 2);

      await registry.unregisterTargetedRoot(configRootA);
      assert.strictEqual(registry.list().length, 1);
      assert.strictEqual(registry.list()[0]!.rootPath, configRootB);
    } finally {
      await registry.dispose();
    }
  });
});

async function createTestConfiguration(root: string, uuid: string): Promise<string> {
  await fs.promises.mkdir(root, { recursive: true });
  await fs.promises.writeFile(
    path.join(root, 'Configuration.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">\n<Configuration uuid="${uuid}"><ChildObjects/></Configuration>\n</MetaDataObject>\n`,
    'utf8',
  );
  return fs.promises.realpath(root);
}
