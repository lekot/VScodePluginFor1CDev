import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import { AgentOperations } from '../../src/agent/agentOperations';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import { saveProperties, type MessageHandlerContext } from '../../src/providers/propertiesMessageHandler';
import { createElement, deleteElement } from '../../src/services/elementOperations';

suite('CFE generic CRUD guards', () => {
  let workspace: string;
  let cfeRoot: string;
  let adoptedPath: string;
  let catalogsNode: TreeNode;
  let adoptedNode: TreeNode;

  setup(async () => {
    workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cfe-crud-'));
    cfeRoot = path.join(workspace, 'ConfigurationExtensions', 'Ext');
    const catalogsPath = path.join(cfeRoot, 'Catalogs');
    await fs.promises.mkdir(catalogsPath, { recursive: true });
    await fs.promises.writeFile(path.join(cfeRoot, 'Configuration.xml'), configurationXml('Ext_'), 'utf8');
    adoptedPath = path.join(catalogsPath, 'BaseCatalog.xml');
    await fs.promises.writeFile(adoptedPath, adoptedXml('BaseCatalog'), 'utf8');
    const configurationNode: TreeNode = {
      id: 'Configuration', name: 'Extension', type: MetadataType.Configuration,
      filePath: path.join(cfeRoot, 'Configuration.xml'), properties: {}, children: [],
    };
    catalogsNode = {
      id: 'Catalogs', name: 'Catalogs', type: MetadataType.Catalog,
      filePath: catalogsPath, parent: configurationNode, properties: {}, children: [],
    };
    adoptedNode = {
      id: 'Catalogs.BaseCatalog', name: 'BaseCatalog', type: MetadataType.Catalog,
      filePath: adoptedPath, parent: catalogsNode, properties: {}, children: [],
    };
    configurationNode.children = [catalogsNode];
    catalogsNode.children = [adoptedNode];
  });

  teardown(async () => {
    await fs.promises.rm(workspace, { recursive: true, force: true });
  });

  test('allows own root creates and applies NamePrefix in both UI and Agent paths', async () => {
    await createElement(catalogsNode, 'Ext_UiCatalog');
    assert.ok(await exists(path.join(cfeRoot, 'Catalogs', 'Ext_UiCatalog.xml')));

    const agentResult = await new AgentOperations(cfeRoot).createObject({ type: 'Catalog', name: 'Ext_AgentCatalog' });
    assert.strictEqual(agentResult.success, true, agentResult.error);
    assert.ok(await exists(path.join(cfeRoot, 'Catalogs', 'Ext_AgentCatalog.xml')));
  });

  test('rejects an unprefixed CFE create before UI or Agent changes the filesystem', async () => {
    const configurationBefore = await fs.promises.readFile(path.join(cfeRoot, 'Configuration.xml'), 'utf8');
    await assert.rejects(
      () => createElement(catalogsNode, 'NoPrefix'),
      isOwnershipError('CFE_OWNERSHIP_INVALID'),
    );
    const result = await new AgentOperations(cfeRoot).createObject({ type: 'Catalog', name: 'NoPrefix' });
    assert.deepStrictEqual({ success: result.success, code: result.code }, { success: false, code: 'CFE_OWNERSHIP_INVALID' });
    assert.ok(!await exists(path.join(cfeRoot, 'Catalogs', 'NoPrefix.xml')));
    assert.strictEqual(await fs.promises.readFile(path.join(cfeRoot, 'Configuration.xml'), 'utf8'), configurationBefore);
  });

  test('rejects adopted root and nested generic mutations with UI/Agent parity and no filesystem effect', async () => {
    const before = await fs.promises.readFile(adoptedPath, 'utf8');
    await assert.rejects(() => deleteElement(adoptedNode), isOwnershipError('CFE_ADOPTED_OPERATION_REQUIRED'));
    const deleteResult = await new AgentOperations(cfeRoot).deleteObject({ path: 'Catalog.BaseCatalog' });
    assert.deepStrictEqual({ success: deleteResult.success, code: deleteResult.code }, { success: false, code: 'CFE_ADOPTED_OPERATION_REQUIRED' });

    const attribute: TreeNode = {
      id: 'Catalog.BaseCatalog.Attributes.Price', name: 'Price', type: MetadataType.Attribute,
      parent: adoptedNode, parentFilePath: adoptedPath, properties: {}, children: [],
    };
    await assert.rejects(
      () => saveProperties(attribute, { Name: 'Price' }, fakePropertiesContext()),
      isOwnershipError('CFE_ADOPTED_OPERATION_REQUIRED'),
    );
    const updateResult = await new AgentOperations(cfeRoot).setProperties({
      path: 'Catalog.BaseCatalog.Attribute.Price', properties: { Synonym: 'Цена' },
    });
    assert.deepStrictEqual({ success: updateResult.success, code: updateResult.code }, { success: false, code: 'CFE_ADOPTED_OPERATION_REQUIRED' });
    assert.strictEqual(await fs.promises.readFile(adoptedPath, 'utf8'), before);
  });

  test('leaves a main configuration outside the CFE root unchanged', async () => {
    const mainRoot = path.join(workspace, 'Main');
    await fs.promises.mkdir(path.join(mainRoot, 'Catalogs'), { recursive: true });
    await fs.promises.writeFile(path.join(mainRoot, 'Configuration.xml'), mainConfigurationXml(), 'utf8');
    const result = await new AgentOperations(mainRoot).createObject({ type: 'Catalog', name: 'UnprefixedMainCatalog' });
    assert.strictEqual(result.success, true, result.error);
    assert.ok(await exists(path.join(mainRoot, 'Catalogs', 'UnprefixedMainCatalog.xml')));
  });

  test('fails closed when a CFE target crosses a symbolic-link boundary', async function () {
    const external = path.join(workspace, 'external');
    const linked = path.join(cfeRoot, 'Unsafe');
    const externalObject = path.join(external, 'External.xml');
    await fs.promises.mkdir(external, { recursive: true });
    await fs.promises.writeFile(externalObject, adoptedXml('External'), 'utf8');
    try {
      await fs.promises.symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
        this.skip();
        return;
      }
      throw error;
    }
    const before = await fs.promises.readFile(externalObject, 'utf8');
    const linkedNode: TreeNode = {
      ...adoptedNode,
      filePath: path.join(linked, 'External.xml'),
      children: [],
    };
    await assert.rejects(() => deleteElement(linkedNode), (error: unknown) =>
      Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'PATH_OUTSIDE_ROOT'));
    assert.strictEqual(await fs.promises.readFile(externalObject, 'utf8'), before);
  });
});

function configurationXml(prefix: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.21"><Configuration uuid="11111111-1111-4111-8111-111111111111"><Properties><Name>Extension</Name><ConfigurationExtensionPurpose>Customization</ConfigurationExtensionPurpose><NamePrefix>${prefix}</NamePrefix></Properties><ChildObjects/></Configuration></MetaDataObject>`;
}

function adoptedXml(name: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.21"><Catalog uuid="22222222-2222-4222-8222-222222222222"><Properties><Name>${name}</Name><ObjectBelonging>Adopted</ObjectBelonging><ExtendedConfigurationObject>33333333-3333-4333-8333-333333333333</ExtendedConfigurationObject></Properties><ChildObjects/></Catalog></MetaDataObject>`;
}

function mainConfigurationXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.21"><Configuration uuid="44444444-4444-4444-8444-444444444444"><Properties><Name>Main</Name></Properties><ChildObjects/></Configuration></MetaDataObject>`;
}

function fakePropertiesContext(): MessageHandlerContext {
  return {
    currentNode: undefined,
    currentFormSelection: null,
    currentFormSelectionRevision: 0,
    isSaving: false,
    treeDataProvider: {} as MessageHandlerContext['treeDataProvider'],
    typeEditorProvider: {} as MessageHandlerContext['typeEditorProvider'],
    objectTypeEditorProvider: {} as MessageHandlerContext['objectTypeEditorProvider'],
    postMessage: () => undefined,
    updateWebviewContent: () => undefined,
    setIsSaving: () => undefined,
  };
}

function isOwnershipError(code: string): (error: unknown) => boolean {
  return (error: unknown) => Boolean(error && typeof error === 'object' && (error as { code?: string }).code === code);
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.promises.access(candidate);
    return true;
  } catch {
    return false;
  }
}
