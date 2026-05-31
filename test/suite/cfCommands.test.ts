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
          assert.notStrictEqual(params.outDir, outDir, 'command must decompose to staging before touching final dir');
          await fs.mkdir(params.outDir, { recursive: true });
          await fs.writeFile(path.join(params.outDir, 'Configuration.xml'), '<Configuration/>', 'utf-8');
          return { status: 'success', userMessage: 'ok', logExcerpt: '', exitCode: 0 };
        },
        buildCfFromXmlConfiguration: async () => {
          throw new Error('not expected');
        },
      },
    });

    const node = makeNode({ type: MetadataType.ConfigurationPackage, filePath: cfPath });
    const handler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.cf.decompose');
    await handler?.(node);

    assert.strictEqual(calls[0]?.cfPath, cfPath);
    assert.ok(calls[0]?.outDir.includes('1cviewer-cf-decompose-'));
    assert.strictEqual(
      await fs.readFile(path.join(outDir, 'Configuration.xml'), 'utf-8'),
      '<Configuration/>',
    );
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
