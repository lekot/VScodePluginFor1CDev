import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { AgentCfeProjectOperations } from '../../src/agent/agentCfeProjectOperations';
import { registerCfeProjectCommands } from '../../src/extensionSupport/cfeProject/cfeProjectCommands';
import { CfeProjectManifestError, CfeProjectManifestStorage } from '../../src/extensionSupport/cfeProject/manifest';
import { CfeProjectService } from '../../src/extensionSupport/cfeProject/createProject';
import { CfeProjectServiceFactory } from '../../src/extensionSupport/cfeProject/serviceFactory';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

const CONTAINED_OBJECT_CLASS_IDS = [
  '9cd510cd-abfc-11d4-9434-004095e12fc7', '9fcd25a0-4822-11d4-9414-008048da11f9',
  'e3687481-0a87-462c-a166-9f34594f9bba', '9de14907-ec23-4a07-96f0-85521cb6b53b',
  '51f2d5d8-ea4d-4064-8892-82951750031e', 'e68182ea-4237-4383-967f-90c1e3370bc7',
  'fb282519-d103-4dd3-bc12-cb271d631dfc',
];

suite('CFE project scaffold', () => {
  let workspace: string;
  let base: string;
  let registry: WorkspaceRegistry;

  setup(async () => {
    resetVscodeTestState();
    workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cfe-project-'));
    base = await createBaseConfiguration(workspace);
    registry = new WorkspaceRegistry();
    await registry.refresh([{ configPath: base, workspaceFolderPath: workspace }]);
  });

  teardown(async () => {
    await registry.dispose();
    await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
    resetVscodeTestState();
  });

  test('creates a valid 2.17 CFE scaffold, stores its relation atomically and refreshes sessions', async () => {
    const service = new CfeProjectService(workspace, registry, {
      refreshWorkspace: async () => registry.refresh([
        { configPath: base, workspaceFolderPath: workspace },
        { configPath: path.join(base, 'ConfigurationExtensions', 'TestExtension'), workspaceFolderPath: workspace },
      ]),
    });
    const baseId = registry.list()[0]!.configurationId;

    const result = await service.createProject({
      baseConfigurationId: baseId,
      extensionName: 'TestExtension',
      purpose: 'Customization',
      namePrefix: 'Ext_',
      compatibilityMode: 'Version8_3_24',
      includeDefaultRole: true,
    });

    assert.strictEqual(result.status, 'created');
    const extension = path.join(base, 'ConfigurationExtensions', 'TestExtension');
    const xml = await fs.promises.readFile(path.join(extension, 'Configuration.xml'), 'utf8');
    assert.match(xml, /<MetaDataObject[^>]*version="2\.17"/);
    assert.match(xml, /<ConfigurationExtensionPurpose>Customization<\/ConfigurationExtensionPurpose>/);
    assert.match(xml, /<DefaultLanguage>Language\.Русский<\/DefaultLanguage>/);
    assert.strictEqual((xml.match(/<xr:ContainedObject>/g) ?? []).length, 7);
    assert.deepStrictEqual(classIds(xml), CONTAINED_OBJECT_CLASS_IDS);
    assert.ok(await fileExists(path.join(extension, 'Languages', 'Русский.xml')));
    assert.ok(await fileExists(path.join(extension, 'Roles', 'Ext_ОсновнаяРоль.xml')));
    assert.strictEqual(await fileExists(path.join(extension, 'ConfigDumpInfo.xml')), false);

    const manifest = JSON.parse(await fs.promises.readFile(path.join(workspace, '.vscode', 'cfe-projects.json'), 'utf8')) as { version: number; projects: Array<{ baseConfiguration: string; extensionConfiguration: string }> };
    assert.strictEqual(manifest.version, 1);
    assert.deepStrictEqual(manifest.projects[0], { baseConfiguration: 'base', extensionConfiguration: 'base/ConfigurationExtensions/TestExtension', extensionName: 'TestExtension' });
    const context = await service.getContext(baseId);
    assert.strictEqual(context.extensionRoot, await fs.promises.realpath(extension));
    assert.strictEqual(context.namePrefix, 'Ext_');
    assert.strictEqual(context.baseFingerprint.length, 64);
  });

  test('rejects traversal and duplicate extension records before persisting manifest', async () => {
    const storage = new CfeProjectManifestStorage(workspace);
    await assert.rejects(
      () => storage.upsert({ baseConfiguration: '../base', extensionConfiguration: 'cfe', extensionName: 'Bad' }),
      /переходом в родительский каталог/i,
    );
    await fs.promises.mkdir(path.join(workspace, 'cfe-a'));
    await fs.promises.mkdir(path.join(workspace, 'cfe-b'));
    await storage.upsert({ baseConfiguration: 'base', extensionConfiguration: 'cfe-a', extensionName: 'One' });
    await assert.rejects(
      () => storage.upsert({ baseConfiguration: 'other-base', extensionConfiguration: 'cfe-a', extensionName: 'Two' }),
      (error: CfeProjectManifestError) => /уникальны/i.test(error.message),
    );
  });

  test('strictly validates scaffold input and defaults an empty name prefix', async () => {
    const service = new CfeProjectService(workspace, registry);
    const baseConfigurationId = registry.list()[0]!.configurationId;
    await assert.rejects(
      () => service.createProject({ baseConfigurationId, extensionName: '../unsafe', purpose: 'Customization', namePrefix: '', compatibilityMode: 'Version8_3_24' }),
      (error: { code?: string }) => error.code === 'CFE_VALIDATION_FAILED',
    );
    await assert.rejects(
      () => service.createProject({ baseConfigurationId, extensionName: 'Unsafe', purpose: 'Customization', namePrefix: '' as unknown as string, compatibilityMode: 824 as unknown as string }),
      (error: { code?: string }) => error.code === 'CFE_VALIDATION_FAILED',
    );
    await assert.rejects(
      () => service.createProject({ baseConfigurationId, extensionName: 'UnsafeTarget', purpose: 'Customization', namePrefix: '', compatibilityMode: 'Version8_3_24', target: 42 as unknown as string }),
      (error: { code?: string }) => error.code === 'CFE_VALIDATION_FAILED',
    );
    await service.createProject({ baseConfigurationId, extensionName: 'DefaultPrefix', purpose: 'Customization', namePrefix: '', compatibilityMode: 'Version8_3_24' });
    const xml = await fs.promises.readFile(path.join(base, 'ConfigurationExtensions', 'DefaultPrefix', 'Configuration.xml'), 'utf8');
    assert.match(xml, /<NamePrefix>DefaultPrefix_<\/NamePrefix>/);
  });

  test('preserves every supported Designer XML format from 2.17 through 2.21', async () => {
    const created: string[] = [];
    const service = new CfeProjectService(workspace, registry, {
      refreshWorkspace: async () => registry.refresh([
        { configPath: base, workspaceFolderPath: workspace },
        ...created.map((configPath) => ({ configPath, workspaceFolderPath: workspace })),
      ]),
    });
    const baseId = registry.list()[0]!.configurationId;
    for (const format of ['2.17', '2.18', '2.19', '2.20', '2.21']) {
      await fs.promises.writeFile(
        path.join(base, 'Configuration.xml'),
        `<?xml version="1.0"?><MetaDataObject version="${format}"><Configuration uuid="11111111-1111-1111-1111-111111111111"><Properties><DefaultLanguage>Language.Русский</DefaultLanguage></Properties></Configuration></MetaDataObject>`,
        'utf8',
      );
      const extension = path.join(base, 'ConfigurationExtensions', `Format${format.replace('.', '')}`);
      created.push(extension);
      const result = await service.createProject({
        baseConfigurationId: baseId,
        extensionName: path.basename(extension),
        purpose: 'Patch',
        namePrefix: 'Patch_',
        compatibilityMode: 'Version8_3_24',
      });
      assert.strictEqual(result.status, 'created');
      const xml = await fs.promises.readFile(path.join(extension, 'Configuration.xml'), 'utf8');
      assert.match(xml, new RegExp(`version="${format.replace('.', '\\.')}"`));
      assert.strictEqual((xml.match(/<xr:ContainedObject>/g) ?? []).length, 7);
      assert.deepStrictEqual(classIds(xml), CONTAINED_OBJECT_CLASS_IDS);
      if (format === '2.21') {
        assert.match(xml, /xmlns:pal="http:\/\/v8\.1c\.ru\/8\.1\/data\/ui\/colors\/palette"/);
        assert.match(xml, /<Caption\/><ShortCaption\/>/);
      } else {
        assert.doesNotMatch(xml, /xmlns:pal=/);
        assert.doesNotMatch(xml, /<Caption\/>/);
      }
    }
  });

  test('rejects a manifest path that escapes workspace through a symbolic link', async function () {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cfe-outside-'));
    const link = path.join(workspace, 'outside-link');
    try {
      await fs.promises.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      await fs.promises.rm(outside, { recursive: true, force: true });
      this.skip();
      return;
    }
    try {
      const storage = new CfeProjectManifestStorage(workspace);
      await assert.rejects(
        () => storage.upsert({ baseConfiguration: 'base', extensionConfiguration: 'outside-link/cfe', extensionName: 'Unsafe' }),
      );
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test('uses dot for a base configuration rooted at workspace', async () => {
    await createBaseConfigurationAt(workspace, '2.20', 'English', 'en', 'English');
    await registry.dispose();
    registry = new WorkspaceRegistry();
    await registry.refresh([{ configPath: workspace, workspaceFolderPath: workspace }]);
    const service = new CfeProjectService(workspace, registry, {
      refreshWorkspace: async () => registry.refresh([
        { configPath: workspace, workspaceFolderPath: workspace },
        { configPath: path.join(workspace, 'ConfigurationExtensions', 'RootExtension'), workspaceFolderPath: workspace },
      ]),
    });

    const workspaceRealPath = await fs.promises.realpath(workspace);
    await service.createProject({
      baseConfigurationId: registry.list().find((item) => item.rootPath === workspaceRealPath)!.configurationId,
      extensionName: 'RootExtension', purpose: 'AddOn', namePrefix: '', compatibilityMode: 'DontUse',
    });
    const manifest = JSON.parse(await fs.promises.readFile(path.join(workspace, '.vscode', 'cfe-projects.json'), 'utf8')) as { projects: Array<{ baseConfiguration: string }> };
    assert.strictEqual(manifest.projects[0]!.baseConfiguration, '.');
    const xml = await fs.promises.readFile(path.join(workspace, 'ConfigurationExtensions', 'RootExtension', 'Configuration.xml'), 'utf8');
    assert.match(xml, /<NamePrefix>RootExtension_<\/NamePrefix>/);
    assert.match(xml, /<v8:lang>en<\/v8:lang>/);
    assert.match(xml, /<ScriptVariant>English<\/ScriptVariant>/);
  });

  test('uses the base language, script variant and interface compatibility mode', async () => {
    await createBaseConfigurationAt(base, '2.20', 'English', 'en', 'English', 'Version8_3_27', 'TaxiEnableVersion8_3');
    await registry.refresh([{ configPath: base, workspaceFolderPath: workspace }]);
    const service = new CfeProjectService(workspace, registry);
    await service.createProject({
      baseConfigurationId: registry.list()[0]!.configurationId,
      extensionName: 'EnglishExtension', purpose: 'Customization', namePrefix: '', compatibilityMode: 'Version8_3_27',
    });
    const extension = path.join(base, 'ConfigurationExtensions', 'EnglishExtension');
    const [configurationXml, languageXml] = await Promise.all([
      fs.promises.readFile(path.join(extension, 'Configuration.xml'), 'utf8'),
      fs.promises.readFile(path.join(extension, 'Languages', 'English.xml'), 'utf8'),
    ]);
    assert.match(configurationXml, /<v8:lang>en<\/v8:lang>/);
    assert.match(configurationXml, /<ScriptVariant>English<\/ScriptVariant>/);
    assert.match(configurationXml, /<InterfaceCompatibilityMode>TaxiEnableVersion8_3<\/InterfaceCompatibilityMode>/);
    assert.match(languageXml, /<LanguageCode>en<\/LanguageCode>/);
  });

  test('compensates published directory when manifest upsert fails', async () => {
    const manifest = new CfeProjectManifestStorage(workspace);
    const originalUpsert = manifest.upsert.bind(manifest);
    manifest.upsert = async () => { throw new Error('injected manifest failure'); };
    const service = new CfeProjectService(workspace, registry, { manifestStorage: manifest });
    await assert.rejects(
      () => service.createProject({
        baseConfigurationId: registry.list()[0]!.configurationId,
        extensionName: 'ManifestFailure', purpose: 'Customization', namePrefix: 'Failure_', compatibilityMode: 'Version8_3_24',
      }),
      /injected manifest failure/,
    );
    assert.strictEqual(await fileExists(path.join(base, 'ConfigurationExtensions', 'ManifestFailure')), false);
    manifest.upsert = originalUpsert;
  });

  test('writes recovery journal and reports unknown outcome when compensation fails', async () => {
    const manifest = new CfeProjectManifestStorage(workspace);
    manifest.upsert = async () => { throw new Error('injected manifest failure'); };
    const service = new CfeProjectService(workspace, registry, {
      manifestStorage: manifest,
      removePublishedDirectory: async () => new Error('injected rollback failure'),
    });
    const outcome = await service.createProject({
      baseConfigurationId: registry.list()[0]!.configurationId,
      extensionName: 'UnknownOutcome', purpose: 'Customization', namePrefix: 'Unknown_', compatibilityMode: 'Version8_3_24',
    });
    assert.deepStrictEqual({ status: outcome.status, code: outcome.code }, { status: 'outcome-unknown', code: 'CFE_OUTCOME_UNKNOWN' });
    assert.ok(outcome.recoveryJournalPath);
    assert.ok(await fileExists(outcome.recoveryJournalPath!));
    assert.ok(await fileExists(path.join(base, 'ConfigurationExtensions', 'UnknownOutcome')));
  });

  test('serializes concurrent manifest upserts from separate base sessions', async () => {
    const secondBase = path.join(workspace, 'base-two');
    await createBaseConfigurationAt(secondBase, '2.20', 'Русский', 'ru', 'Russian');
    const storageA = new CfeProjectManifestStorage(workspace);
    const storageB = new CfeProjectManifestStorage(workspace);
    await Promise.all([
      storageA.upsert({ baseConfiguration: 'base', extensionConfiguration: 'base/ConfigurationExtensions/One', extensionName: 'One' }),
      storageB.upsert({ baseConfiguration: 'base-two', extensionConfiguration: 'base-two/ConfigurationExtensions/Two', extensionName: 'Two' }),
    ]);
    const manifest = await storageA.read();
    assert.deepStrictEqual(manifest.projects.map((project) => project.extensionName).sort(), ['One', 'Two']);
  });

  test('resolves each of two CFE projects by its extension session id', async () => {
    const extensions: string[] = [];
    const service = new CfeProjectService(workspace, registry, {
      refreshWorkspace: async () => registry.refresh([
        { configPath: base, workspaceFolderPath: workspace },
        ...extensions.map((configPath) => ({ configPath, workspaceFolderPath: workspace })),
      ]),
    });
    const baseId = registry.list()[0]!.configurationId;
    for (const extensionName of ['First', 'Second']) {
      const extension = path.join(base, 'ConfigurationExtensions', extensionName);
      extensions.push(extension);
      await service.createProject({ baseConfigurationId: baseId, extensionName, purpose: 'Customization', namePrefix: '', compatibilityMode: 'Version8_3_24' });
    }
    const projects = await service.listProjects();
    assert.strictEqual(projects.length, 2);
    for (const project of projects) {
      const resolved = await service.getContextByExtension(project.extensionSession.identity.configurationId);
      assert.strictEqual(resolved.extensionRoot, project.extensionRoot);
    }
    await assert.rejects(() => service.getContext(baseId), (error: { code?: string }) => error.code === 'CFE_RELATION_AMBIGUOUS');
  });

  test('validates manifest extensionName with the shared 1C identifier contract', async () => {
    const storage = new CfeProjectManifestStorage(workspace);
    await assert.rejects(
      () => storage.upsert({ baseConfiguration: 'base', extensionConfiguration: 'extension', extensionName: 'Процедура' }),
      (error: CfeProjectManifestError) => /некорректные поля/i.test(error.message),
    );
  });

  test('Agent CFE create refreshes registry and lifecycle and returns a JSON-safe DTO', async () => {
    await registry.refresh([{ configPath: base, workspaceFolderPath: workspace }]);
    let lifecycleRefreshes = 0;
    const operations = new AgentCfeProjectOperations(
      async () => registry,
      async () => {
        await registry.refresh([
          { configPath: base, workspaceFolderPath: workspace },
          { configPath: path.join(base, 'ConfigurationExtensions', 'AgentExtension'), workspaceFolderPath: workspace },
        ]);
        lifecycleRefreshes += 1;
      },
    );
    const baseId = registry.list()[0]!.configurationId;
    const outcome = await operations.createProject({
      baseConfigurationId: baseId, extensionName: 'AgentExtension', purpose: 'Customization',
      namePrefix: 'Agent_', compatibilityMode: 'Version8_3_24',
    });

    assert.strictEqual(outcome.success, true, outcome.error);
    assert.strictEqual(lifecycleRefreshes, 1);
    assert.strictEqual(outcome.data?.status, 'created');
    assert.ok(outcome.data?.context);
    assert.ok(outcome.data.context.extensionConfigurationId.length > 0);
    const serialized = JSON.stringify(outcome);
    assert.ok(!serialized.includes('baseSession'));
    assert.ok(!serialized.includes(await fs.promises.realpath(base)));
  });

  test('service factory rejects a configuration that belongs to multiple workspace roots', async () => {
    await registry.refresh([
      { configPath: base, workspaceFolderPath: workspace },
      { configPath: base, workspaceFolderPath: path.dirname(workspace) },
    ]);
    const baseId = registry.list()[0]!.configurationId;
    assert.throws(
      () => new CfeProjectServiceFactory(registry).forConfiguration(baseId),
      (error: { code?: string }) => error.code === 'CFE_RELATION_AMBIGUOUS',
    );
  });

  test('UI command creates only from a base root and refreshes the tree', async () => {
    await registry.refresh([{ configPath: base, workspaceFolderPath: workspace }]);
    let treeRefreshes = 0;
    registerCfeProjectCommands({
      context: { subscriptions: [] } as never,
      state: {
        treeDataProvider: { getConfigPathForNode: () => base },
      } as never,
      getConfigurationRegistry: async () => registry,
      refreshTree: async () => { treeRefreshes += 1; },
    });
    vscodeTestState.inputBoxQueue.push('UiExtension', 'Ui_');
    vscodeTestState.quickPickQueue.push(
      { label: 'Доработка', value: 'Customization' },
      { label: 'Версия 8.3.24', value: 'Version8_3_24' },
    );
    const handler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.cfe.createProject')!;
    await handler(baseRootNode());
    assert.strictEqual(treeRefreshes, 1);
    assert.ok(vscodeTestState.informationLog.some((message) => message.includes('UiExtension')));

    const filesBefore = await fs.promises.readdir(path.join(base, 'ConfigurationExtensions'));
    await handler(cfeRootNode());
    assert.ok(vscodeTestState.warningLog.some((message) => message.includes('основной конфигурации')));
    assert.deepStrictEqual(await fs.promises.readdir(path.join(base, 'ConfigurationExtensions')), filesBefore);
  });
});

function baseRootNode(): TreeNode {
  return { id: 'root', name: 'Configuration', type: MetadataType.Configuration, properties: {}, children: [] };
}

function cfeRootNode(): TreeNode {
  return {
    id: 'root', name: 'Configuration', type: MetadataType.Configuration,
    properties: { extensionPurpose: 'Customization' }, children: [],
  };
}

async function createBaseConfiguration(workspace: string): Promise<string> {
  const root = path.join(workspace, 'base');
  await createBaseConfigurationAt(root, '2.17', 'Русский', 'ru', 'Russian');
  return fs.promises.realpath(root);
}

async function createBaseConfigurationAt(
  root: string,
  format: string,
  languageName: string,
  languageCode: string,
  scriptVariant: string,
  compatibilityMode = 'Version8_3_24',
  interfaceCompatibilityMode = 'TaxiEnableVersion8_2',
): Promise<void> {
  await fs.promises.mkdir(path.join(root, 'Languages'), { recursive: true });
  await fs.promises.writeFile(
    path.join(root, 'Configuration.xml'),
    `<?xml version="1.0"?><MetaDataObject version="${format}"><Configuration uuid="11111111-1111-1111-1111-111111111111"><Properties><DefaultLanguage>Language.${languageName}</DefaultLanguage><ScriptVariant>${scriptVariant}</ScriptVariant><ConfigurationExtensionCompatibilityMode>${compatibilityMode}</ConfigurationExtensionCompatibilityMode><InterfaceCompatibilityMode>${interfaceCompatibilityMode}</InterfaceCompatibilityMode></Properties><ChildObjects><Language>${languageName}</Language></ChildObjects></Configuration></MetaDataObject>`,
    'utf8',
  );
  await fs.promises.writeFile(path.join(root, 'Languages', `${languageName}.xml`), `<MetaDataObject version="${format}"><Language uuid="22222222-2222-2222-2222-222222222222"><Properties><LanguageCode>${languageCode}</LanguageCode></Properties></Language></MetaDataObject>`, 'utf8');
}

async function fileExists(target: string): Promise<boolean> {
  try { await fs.promises.access(target); return true; } catch { return false; }
}

function classIds(xml: string): string[] {
  return [...xml.matchAll(/<xr:ClassId>([^<]+)<\/xr:ClassId>/g)].map((match) => match[1]!);
}
