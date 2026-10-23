import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentOperations } from '../../src/agent/agentOperations';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import { handleMessage, saveProperties, type MessageHandlerContext } from '../../src/providers/propertiesMessageHandler';
import { getWebviewContent, renderPropertyInput } from '../../src/providers/propertiesWebviewContent';
import { validateProperties } from '../../src/providers/propertiesValidation';
import { isValidWebviewMessage } from '../../src/providers/propertiesWebviewTypes';

const CONFIGURATION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.21"><Configuration uuid="11111111-1111-4111-8111-111111111111"><Properties><Name>Test</Name></Properties><ChildObjects><Catalog>Products</Catalog></ChildObjects></Configuration></MetaDataObject>`;

const CATALOG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject version="2.21"><Catalog uuid="22222222-2222-4222-8222-222222222222"><Properties><Name>Products</Name><Synonym>Products</Synonym></Properties><ChildObjects><Attribute uuid="33333333-3333-4333-8333-333333333333"><Properties><Name>Price</Name><Synonym>Price</Synonym></Properties></Attribute></ChildObjects></Catalog></MetaDataObject>`;

suite('Properties identity safety — issue #263', () => {
  let tempRoot: string;
  let catalogPath: string;
  let rootNode: TreeNode;
  let attributeNode: TreeNode;

  setup(async () => {
    tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'properties-identity-safety-'));
    const catalogsPath = path.join(tempRoot, 'Catalogs');
    await fs.promises.mkdir(catalogsPath, { recursive: true });
    await fs.promises.writeFile(path.join(tempRoot, 'Configuration.xml'), CONFIGURATION_XML, 'utf8');
    catalogPath = path.join(catalogsPath, 'Products.xml');
    await fs.promises.writeFile(catalogPath, CATALOG_XML, 'utf8');

    const catalogsNode: TreeNode = {
      id: 'Catalogs', name: 'Справочники', type: MetadataType.Catalog,
      filePath: catalogsPath, properties: {}, children: [],
    };
    rootNode = {
      id: 'Catalog.Products', name: 'Products', type: MetadataType.Catalog,
      parent: catalogsNode, filePath: catalogPath,
      properties: { Name: 'Products', Synonym: 'Products' }, children: [],
    };
    catalogsNode.children = [rootNode];
    attributeNode = {
      id: 'Catalog.Products.Attribute.Price', name: 'Price', type: MetadataType.Attribute,
      parent: rootNode, parentFilePath: catalogPath,
      properties: { Name: 'Price', Synonym: 'Price' }, children: [],
    };
    rootNode.children = [attributeNode];
  });

  teardown(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  test('forged root webview save rejects Name without changing XML or TreeNode identity', async () => {
    await assertForgedSaveRejected(rootNode, { Name: 'Goods', Synonym: 'Changed root synonym' });
  });

  test('forged nested Attribute webview save rejects Name without changing XML or TreeNode identity', async () => {
    await assertForgedSaveRejected(attributeNode, { Name: 'Cost', Synonym: 'Changed attribute synonym' });
  });

  test('saveProperties rejects root Name even when called outside the webview message path', async () => {
    const xmlBefore = await fs.promises.readFile(catalogPath, 'utf8');
    const ctx = makeContext(rootNode, [], () => undefined);

    await assert.rejects(() => saveProperties(rootNode, { Name: 'Goods' }, ctx), /Имя нельзя менять|Name.*rename|Переимен/i);

    assert.strictEqual(await fs.promises.readFile(catalogPath, 'utf8'), xmlBefore);
    assert.strictEqual(rootNode.name, 'Products');
  });

  test('saveProperties rejects nested Attribute Name even when called outside the webview message path', async () => {
    const xmlBefore = await fs.promises.readFile(catalogPath, 'utf8');
    const ctx = makeContext(attributeNode, [], () => undefined);

    await assert.rejects(() => saveProperties(attributeNode, { Name: 'Cost' }, ctx), /Имя нельзя менять|Name.*rename|Переимен/i);

    assert.strictEqual(await fs.promises.readFile(catalogPath, 'utf8'), xmlBefore);
    assert.strictEqual(attributeNode.name, 'Price');
  });

  test('Name validation rejects identity edits and Agent setProperties applies the same rule to aliases', async () => {
    const operations = new AgentOperations(tempRoot);
    const aliases = ['Name', 'name', 'Имя'];
    const targetPaths = ['Catalog.Products', 'Catalog.Products.Attribute.Price'];

    const uiResults: Array<{ alias: string; valid: boolean; hasError: boolean }> = [];
    const agentResults: Array<{ path: string; alias: string; success: boolean; error?: string; unchanged: boolean }> = [];
    for (const alias of aliases) {
      const uiResult = validateProperties({ [alias]: 'Changed' }, rootNode);
      uiResults.push({ alias, valid: uiResult.valid, hasError: Boolean(uiResult.errors[alias]) });
      for (const targetPath of targetPaths) {
        const before = await fs.promises.readFile(catalogPath, 'utf8');
        const agentResult = await operations.setProperties({
          path: targetPath,
          properties: { [alias]: 'Changed' },
        });
        agentResults.push({
          path: targetPath,
          alias,
          success: agentResult.success,
          error: agentResult.error,
          unchanged: (await fs.promises.readFile(catalogPath, 'utf8')) === before,
        });
      }
    }
    assert.deepStrictEqual(uiResults, aliases.map((alias) => ({ alias, valid: false, hasError: true })));
    assert.deepStrictEqual(agentResults.map(({ path: targetPath, alias, success, unchanged }) => ({
      path: targetPath, alias, success, unchanged,
    })), aliases.flatMap((alias) => targetPaths.map((targetPath) => ({
      path: targetPath, alias, success: false, unchanged: true,
    }))));
    for (const result of agentResults) {
      assert.match(result.error ?? '', /Name|имя|renameObject|переимен/i);
    }
  });

  test('Name renders read-only with a transition to the existing rename command', async () => {
    const html = renderPropertyInput('Name', 'Products', false, rootNode);
    const fullHtml = getWebviewContent(rootNode, 'current-session');

    assert.match(html, /data-property="Name"[\s\S]*disabled/);
    assert.match(html, /class="rename-element-btn"/);
    assert.match(html, /Переименовать элемент/);
    assert.match(fullHtml, /querySelectorAll\(["']\.rename-element-btn["']\)/);
    assert.match(fullHtml, /type\s*:\s*["']renameElement["']/);
  });

  test('rename action forwards the selected TreeNode to the existing command', async () => {
    const patchedCommands = vscode.commands as unknown as {
      executeCommand: (command: string, ...args: unknown[]) => Promise<unknown>;
    };
    const originalExecuteCommand = patchedCommands.executeCommand;
    let commandName: string | undefined;
    let commandNode: unknown;
    patchedCommands.executeCommand = async (command, ...args) => {
      commandName = command;
      commandNode = args[0];
      return undefined;
    };

    try {
      const message = { type: 'renameElement', nodeId: rootNode.id };
      const messageAccepted = isValidWebviewMessage(message);
      await handleMessage(message as never, makeContext(rootNode, [], () => undefined));
      assert.strictEqual(commandName, '1c-metadata-tree.renameElement');
      assert.strictEqual(commandNode, rootNode);
      assert.strictEqual(messageAccepted, true, 'the webview runtime guard must admit the rename action');
    } finally {
      patchedCommands.executeCommand = originalExecuteCommand;
    }
  });
});

async function assertForgedSaveRejected(node: TreeNode, properties: Record<string, unknown>): Promise<void> {
  const xmlBefore = await fs.promises.readFile(node.parentFilePath || node.filePath!, 'utf8');
  const nodePropertiesBefore = { ...node.properties };
  let refreshCount = 0;
  let dirtyChanges = 0;
  const messages: unknown[] = [];
  const ctx = makeContext(node, messages, () => { refreshCount += 1; });
  ctx.setIsDirty = () => { dirtyChanges += 1; };

  await handleMessage({
    type: 'save',
    properties,
    nodeId: node.id,
    sessionToken: 'current-session',
  }, ctx);

  assert.strictEqual(await fs.promises.readFile(node.parentFilePath || node.filePath!, 'utf8'), xmlBefore, `${node.id} XML must remain unchanged`);
  assert.deepStrictEqual(node.properties, nodePropertiesBefore, `${node.id} TreeNode properties must remain unchanged`);
  assert.strictEqual(node.name, nodePropertiesBefore.Name, `${node.id} TreeNode identity must remain unchanged`);
  assert.strictEqual(refreshCount, 0, 'rejected identity edits must not refresh the tree');
  assert.strictEqual(dirtyChanges, 0, 'rejected identity edits must not update dirty state');
  assert.ok(messages.some((message) => (message as { type?: string }).type === 'validationError'), 'the webview must receive an explicit validation error');
}

function makeContext(
  node: TreeNode,
  messages: unknown[],
  onRefresh: () => void,
): MessageHandlerContext {
  return {
    currentNode: node,
    currentFormSelection: null,
    currentFormSelectionRevision: 0,
    currentSessionToken: 'current-session',
    isSaving: false,
    treeDataProvider: { refresh: onRefresh } as unknown as MessageHandlerContext['treeDataProvider'],
    typeEditorProvider: {} as MessageHandlerContext['typeEditorProvider'],
    objectTypeEditorProvider: {} as MessageHandlerContext['objectTypeEditorProvider'],
    postMessage: (message) => { messages.push(message); },
    updateWebviewContent: () => undefined,
    setIsSaving: () => undefined,
  };
}
