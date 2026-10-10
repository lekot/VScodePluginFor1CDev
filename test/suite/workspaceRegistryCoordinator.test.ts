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

  test('targeted fallback rejects configurations from outside or sibling workspace roots (#199 review)', async () => {
    const workWs = path.join(tempDir, 'work');
    const siblingWs = path.join(tempDir, 'work-extra');
    const outsideWs = path.join(tempDir, 'outside');
    const configSibling = await createTestConfiguration(path.join(siblingWs, 'configSib'), '44444444-4444-4444-4444-444444444444');
    const configOutside = await createTestConfiguration(path.join(outsideWs, 'configOut'), '55555555-5555-5555-5555-555555555555');
    await fs.promises.mkdir(workWs, { recursive: true });

    const registry = new WorkspaceRegistry();
    const coordinator = new WorkspaceRegistryCoordinator(registry, {
      getWorkspaceFolders: () => [workWs],
      getWorkspaceFolderForPath: (filePath: string) => {
        const rel = path.relative(workWs, filePath);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
          return workWs;
        }
        return undefined;
      },
    });

    try {
      await assert.rejects(
        async () => coordinator.resolveResource(configSibling),
        (err: unknown) => err instanceof WorkspaceRegistryError && err.code === 'CONFIGURATION_NOT_FOUND',
        'Sibling directory must NOT be treated as contained inside workspace folder',
      );

      await assert.rejects(
        async () => coordinator.resolveResource(configOutside),
        (err: unknown) => err instanceof WorkspaceRegistryError && err.code === 'CONFIGURATION_NOT_FOUND',
        'Outside directory must NOT be registered into workspace registry',
      );

      await assert.rejects(
        async () => coordinator.registerTargetedRoot({ configPath: configOutside, format: ConfigFormat.Designer }),
        (err: unknown) => err instanceof WorkspaceRegistryError && err.code === 'CONFIGURATION_NOT_FOUND',
      );
    } finally {
      await coordinator.dispose();
    }
  });

  test('resolving resource in one root does not access or stat unrelated roots (#199 review)', async () => {
    const registry = new WorkspaceRegistry();
    try {
      await registry.registerTargetedRoot({ configPath: configRootA, format: ConfigFormat.Designer });
      await registry.registerTargetedRoot({ configPath: configRootB, format: ConfigFormat.Designer });

      const originalAccess = fs.promises.access;
      const accessedRoots = new Map<string, number>();
      fs.promises.access = async (p: fs.PathLike, mode?: number) => {
        const str = p.toString();
        accessedRoots.set(str, (accessedRoots.get(str) ?? 0) + 1);
        return originalAccess(p, mode);
      };

      try {
        const targetFile = path.join(configRootA, 'Configuration.xml');
        for (let i = 0; i < 50; i++) {
          const session = await registry.resolveResource(targetFile);
          assert.strictEqual(session.identity.rootPath, configRootA);
        }

        const bAccesses = accessedRoots.get(configRootB) ?? 0;
        assert.strictEqual(bAccesses, 0, 'Unrelated roots must NOT be accessed when resolving a target in a different root (#199)');
      } finally {
        fs.promises.access = originalAccess;
      }
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
