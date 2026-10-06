import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { parseSourceAddress, resolveAgentPath, AgentPathError } from '../../src/agent/agentPathResolver';
import { resolveSourceAddress } from '../../src/agent/agentSourceAddressResolver';
import { registerAgentCommands } from '../../src/agent/agentCommands';
import { DebugSessionRegistry } from '../../src/agent/debugSessionRegistry';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import { CfeProjectRegistry } from '../../src/extensionSupport/cfeProject/registry';
import { CfeProjectManifestStorage } from '../../src/extensionSupport/cfeProject/manifest';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';
import type { AgentResult } from '../../src/agent/types';

const UUID_BASE = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const UUID_EXT = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const UUID_GOODS_BASE = '11111111-1111-4111-8111-111111111111';
const UUID_GOODS_EXT = '22222222-2222-4222-8222-222222222222';

suite('Agent source address resolution (Issue #135)', () => {
  let tempDir: string;
  let workspaceRoot: string;
  let baseRoot: string;
  let extRoot: string;
  let registry: WorkspaceRegistry;

  setup(async () => {
    resetVscodeTestState();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-source-address-'));
    workspaceRoot = path.join(tempDir, 'workspace');
    baseRoot = path.join(workspaceRoot, 'base');
    extRoot = path.join(workspaceRoot, 'ConfigurationExtensions', 'ExtShop');

    await fs.promises.mkdir(path.join(baseRoot, 'Catalogs', 'Goods'), { recursive: true });
    await fs.promises.writeFile(
      path.join(baseRoot, 'Configuration.xml'),
      `<MetaDataObject version="2.20"><Configuration uuid="${UUID_BASE}"><ChildObjects><Catalog>Goods</Catalog></ChildObjects></Configuration></MetaDataObject>`,
      'utf8',
    );
    await fs.promises.writeFile(
      path.join(baseRoot, 'Catalogs', 'Goods.xml'),
      `<MetaDataObject version="2.20"><Catalog uuid="${UUID_GOODS_BASE}"><Properties><Name>Goods</Name></Properties><ChildObjects/></Catalog></MetaDataObject>`,
      'utf8',
    );

    await fs.promises.mkdir(path.join(extRoot, 'Catalogs', 'Goods'), { recursive: true });
    await fs.promises.writeFile(
      path.join(extRoot, 'Configuration.xml'),
      `<MetaDataObject version="2.20"><Configuration uuid="${UUID_EXT}"><Properties><Name>ExtShop</Name><ConfigurationExtensionPurpose>Customization</ConfigurationExtensionPurpose><NamePrefix>Ext_</NamePrefix><ConfigurationExtensionCompatibilityMode>Version8_3_24</ConfigurationExtensionCompatibilityMode></Properties><ChildObjects><Catalog>Goods</Catalog></ChildObjects></Configuration></MetaDataObject>`,
      'utf8',
    );
    await fs.promises.writeFile(
      path.join(extRoot, 'Catalogs', 'Goods.xml'),
      `<MetaDataObject version="2.20"><Catalog uuid="${UUID_GOODS_EXT}"><Properties><Name>Goods</Name><Comment>ExtensionGoods</Comment></Properties><ChildObjects/></Catalog></MetaDataObject>`,
      'utf8',
    );

    const manifestStorage = new CfeProjectManifestStorage(workspaceRoot);
    await manifestStorage.writeAtomic({
      version: 1,
      projects: [{
        baseConfiguration: 'base',
        extensionConfiguration: 'ConfigurationExtensions/ExtShop',
        extensionName: 'ExtShop',
      }],
    });

    registry = new WorkspaceRegistry();
    await registry.refresh([
      { configPath: baseRoot, workspaceFolderPath: workspaceRoot },
      { configPath: extRoot, workspaceFolderPath: workspaceRoot },
    ]);
  });

  teardown(async () => {
    await registry.dispose();
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    resetVscodeTestState();
  });

  suite('parseSourceAddress', () => {
    test('parses main: prefix', () => {
      const parsed = parseSourceAddress('main:Catalog.Goods');
      assert.strictEqual(parsed.sourceSet, 'main');
      assert.strictEqual(parsed.dotPath, 'Catalog.Goods');
    });

    test('parses extension prefix with nested segments', () => {
      const parsed = parseSourceAddress('ExtShop:Catalog.Goods.Attribute.Price');
      assert.strictEqual(parsed.sourceSet, 'ExtShop');
      assert.strictEqual(parsed.dotPath, 'Catalog.Goods.Attribute.Price');
    });

    test('parses address without prefix as undefined sourceSet', () => {
      const parsed = parseSourceAddress('Catalog.Goods');
      assert.strictEqual(parsed.sourceSet, undefined);
      assert.strictEqual(parsed.dotPath, 'Catalog.Goods');
    });

    test('rejects empty sourceSet before colon', () => {
      assert.throws(
        () => parseSourceAddress(':Catalog.Goods'),
        (err: Error) => err instanceof AgentPathError && err.code === 'INVALID_AGENT_PATH',
      );
    });

    test('rejects empty dotPath after colon', () => {
      assert.throws(
        () => parseSourceAddress('main:'),
        (err: Error) => err instanceof AgentPathError && err.code === 'INVALID_AGENT_PATH',
      );
    });

    test('handles Windows drive letter without treating as sourceSet', () => {
      const parsed = parseSourceAddress('C:\\reps\\1cviewer\\Catalogs\\Goods.xml');
      assert.strictEqual(parsed.sourceSet, undefined);
      assert.strictEqual(parsed.dotPath, 'C:\\reps\\1cviewer\\Catalogs\\Goods.xml');
    });

    test('parses Cyrillic extension prefix and dotPath', () => {
      const parsed = parseSourceAddress('Расширение_1:Catalog.Товары');
      assert.strictEqual(parsed.sourceSet, 'Расширение_1');
      assert.strictEqual(parsed.dotPath, 'Catalog.Товары');
    });

    test('rejects multiple colons in address', () => {
      assert.throws(
        () => parseSourceAddress('main:ext:Catalog.Goods'),
        (err: Error) => err instanceof AgentPathError && err.code === 'INVALID_AGENT_PATH',
      );
    });

    test('rejects invalid sourceSet identifier syntax', () => {
      assert.throws(
        () => parseSourceAddress('invalid prefix:Catalog.Goods'),
        (err: Error) => err instanceof AgentPathError && err.code === 'INVALID_AGENT_PATH',
      );
    });
  });

  suite('resolveAgentPath with sourceSet', () => {
    test('attaches sourceSet main when resolving main:Catalog.Goods', () => {
      const resolved = resolveAgentPath(baseRoot, 'main:Catalog.Goods');
      assert.strictEqual(resolved.rootTag, 'Catalog');
      assert.strictEqual(resolved.objectName, 'Goods');
      assert.strictEqual(resolved.sourceSet, 'main');
      assert.strictEqual(resolved.filePath, path.join(baseRoot, 'Catalogs', 'Goods.xml'));
    });

    test('attaches sourceSet ExtShop when resolving ExtShop:Catalog.Goods.Attribute.Price', () => {
      const resolved = resolveAgentPath(extRoot, 'ExtShop:Catalog.Goods.Attribute.Price');
      assert.strictEqual(resolved.rootTag, 'Catalog');
      assert.strictEqual(resolved.objectName, 'Goods');
      assert.strictEqual(resolved.nestedType, 'Attribute');
      assert.strictEqual(resolved.nestedName, 'Price');
      assert.strictEqual(resolved.sourceSet, 'ExtShop');
      assert.strictEqual(resolved.filePath, path.join(extRoot, 'Catalogs', 'Goods.xml'));
    });

    test('leaves sourceSet undefined for unprefixed legacy paths', () => {
      const resolved = resolveAgentPath(baseRoot, 'Catalog.Goods');
      assert.strictEqual(resolved.rootTag, 'Catalog');
      assert.strictEqual(resolved.objectName, 'Goods');
      assert.strictEqual(resolved.sourceSet, undefined);
      assert.strictEqual(resolved.filePath, path.join(baseRoot, 'Catalogs', 'Goods.xml'));
    });
  });

  suite('resolveSourceAddress', () => {
    test('resolves main:Catalog.Goods to base session', async () => {
      const result = await resolveSourceAddress({ address: 'main:Catalog.Goods' }, {
        registry,
        workspaceRoot,
      });

      assert.strictEqual(result.sourceSet, 'main');
      assert.strictEqual(result.dotPath, 'Catalog.Goods');
      assert.strictEqual(result.configRoot, await fs.promises.realpath(baseRoot));
      assert.strictEqual(result.resolvedPath.objectName, 'Goods');
      assert.strictEqual(result.resolvedPath.filePath, path.join(result.configRoot, 'Catalogs', 'Goods.xml'));
      assert.strictEqual(result.cfeContext, undefined);
    });

    test('resolves ExtShop:Catalog.Goods to extension session with CFE context', async () => {
      const result = await resolveSourceAddress({ address: 'ExtShop:Catalog.Goods' }, {
        registry,
        workspaceRoot,
      });

      assert.strictEqual(result.sourceSet, 'ExtShop');
      assert.strictEqual(result.dotPath, 'Catalog.Goods');
      assert.strictEqual(result.configRoot, await fs.promises.realpath(extRoot));
      assert.strictEqual(result.resolvedPath.objectName, 'Goods');
      assert.strictEqual(result.resolvedPath.filePath, path.join(result.configRoot, 'Catalogs', 'Goods.xml'));
      assert.ok(result.cfeContext);
      assert.strictEqual(result.cfeContext.extensionName, 'ExtShop');
    });

    test('resolves unprefixed Catalog.Goods to main: by default', async () => {
      const result = await resolveSourceAddress({ address: 'Catalog.Goods' }, {
        registry,
        workspaceRoot,
      });

      assert.strictEqual(result.sourceSet, 'main');
      assert.strictEqual(result.dotPath, 'Catalog.Goods');
      assert.strictEqual(result.configRoot, await fs.promises.realpath(baseRoot));
    });

    test('throws typed error when source set is unknown', async () => {
      await assert.rejects(
        resolveSourceAddress({ address: 'UnknownExt:Catalog.Goods' }, {
          registry,
          workspaceRoot,
        }),
        (err: Error) => err instanceof AgentPathError && err.code === 'INVALID_AGENT_PATH' && err.message.includes('UnknownExt'),
      );
    });

    test('throws typed error when configurationId conflicts with sourceSet', async () => {
      const canonicalBase = await fs.promises.realpath(baseRoot);
      const baseSession = registry.list().find((item) => item.rootPath === canonicalBase)!;
      await assert.rejects(
        resolveSourceAddress({ address: 'ExtShop:Catalog.Goods', configurationId: baseSession.configurationId }, {
          registry,
          workspaceRoot,
        }),
        (err: Error) => err instanceof AgentPathError && err.code === 'INVALID_AGENT_PATH' && err.message.includes('conflicts with source set'),
      );
    });

    test('resolves generic cfe: prefix when single CFE project exists in workspace', async () => {
      const result = await resolveSourceAddress({ address: 'cfe:Catalog.Goods' }, {
        registry,
        workspaceRoot,
      });

      assert.strictEqual(result.sourceSet, 'cfe');
      assert.strictEqual(result.dotPath, 'Catalog.Goods');
      assert.strictEqual(result.configRoot, await fs.promises.realpath(extRoot));
      assert.strictEqual(result.resolvedPath.objectName, 'Goods');
      assert.ok(result.cfeContext);
      assert.strictEqual(result.cfeContext.extensionName, 'ExtShop');
    });

    test('allows explicit extension configurationId with unprefixed dotPath without false conflict', async () => {
      const canonicalExt = await fs.promises.realpath(extRoot);
      const extSession = registry.list().find((item) => item.rootPath === canonicalExt)!;
      const result = await resolveSourceAddress({ address: 'Catalog.Goods', configurationId: extSession.configurationId }, {
        registry,
        workspaceRoot,
      });

      assert.strictEqual(result.configRoot, canonicalExt);
      assert.strictEqual(result.session.identity.configurationId, extSession.configurationId);
    });
  });

  suite('Agent commands transparent prefix routing', () => {
    setup(() => {
      const context = { subscriptions: [] as Array<{ dispose(): void }> };
      registerAgentCommands(
        context as never,
        () => null,
        async () => registry,
        new DebugSessionRegistry(),
      );
    });

    test('getProperties routes to extension when ExtShop: prefix is used', async () => {
      const getPropertiesHandler = vscodeTestState.registeredCommandHandlers.get(
        '1c-metadata-tree.agent.getProperties',
      )!;

      const result = await getPropertiesHandler({ path: 'ExtShop:Catalog.Goods' }) as AgentResult<{ properties: Record<string, unknown> }>;
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(result.data?.properties?.Comment, 'ExtensionGoods');
    });

    test('getProperties routes to base configuration when main: prefix is used', async () => {
      const getPropertiesHandler = vscodeTestState.registeredCommandHandlers.get(
        '1c-metadata-tree.agent.getProperties',
      )!;

      const result = await getPropertiesHandler({ path: 'main:Catalog.Goods' }) as AgentResult<{ properties: Record<string, unknown> }>;
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(result.data?.properties?.Comment, undefined);
    });

    test('addAttribute routes mutation to extension when ExtShop: prefix is used', async () => {
      const addAttributeHandler = vscodeTestState.registeredCommandHandlers.get(
        '1c-metadata-tree.agent.addAttribute',
      )!;

      const result = await addAttributeHandler({ path: 'ExtShop:Catalog.Goods', name: 'Ext_Barcode' }) as AgentResult<{ filePath: string }>;
      assert.strictEqual(result.success, true, result.error);
      assert.ok(result.operationId);

      const extXml = await fs.promises.readFile(path.join(extRoot, 'Catalogs', 'Goods.xml'), 'utf8');
      assert.ok(extXml.includes('Ext_Barcode'));

      const baseXml = await fs.promises.readFile(path.join(baseRoot, 'Catalogs', 'Goods.xml'), 'utf8');
      assert.strictEqual(baseXml.includes('Ext_Barcode'), false, 'base configuration must not be touched');
    });

    test('resolveSourceAddress command is registered and executes correctly', async () => {
      const resolveHandler = vscodeTestState.registeredCommandHandlers.get(
        '1c-metadata-tree.agent.resolveSourceAddress',
      )!;
      assert.ok(resolveHandler, '1c-metadata-tree.agent.resolveSourceAddress must be registered');

      const result = await resolveHandler({ address: 'ExtShop:Catalog.Goods' }) as AgentResult<{
        sourceSet: string;
        dotPath: string;
        configRoot: string;
      }>;
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(result.data?.sourceSet, 'ExtShop');
      assert.strictEqual(result.data?.dotPath, 'Catalog.Goods');
      assert.strictEqual(result.data?.configRoot, await fs.promises.realpath(extRoot));
    });

    test('getYaml routes to extension when ExtShop: prefix is used', async () => {
      const getYamlHandler = vscodeTestState.registeredCommandHandlers.get(
        '1c-metadata-tree.agent.getYaml',
      )!;

      const result = await getYamlHandler({ path: 'ExtShop:Catalog.Goods' }) as AgentResult<{ yaml: string }>;
      assert.strictEqual(result.success, true, result.error);
      assert.ok(result.data?.yaml);
    });

    test('deleteAttribute routes mutation to extension when ExtShop: prefix is used', async () => {
      const addAttributeHandler = vscodeTestState.registeredCommandHandlers.get(
        '1c-metadata-tree.agent.addAttribute',
      )!;
      await addAttributeHandler({ path: 'ExtShop:Catalog.Goods', name: 'Ext_ToDelete' });

      const deleteAttributeHandler = vscodeTestState.registeredCommandHandlers.get(
        '1c-metadata-tree.agent.deleteAttribute',
      )!;
      const deleteResult = await deleteAttributeHandler({
        path: 'ExtShop:Catalog.Goods.Attribute.Ext_ToDelete',
      }) as AgentResult;
      assert.strictEqual(deleteResult.success, true, deleteResult.error);

      const extXml = await fs.promises.readFile(path.join(extRoot, 'Catalogs', 'Goods.xml'), 'utf8');
      assert.strictEqual(extXml.includes('Ext_ToDelete'), false, 'Ext_ToDelete must be deleted from extension');
    });
  });
});
