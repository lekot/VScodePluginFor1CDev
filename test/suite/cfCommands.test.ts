import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { vscodeTestState, resetVscodeTestState } from '../helpers/vscodeModuleStub';
import { registerCfCommands } from '../../src/commands/cfCommands';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';

function makeNode(overrides: Partial<TreeNode> & { type: MetadataType; filePath?: string }): TreeNode {
  return {
    id: overrides.id ?? overrides.type,
    name: overrides.name ?? overrides.type,
    type: overrides.type,
    properties: overrides.properties ?? {},
    children: overrides.children,
    filePath: overrides.filePath,
  };
}

suite('cfCommands', () => {
  setup(() => resetVscodeTestState());

  test('registers cf command handlers', () => {
    const disposables = registerCfCommands({ state: {} as any });

    assert.ok(vscodeTestState.registeredCommandIds.includes('1c-metadata-tree.cf.decompose'));
    assert.ok(vscodeTestState.registeredCommandIds.includes('1c-metadata-tree.cf.buildFromConfiguration'));
    assert.strictEqual(disposables.length, 2);
  });

  test('decompose command takes cf file node and picked output directory', async () => {
    const calls: Array<{ cfPath: string; outDir: string }> = [];
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), '1cviewer-cf-decompose-command-'));
    try {
      const cfPath = path.join(tempRoot, 'artifacts', '1Cv8.cf');
      const outDir = path.join(tempRoot, 'unpacked');
      await fs.mkdir(path.dirname(cfPath), { recursive: true });
      await fs.writeFile(cfPath, Buffer.from([1]));

      vscodeTestState.openDialogQueue.push([{ fsPath: outDir, scheme: 'file' }]);

      registerCfCommands({
        state: {} as any,
        service: {
          decomposeCfToXmlDirectory: async (params) => {
            calls.push({ cfPath: params.cfPath, outDir: params.outDir });
            assert.notStrictEqual(
              params.outDir,
              outDir,
              'command must decompose to staging before touching final dir'
            );
            await fs.mkdir(params.outDir, { recursive: true });
            await fs.writeFile(
              path.join(params.outDir, 'Configuration.xml'),
              '<Configuration/>',
              'utf-8'
            );
            return { status: 'success', userMessage: 'ok', logExcerpt: '', exitCode: 0 };
          },
          buildCfFromXmlConfiguration: async () => {
            throw new Error('not expected');
          },
        },
      });

      const node = makeNode({ type: MetadataType.ConfigurationPackage, filePath: cfPath });
      const handler = vscodeTestState.registeredCommandHandlers.get(
        '1c-metadata-tree.cf.decompose'
      );
      await handler?.(node);

      assert.strictEqual(calls[0]?.cfPath, cfPath);
      assert.ok(calls[0]?.outDir.includes('1cviewer-cf-decompose-'));
      assert.strictEqual(
        await fs.readFile(path.join(outDir, 'Configuration.xml'), 'utf-8'),
        '<Configuration/>'
      );
      await assert.rejects(fs.stat(path.dirname(calls[0].outDir)));
    } finally {
      if (calls[0]?.outDir) {
        await fs.rm(path.dirname(calls[0].outDir), { recursive: true, force: true });
      }
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('decompose removes staging after error and cancelled service results', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), '1cviewer-cf-result-cleanup-'));
    const stagingOutDirs: string[] = [];
    try {
      const cfPath = path.join(tempRoot, '1Cv8.cf');
      await fs.writeFile(cfPath, Buffer.from([1]));
      for (const status of ['error', 'cancelled'] as const) {
        resetVscodeTestState();
        const outDir = path.join(tempRoot, status);
        let stagingOutDir: string | undefined;
        vscodeTestState.openDialogQueue.push([{ fsPath: outDir, scheme: 'file' }]);
        registerCfCommands({
          state: {} as any,
          service: {
            decomposeCfToXmlDirectory: async (params) => {
              stagingOutDir = params.outDir;
              stagingOutDirs.push(params.outDir);
              return { status, userMessage: status, logExcerpt: '', exitCode: 1 };
            },
            buildCfFromXmlConfiguration: async () => {
              throw new Error('not expected');
            },
          },
        });

        const handler = vscodeTestState.registeredCommandHandlers.get(
          '1c-metadata-tree.cf.decompose'
        );
        await handler?.(makeNode({ type: MetadataType.ConfigurationPackage, filePath: cfPath }));

        assert.ok(stagingOutDir);
        await assert.rejects(fs.stat(path.dirname(stagingOutDir)));
      }
    } finally {
      for (const stagingOutDir of stagingOutDirs) {
        await fs.rm(path.dirname(stagingOutDir), { recursive: true, force: true });
      }
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('decompose removes staging when service throws and reports a non-copy error', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), '1cviewer-cf-service-throw-'));
    let stagingOutDir: string | undefined;
    try {
      const cfPath = path.join(tempRoot, '1Cv8.cf');
      const outDir = path.join(tempRoot, 'out');
      await fs.writeFile(cfPath, Buffer.from([1]));
      vscodeTestState.openDialogQueue.push([{ fsPath: outDir, scheme: 'file' }]);

      registerCfCommands({
        state: {} as any,
        service: {
          decomposeCfToXmlDirectory: async (params) => {
            stagingOutDir = params.outDir;
            throw new Error('service failed');
          },
          buildCfFromXmlConfiguration: async () => {
            throw new Error('not expected');
          },
        },
      });

      const handler = vscodeTestState.registeredCommandHandlers.get(
        '1c-metadata-tree.cf.decompose'
      );
      await handler?.(makeNode({ type: MetadataType.ConfigurationPackage, filePath: cfPath }));

      assert.ok(stagingOutDir);
      await assert.rejects(fs.stat(path.dirname(stagingOutDir)));
      assert.match(vscodeTestState.errorLog[0] ?? '', /service failed/);
      assert.doesNotMatch(vscodeTestState.errorLog[0] ?? '', /Staging/);
    } finally {
      if (stagingOutDir) {
        await fs.rm(path.dirname(stagingOutDir), { recursive: true, force: true });
      }
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('decompose preserves staging only when copying to the final directory throws', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), '1cviewer-cf-copy-throw-'));
    let stagingOutDir: string | undefined;
    try {
      const cfPath = path.join(tempRoot, '1Cv8.cf');
      const outDir = path.join(tempRoot, 'out');
      await fs.writeFile(cfPath, Buffer.from([1]));
      vscodeTestState.openDialogQueue.push([{ fsPath: outDir, scheme: 'file' }]);

      registerCfCommands({
        state: {} as any,
        service: {
          decomposeCfToXmlDirectory: async (params) => {
            stagingOutDir = params.outDir;
            await fs.mkdir(params.outDir, { recursive: true });
            await fs.writeFile(path.join(params.outDir, 'Configuration.xml'), '<Configuration/>');
            return { status: 'success', userMessage: 'ok', logExcerpt: '', exitCode: 0 };
          },
          buildCfFromXmlConfiguration: async () => {
            throw new Error('not expected');
          },
        },
        copyDirectory: async () => {
          throw new Error('copy failed');
        },
      });

      const handler = vscodeTestState.registeredCommandHandlers.get(
        '1c-metadata-tree.cf.decompose'
      );
      await handler?.(makeNode({ type: MetadataType.ConfigurationPackage, filePath: cfPath }));

      assert.ok(stagingOutDir);
      assert.strictEqual(
        await fs.readFile(path.join(stagingOutDir, 'Configuration.xml'), 'utf-8'),
        '<Configuration/>'
      );
      assert.match(vscodeTestState.errorLog[0] ?? '', /copy failed/);
      assert.ok((vscodeTestState.errorLog[0] ?? '').includes(stagingOutDir));
    } finally {
      if (stagingOutDir) {
        await fs.rm(path.dirname(stagingOutDir), { recursive: true, force: true });
      }
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('decompose removes staging when output directory preparation is cancelled', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), '1cviewer-cf-prepare-cancel-'));
    let stagingOutDir: string | undefined;
    try {
      const cfPath = path.join(tempRoot, '1Cv8.cf');
      const outDir = path.join(tempRoot, 'out');
      await fs.writeFile(cfPath, Buffer.from([1]));
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(path.join(outDir, 'keep.txt'), 'keep');
      vscodeTestState.openDialogQueue.push([{ fsPath: outDir, scheme: 'file' }]);
      vscodeTestState.warningMessageReturnQueue.push(undefined);

      registerCfCommands({
        state: {} as any,
        service: {
          decomposeCfToXmlDirectory: async (params) => {
            stagingOutDir = params.outDir;
            return { status: 'success', userMessage: 'ok', logExcerpt: '', exitCode: 0 };
          },
          buildCfFromXmlConfiguration: async () => {
            throw new Error('not expected');
          },
        },
      });

      const handler = vscodeTestState.registeredCommandHandlers.get(
        '1c-metadata-tree.cf.decompose'
      );
      await handler?.(makeNode({ type: MetadataType.ConfigurationPackage, filePath: cfPath }));

      assert.ok(stagingOutDir);
      await assert.rejects(fs.stat(path.dirname(stagingOutDir)));
      assert.strictEqual(await fs.readFile(path.join(outDir, 'keep.txt'), 'utf-8'), 'keep');
    } finally {
      if (stagingOutDir) {
        await fs.rm(path.dirname(stagingOutDir), { recursive: true, force: true });
      }
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('build command resolves configuration root and picked cf output file', async () => {
    const calls: Array<{ configRoot: string; outFile: string }> = [];
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), '1cviewer-cf-command-'));
    const configRoot = path.join(tempRoot, 'empty_conf');
    const outFile = path.join(tempRoot, 'build', '1Cv8.cf');
    await fs.mkdir(configRoot, { recursive: true });
    await fs.writeFile(path.join(configRoot, 'Configuration.xml'), '<Configuration/>', 'utf-8');

    vscodeTestState.saveDialogQueue.push({ fsPath: outFile, scheme: 'file' });

    registerCfCommands({
      state: {
        treeDataProvider: {
          getConfigPathForNode: () => configRoot,
          getConfigPath: () => undefined,
        },
      } as any,
      service: {
        decomposeCfToXmlDirectory: async () => {
          throw new Error('not expected');
        },
        buildCfFromXmlConfiguration: async (params) => {
          calls.push({ configRoot: params.configRoot, outFile: params.outFile });
          return { status: 'success', userMessage: 'ok', logExcerpt: '', exitCode: 0 };
        },
      },
    });

    const node = makeNode({ type: MetadataType.Configuration });
    const handler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.cf.buildFromConfiguration');
    await handler?.(node);

    assert.deepStrictEqual(calls, [{ configRoot, outFile }]);
  });
});
