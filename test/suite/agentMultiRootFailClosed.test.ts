import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { resolveBindingCommand } from '../../src/agent/agentBindingResolver';
import { findWorkspaceFolderForPath } from '../../src/agent/agentWorkspaceContext';
import { resolveSourceAddress } from '../../src/agent/agentSourceAddressResolver';
import { AgentPathError } from '../../src/agent/agentPathResolver';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import { CfeProjectManifestStorage } from '../../src/extensionSupport/cfeProject/manifest';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';
import type { ConfigurationBinding } from '../../src/bindings/models/configurationBinding';

suite('Agent Multi-Root Fail-Closed Routing (Issue #197)', () => {
  let tmpA: string;
  let tmpB: string;

  setup(async () => {
    resetVscodeTestState();
    const rawBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mr-routing-'));
    const base = await fs.promises.realpath(rawBase);
    tmpA = path.join(base, 'wsA');
    tmpB = path.join(base, 'wsB');
    await fs.promises.mkdir(tmpA, { recursive: true });
    await fs.promises.mkdir(tmpB, { recursive: true });

    vscodeTestState.mockWorkspaceFolders = [
      { uri: { fsPath: tmpA, scheme: 'file' }, name: 'folderA', index: 0 },
      { uri: { fsPath: tmpB, scheme: 'file' }, name: 'folderB', index: 1 },
    ];

  });

  teardown(async () => {
    resetVscodeTestState();
    const parent = path.dirname(tmpA);
    await fs.promises.rm(parent, { recursive: true, force: true }).catch(() => undefined);
  });

  test('findWorkspaceFolderForPath returns undefined when path is outside workspace', () => {
    const outside = path.join(os.tmpdir(), 'completely-outside-path');
    const folder = findWorkspaceFolderForPath(outside);
    assert.strictEqual(folder, undefined, 'Path outside workspace must not resolve to any folder');
  });

  test('findWorkspaceFolderForPath matches exact workspace folder', () => {
    const insideB = path.join(tmpB, 'src', 'Configuration.xml');
    const folder = findWorkspaceFolderForPath(insideB);
    assert.ok(folder);
    assert.strictEqual(folder?.name, 'folderB');
  });

  test('resolveBindingCommand fails closed when matched.workspaceFolder does not exist', async () => {
    const binding: ConfigurationBinding = {
      configRelativePath: 'src',
      workspaceFolder: 'nonExistentFolder',
      infobaseIds: [],
      massDeployment: false,
    };
    const deps = {
      bindingManager: { listAll: async () => [binding] },
      infobaseManager: { listAll: async () => [] },
    };

    const result = await resolveBindingCommand({ configPath: 'src' }, deps as any);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('nonExistentFolder') || result.error?.includes('не найдена'));
  });

  test('resolveBindingCommand succeeds when single-root even if workspaceFolder is omitted', async () => {
    vscodeTestState.mockWorkspaceFolders = [
      { uri: { fsPath: tmpA, scheme: 'file' }, name: 'folderA', index: 0 },
    ];
    const binding: ConfigurationBinding = {
      configRelativePath: 'src',
      workspaceFolder: '',
      infobaseIds: [],
      massDeployment: false,
    };
    const deps = {
      bindingManager: { listAll: async () => [binding] },
      infobaseManager: { listAll: async () => [] },
    };

    const result = await resolveBindingCommand({ configPath: 'src' }, deps as any);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data?.configPath, path.join(tmpA, 'src'));
  });

  test('resolveBindingCommand fails closed when multi-root and workspaceFolder is omitted', async () => {
    vscodeTestState.mockWorkspaceFolders = [
      { uri: { fsPath: tmpA, scheme: 'file' }, name: 'folderA', index: 0 },
      { uri: { fsPath: tmpB, scheme: 'file' }, name: 'folderB', index: 1 },
    ];
    const binding: ConfigurationBinding = {
      configRelativePath: 'src',
      workspaceFolder: '',
      infobaseIds: [],
      massDeployment: false,
    };
    const deps = {
      bindingManager: { listAll: async () => [binding] },
      infobaseManager: { listAll: async () => [] },
    };

    const result = await resolveBindingCommand({ configPath: 'src' }, deps as any);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('не указана целевая папка') || result.error?.includes('workspaceFolder'));
  });

  test('findWorkspaceFolderForPath handles case variations on Windows', () => {
    if (process.platform !== 'win32') {
      return;
    }
    const mixedCase = path.join(tmpB.toUpperCase(), 'src', 'Configuration.xml');
    const folder = findWorkspaceFolderForPath(mixedCase);
    assert.ok(folder);
    assert.strictEqual(folder?.name, 'folderB');
  });

  test('multiple CFE projects with same extensionName across roots fail closed without configurationId (#197, PR #226 review)', async () => {
    const baseA = path.join(tmpA, 'base');
    const extA = path.join(tmpA, 'ConfigurationExtensions', 'ExtShop');
    const baseB = path.join(tmpB, 'base');
    const extB = path.join(tmpB, 'ConfigurationExtensions', 'ExtShop');

    await fs.promises.mkdir(path.join(baseA, 'Catalogs', 'Goods'), { recursive: true });
    await fs.promises.writeFile(
      path.join(baseA, 'Configuration.xml'),
      '<MetaDataObject version="2.20"><Configuration uuid="11111111-1111-4111-8111-111111111111"><ChildObjects><Catalog>Goods</Catalog></ChildObjects></Configuration></MetaDataObject>',
      'utf8',
    );
    await fs.promises.writeFile(
      path.join(baseA, 'Catalogs', 'Goods.xml'),
      '<MetaDataObject version="2.20"><Catalog uuid="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"><Properties><Name>Goods</Name></Properties><ChildObjects/></Catalog></MetaDataObject>',
      'utf8',
    );

    await fs.promises.mkdir(path.join(extA, 'Catalogs', 'Goods'), { recursive: true });
    await fs.promises.writeFile(
      path.join(extA, 'Configuration.xml'),
      '<MetaDataObject version="2.20"><Configuration uuid="22222222-2222-4222-8222-222222222222"><Properties><Name>ExtShop</Name><ConfigurationExtensionPurpose>Customization</ConfigurationExtensionPurpose></Properties><ChildObjects><Catalog>Goods</Catalog></ChildObjects></Configuration></MetaDataObject>',
      'utf8',
    );
    await fs.promises.writeFile(
      path.join(extA, 'Catalogs', 'Goods.xml'),
      '<MetaDataObject version="2.20"><Catalog uuid="bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"><Properties><Name>Goods</Name></Properties><ChildObjects/></Catalog></MetaDataObject>',
      'utf8',
    );

    await fs.promises.mkdir(path.join(baseB, 'Catalogs', 'Goods'), { recursive: true });
    await fs.promises.writeFile(
      path.join(baseB, 'Configuration.xml'),
      '<MetaDataObject version="2.20"><Configuration uuid="33333333-3333-4333-8333-333333333333"><ChildObjects><Catalog>Goods</Catalog></ChildObjects></Configuration></MetaDataObject>',
      'utf8',
    );
    await fs.promises.writeFile(
      path.join(baseB, 'Catalogs', 'Goods.xml'),
      '<MetaDataObject version="2.20"><Catalog uuid="cccccccc-cccc-4ccc-cccc-cccccccccccc"><Properties><Name>Goods</Name></Properties><ChildObjects/></Catalog></MetaDataObject>',
      'utf8',
    );

    await fs.promises.mkdir(path.join(extB, 'Catalogs', 'Goods'), { recursive: true });
    await fs.promises.writeFile(
      path.join(extB, 'Configuration.xml'),
      '<MetaDataObject version="2.20"><Configuration uuid="44444444-4444-4444-8444-444444444444"><Properties><Name>ExtShop</Name><ConfigurationExtensionPurpose>Customization</ConfigurationExtensionPurpose></Properties><ChildObjects><Catalog>Goods</Catalog></ChildObjects></Configuration></MetaDataObject>',
      'utf8',
    );
    await fs.promises.writeFile(
      path.join(extB, 'Catalogs', 'Goods.xml'),
      '<MetaDataObject version="2.20"><Catalog uuid="dddddddd-dddd-4ddd-dddd-dddddddddddd"><Properties><Name>Goods</Name></Properties><ChildObjects/></Catalog></MetaDataObject>',
      'utf8',
    );

    const storageA = new CfeProjectManifestStorage(tmpA);
    await storageA.writeAtomic({
      version: 1,
      projects: [{ extensionName: 'ExtShop', extensionConfiguration: 'ConfigurationExtensions/ExtShop', baseConfiguration: 'base' }],
    });

    const storageB = new CfeProjectManifestStorage(tmpB);
    await storageB.writeAtomic({
      version: 1,
      projects: [{ extensionName: 'ExtShop', extensionConfiguration: 'ConfigurationExtensions/ExtShop', baseConfiguration: 'base' }],
    });

    const registry = new WorkspaceRegistry();
    await registry.refresh([
      { configPath: baseA, workspaceFolderPath: tmpA },
      { configPath: extA, workspaceFolderPath: tmpA },
      { configPath: baseB, workspaceFolderPath: tmpB },
      { configPath: extB, workspaceFolderPath: tmpB },
    ]);

    const sessionBaseA = await registry.resolveResource(baseA);
    const sessionExtA = await registry.resolveResource(extA);
    const sessionBaseB = await registry.resolveResource(baseB);
    const sessionExtB = await registry.resolveResource(extB);

    const context = { registry, workspaceRoot: undefined };

    // 1. main: with two different base sessions must fail closed
    await assert.rejects(
      async () => await resolveSourceAddress({ address: 'main:Catalog.Goods' }, context),
      (err: any) => err instanceof AgentPathError && err.code === 'INVALID_AGENT_PATH' && err.message.includes('Multiple base configurations found in workspace'),
    );

    // 2. ExtShop: with two same-named projects across roots must fail closed without configurationId
    await assert.rejects(
      async () => await resolveSourceAddress({ address: 'ExtShop:Catalog.Goods' }, context),
      (err: any) => err instanceof AgentPathError && err.code === 'INVALID_AGENT_PATH' && err.message.includes('Multiple CFE projects named "ExtShop"'),
    );

    // 3. cfe: with multiple CFE projects must fail closed
    await assert.rejects(
      async () => await resolveSourceAddress({ address: 'cfe:Catalog.Goods' }, context),
      (err: any) => err instanceof AgentPathError && err.code === 'INVALID_AGENT_PATH' && err.message.includes('Multiple CFE extension projects found'),
    );

    // 4. ExtShop: with conflicting configurationId (e.g. base session) must reject
    await assert.rejects(
      async () => await resolveSourceAddress({ address: 'ExtShop:Catalog.Goods', configurationId: sessionBaseA.identity.configurationId }, context),
      (err: any) => err instanceof AgentPathError && err.code === 'INVALID_AGENT_PATH' && err.message.includes('conflicts with source set "ExtShop"'),
    );

    // 5. With explicit configurationId pointing to extA, routes to extA
    const resA = await resolveSourceAddress({ address: 'ExtShop:Catalog.Goods', configurationId: sessionExtA.identity.configurationId }, context);
    assert.strictEqual(resA.session.identity.configurationId, sessionExtA.identity.configurationId);

    // 6. With explicit configurationId pointing to extB, routes to extB
    const resB = await resolveSourceAddress({ address: 'ExtShop:Catalog.Goods', configurationId: sessionExtB.identity.configurationId }, context);
    assert.strictEqual(resB.session.identity.configurationId, sessionExtB.identity.configurationId);

    // 7. main: with explicit configurationId pointing to baseA or baseB routes correctly
    const mainA = await resolveSourceAddress({ address: 'main:Catalog.Goods', configurationId: sessionBaseA.identity.configurationId }, context);
    assert.strictEqual(mainA.session.identity.configurationId, sessionBaseA.identity.configurationId);

    const mainB = await resolveSourceAddress({ address: 'main:Catalog.Goods', configurationId: sessionBaseB.identity.configurationId }, context);
    assert.strictEqual(mainB.session.identity.configurationId, sessionBaseB.identity.configurationId);
  });
});



