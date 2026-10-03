import * as assert from 'assert';
import * as fs from 'fs';
import NodeModule = require('module');
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import '../helpers/vscodeStubRegister';
import { registerConfigurationProjectCommands, CREATE_CONFIGURATION_PROJECT_COMMAND } from '../../src/configurationProject/configurationProjectCommands';
import {
  CONFIGURATION_PROJECT_FORMAT_VERSION,
  ConfigurationProjectError,
  ConfigurationProjectService,
} from '../../src/configurationProject/configurationProjectService';
import { FormatDetector } from '../../src/parsers/formatDetector';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

const CONTAINED_OBJECT_CLASS_IDS = [
  '9cd510cd-abfc-11d4-9434-004095e12fc7',
  '9fcd25a0-4822-11d4-9414-008048da11f9',
  'e3687481-0a87-462c-a166-9f34594f9bba',
  '9de14907-ec23-4a07-96f0-85521cb6b53b',
  '51f2d5d8-ea4d-4064-8892-82951750031e',
  'e68182ea-4237-4383-967f-90c1e3370bc7',
  'fb282519-d103-4dd3-bc12-cb271d631dfc',
] as const;

interface CompiledPackageModule extends NodeJS.Module {
  _compile(content: string, filename: string): void;
  filename: string;
  path: string;
  paths: string[];
}

interface ModuleLoader {
  new(id: string, parent?: NodeJS.Module): CompiledPackageModule;
  _nodeModulePaths(from: string): string[];
}

function createTestConfigurationProjectService(): ConfigurationProjectService {
  return new ConfigurationProjectService({
    templateDirectory: path.join(process.cwd(), 'resources', 'configuration-project'),
  });
}

suite('Configuration project scaffold', () => {
  let workspace: string;

  setup(async () => {
    resetVscodeTestState();
    workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'configuration-project-'));
  });

  teardown(async () => {
    await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    resetVscodeTestState();
  });

  test('creates a canonical 2.20 Russian scaffold and exposes it to workspace discovery', async () => {
    const result = await createTestConfigurationProjectService().createProject({
      workspaceRoot: workspace,
      targetRelativePath: 'MainConfiguration',
      name: 'MainConfiguration',
    });

    const canonicalWorkspace = await fs.promises.realpath(workspace);
    assert.strictEqual(result.rootPath, path.join(canonicalWorkspace, 'MainConfiguration'));
    assert.strictEqual(result.formatVersion, CONFIGURATION_PROJECT_FORMAT_VERSION);
    const configurationXml = await fs.promises.readFile(path.join(result.rootPath, 'Configuration.xml'), 'utf8');
    const languageXml = await fs.promises.readFile(path.join(result.rootPath, 'Languages', 'Русский.xml'), 'utf8');
    const dumpInfoXml = await fs.promises.readFile(path.join(result.rootPath, 'ConfigDumpInfo.xml'), 'utf8');

    assert.match(configurationXml, /<MetaDataObject[^>]*version="2\.20"/);
    assert.match(configurationXml, /<Name>MainConfiguration<\/Name>/);
    assert.match(configurationXml, /<DefaultLanguage>Language\.Русский<\/DefaultLanguage>/);
    assert.deepStrictEqual(
      [...configurationXml.matchAll(/<xr:ClassId>([^<]+)<\/xr:ClassId>/g)].map((match) => match[1]),
      CONTAINED_OBJECT_CLASS_IDS,
    );
    assert.doesNotMatch(configurationXml, /ConfigurationExtensionPurpose|ExtendedConfigurationObject|ObjectBelonging/);
    assert.match(languageXml, /<LanguageCode>ru<\/LanguageCode>/);
    assert.match(dumpInfoXml, /format="Hierarchical" version="2\.20"/);
    assert.match(dumpInfoXml, /<ConfigVersions\/>/);
    assert.doesNotMatch(dumpInfoXml, /<Metadata\b|configVersion=/);

    const discovery = await FormatDetector.discoverAllConfigurationRoots([canonicalWorkspace]);
    assert.strictEqual(discovery.status, 'authoritative');
    assert.deepStrictEqual(discovery.items.map(({ configPath }) => configPath), [result.rootPath]);
  });

  test('creates an English profile with matching root language and script variant', async () => {
    const result = await createTestConfigurationProjectService().createProject({
      workspaceRoot: workspace,
      targetRelativePath: 'EnglishConfiguration',
      name: 'EnglishConfiguration',
      language: 'en',
    });
    const configurationXml = await fs.promises.readFile(path.join(result.rootPath, 'Configuration.xml'), 'utf8');
    const languageXml = await fs.promises.readFile(path.join(result.rootPath, 'Languages', 'English.xml'), 'utf8');

    assert.match(configurationXml, /<DefaultLanguage>Language\.English<\/DefaultLanguage>/);
    assert.match(configurationXml, /<Language>English<\/Language>/);
    assert.match(configurationXml, /<ScriptVariant>English<\/ScriptVariant>/);
    assert.match(languageXml, /<Name>English<\/Name>/);
    assert.match(languageXml, /<LanguageCode>en<\/LanguageCode>/);
    await assert.rejects(fs.promises.access(path.join(result.rootPath, 'Languages', 'Русский.xml')));
  });

  test('loads the bundled profile from a compiled extension layout without an override', async () => {
    const extensionRoot = path.join(workspace, 'packaged-extension');
    const distRoot = path.join(extensionRoot, 'dist');
    const serviceOutput = path.join(process.cwd(), 'out', 'src', 'configurationProject');
    await fs.promises.cp(serviceOutput, path.join(distRoot, 'configurationProject'), { recursive: true });
    await fs.promises.mkdir(path.join(distRoot, 'services', 'configurationSession'), { recursive: true });
    await fs.promises.copyFile(
      path.join(process.cwd(), 'out', 'src', 'services', 'configurationSession', 'pathBoundary.js'),
      path.join(distRoot, 'services', 'configurationSession', 'pathBoundary.js'),
    );
    await fs.promises.mkdir(path.join(distRoot, 'utils'), { recursive: true });
    await fs.promises.copyFile(
      path.join(process.cwd(), 'out', 'src', 'utils', 'elementNameValidator.js'),
      path.join(distRoot, 'utils', 'elementNameValidator.js'),
    );
    await fs.promises.cp(
      path.join(process.cwd(), 'resources', 'configuration-project'),
      path.join(extensionRoot, 'resources', 'configuration-project'),
      { recursive: true },
    );

    const packagedModulePath = path.join(distRoot, 'configurationProject', 'configurationProjectService.js');
    const ModuleLoaderClass = NodeModule as unknown as ModuleLoader;
    const packagedModule = new ModuleLoaderClass(packagedModulePath, module);
    packagedModule.filename = packagedModulePath;
    packagedModule.path = path.dirname(packagedModulePath);
    packagedModule.paths = ModuleLoaderClass._nodeModulePaths(process.cwd());
    packagedModule._compile(await fs.promises.readFile(packagedModulePath, 'utf8'), packagedModulePath);
    const PackagedConfigurationProjectService = packagedModule.exports.ConfigurationProjectService as
      typeof ConfigurationProjectService;

    const result = await new PackagedConfigurationProjectService().createProject({
      workspaceRoot: workspace,
      targetRelativePath: 'PackagedConfiguration',
      name: 'PackagedConfiguration',
    });
    assert.strictEqual(result.formatVersion, CONFIGURATION_PROJECT_FORMAT_VERSION);
    assert.ok(await fs.promises.stat(path.join(result.rootPath, 'Configuration.xml')));
  });

  test('rejects traversal and an existing target without changing its contents', async () => {
    const service = createTestConfigurationProjectService();
    await assert.rejects(
      () => service.createProject({
        workspaceRoot: workspace,
        targetRelativePath: '../escaped',
        name: 'Escaped',
      }),
      (error: ConfigurationProjectError) => error.code === 'CONFIGURATION_PROJECT_INVALID_REQUEST',
    );
    await assert.rejects(fs.promises.access(path.join(path.dirname(workspace), 'escaped')));

    const target = path.join(workspace, 'ExistingConfiguration');
    await fs.promises.mkdir(target);
    await fs.promises.writeFile(path.join(target, 'keep.txt'), 'preserve');
    await assert.rejects(
      () => service.createProject({
        workspaceRoot: workspace,
        targetRelativePath: 'ExistingConfiguration',
        name: 'ExistingConfiguration',
      }),
      (error: ConfigurationProjectError) => error.code === 'CONFIGURATION_PROJECT_PATH_CONFLICT',
    );
    assert.strictEqual(await fs.promises.readFile(path.join(target, 'keep.txt'), 'utf8'), 'preserve');
  });

  test('rejects a target reached through a symlink outside the workspace', async function () {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'configuration-project-outside-'));
    const link = path.join(workspace, 'linked');
    try {
      await fs.promises.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      await fs.promises.rm(outside, { recursive: true, force: true });
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'UNKNOWN') {
        this.skip();
        return;
      }
      throw error;
    }

    try {
      await assert.rejects(
        () => createTestConfigurationProjectService().createProject({
          workspaceRoot: workspace,
          targetRelativePath: 'linked/EscapedConfiguration',
          name: 'EscapedConfiguration',
        }),
        (error: ConfigurationProjectError) => error.code === 'CONFIGURATION_PROJECT_INVALID_REQUEST',
      );
      assert.deepStrictEqual(await fs.promises.readdir(outside), []);
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  test('removes staging files and leaves no target when a write fails', async () => {
    const service = new ConfigurationProjectService({
      templateDirectory: path.join(process.cwd(), 'resources', 'configuration-project'),
      writeTextFile: async (filePath, contents) => {
        if (path.basename(filePath) === 'ConfigDumpInfo.xml') {
          throw new Error('simulated disk failure');
        }
        await fs.promises.writeFile(filePath, contents, 'utf8');
      },
    });

    await assert.rejects(
      () => service.createProject({
        workspaceRoot: workspace,
        targetRelativePath: 'FailedConfiguration',
        name: 'FailedConfiguration',
      }),
      (error: ConfigurationProjectError) => error.code === 'CONFIGURATION_PROJECT_WRITE_FAILED',
    );
    assert.deepStrictEqual(await fs.promises.readdir(workspace), []);
  });

  test('command creates in the selected workspace and refreshes discovery from an empty tree', async () => {
    const otherWorkspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'configuration-project-other-'));
    const canonicalOtherWorkspace = await fs.promises.realpath(otherWorkspace);
    const firstFolder = { name: 'first', index: 0, uri: vscode.Uri.file(workspace) };
    const selectedFolder = { name: 'selected', index: 1, uri: vscode.Uri.file(otherWorkspace) };
    vscodeTestState.mockWorkspaceFolders = [firstFolder, selectedFolder];
    vscodeTestState.inputBoxQueue = ['UiConfiguration'];
    vscodeTestState.quickPickQueue = [
      { label: 'selected', description: otherWorkspace, workspaceFolder: selectedFolder },
      { label: 'Русский', description: 'По умолчанию', value: 'ru' },
    ];
    let refreshCount = 0;
    registerConfigurationProjectCommands({
      context: { subscriptions: [] } as unknown as vscode.ExtensionContext,
      refreshTree: async () => { refreshCount += 1; },
      createService: createTestConfigurationProjectService,
    });

    try {
      const handler = vscodeTestState.registeredCommandHandlers.get(CREATE_CONFIGURATION_PROJECT_COMMAND);
      assert.ok(handler);
      const result = await handler!() as { rootPath: string; formatVersion: string };
      assert.strictEqual(result.rootPath, path.join(canonicalOtherWorkspace, 'UiConfiguration'));
      assert.strictEqual(result.formatVersion, CONFIGURATION_PROJECT_FORMAT_VERSION);
      assert.strictEqual(refreshCount, 1);
      assert.ok(vscodeTestState.informationLog.some((message) => message.includes('UiConfiguration')));
      const discovery = await FormatDetector.findAllConfigurationRoots([canonicalOtherWorkspace]);
      assert.deepStrictEqual(discovery.map(({ configPath }) => configPath), [result.rootPath]);
    } finally {
      await fs.promises.rm(otherWorkspace, { recursive: true, force: true });
    }
  });

  test('keeps a published project when tree refresh fails', async () => {
    const folder = { name: 'single', index: 0, uri: vscode.Uri.file(workspace) };
    vscodeTestState.mockWorkspaceFolders = [folder];
    vscodeTestState.inputBoxQueue = ['PublishedConfiguration'];
    vscodeTestState.quickPickQueue = [{ label: 'Русский', description: 'По умолчанию', value: 'ru' }];
    const canonicalWorkspace = await fs.promises.realpath(workspace);
    registerConfigurationProjectCommands({
      context: { subscriptions: [] } as unknown as vscode.ExtensionContext,
      refreshTree: async () => { throw new Error('tree load failed'); },
      createService: createTestConfigurationProjectService,
    });

    const handler = vscodeTestState.registeredCommandHandlers.get(CREATE_CONFIGURATION_PROJECT_COMMAND);
    assert.ok(handler);
    const result = await handler!() as { rootPath: string };
    assert.strictEqual(result.rootPath, path.join(canonicalWorkspace, 'PublishedConfiguration'));
    assert.ok(vscodeTestState.warningLog.some((message) => message.includes('создан')));
    assert.ok(await fs.promises.stat(path.join(result.rootPath, 'Configuration.xml')));
  });
});
