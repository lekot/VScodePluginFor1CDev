import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import {
  saveProperties,
  type MessageHandlerContext,
} from '../../src/providers/propertiesMessageHandler';

suite('PropertiesMessageHandler State Synchronization (#353)', () => {
  let tempDir: string;
  let targetXmlPath: string;

  const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xs="http://www.w3.org/2001/XMLSchema" version="2.16">
  <Catalog uuid="11111111-1111-1111-1111-111111111111">
    <Properties>
      <Name>TestCatalog</Name>
      <Synonym>
        <v8:item>
          <v8:lang>ru</v8:lang>
          <v8:content>Тестовый справочник</v8:content>
        </v8:item>
      </Synonym>
    </Properties>
    <ChildObjects>
      <Attribute uuid="22222222-2222-2222-2222-222222222222">
        <Properties>
          <Name>ProductAttribute</Name>
          <Synonym>
            <v8:item>
              <v8:lang>ru</v8:lang>
              <v8:content>Товар</v8:content>
            </v8:item>
          </Synonym>
          <Comment>Initial comment</Comment>
          <Type>
            <v8:Type xmlns:d5p1="http://v8.1c.ru/8.1/data/enterprise/current-config">d5p1:CatalogRef.Products</v8:Type>
          </Type>
        </Properties>
      </Attribute>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`;

  setup(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'prop-sync-test-'));
    targetXmlPath = path.join(tempDir, 'TestCatalog.xml');
    await fs.promises.writeFile(targetXmlPath, sampleXml, 'utf8');
  });

  teardown(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  function createMockContext(overrides?: Partial<MessageHandlerContext>): {
    ctx: MessageHandlerContext;
    isSavingCalls: boolean[];
  } {
    const isSavingCalls: boolean[] = [];
    let saving = false;
    const ctx: MessageHandlerContext = {
      currentNode: undefined,
      currentFormSelection: null,
      currentFormSelectionRevision: 0,
      isSaving: saving,
      treeDataProvider: {
        refresh: () => undefined,
        getReferenceableObjectsForTypeEditor: async () => ({}),
        getObjectableObjectsForEditor: async () => [],
      } as any,
      typeEditorProvider: {} as any,
      objectTypeEditorProvider: {} as any,
      postMessage: () => undefined,
      updateWebviewContent: () => undefined,
      setIsSaving: (value: boolean) => {
        saving = value;
        ctx.isSaving = value;
        isSavingCalls.push(value);
      },
      ...overrides,
    };
    return { ctx, isSavingCalls };
  }

  test('saveProperties does NOT overwrite structured Type with display string in node.properties', async () => {
    const initialStructuredType = {
      'v8:Type': 'cfg:CatalogRef.Products',
    };

    const node: TreeNode = {
      id: 'test-node-1',
      name: 'ProductAttribute',
      type: MetadataType.Attribute,
      properties: {
        Name: 'ProductAttribute',
        Synonym: 'Товар',
        Comment: 'Initial comment',
        Type: initialStructuredType,
      },
      filePath: '',
      parentFilePath: targetXmlPath,
    };

    const { ctx } = createMockContext();

    // Webview sends display string for Type and an updated Comment
    const webviewProperties = {
      Comment: 'Updated comment',
      Type: 'CatalogRef.Products', // display string from properties webview
    };

    await saveProperties(node, webviewProperties, ctx);

    // Comment should be updated in node.properties
    assert.strictEqual(node.properties.Comment, 'Updated comment');
    // Type MUST retain its structured object, not be overwritten by string
    assert.deepStrictEqual(
      node.properties.Type,
      initialStructuredType,
      'node.properties.Type must remain structured object, not raw display string'
    );
  });

  test('saveProperties does NOT overwrite structured Source with display string in node.properties', async () => {
    const initialStructuredSource = {
      'v8:Type': ['cfg:CatalogRef.Products', 'cfg:DocumentRef.Invoice'],
    };

    const node: TreeNode = {
      id: 'test-node-source',
      name: 'EventSub',
      type: MetadataType.EventSubscription,
      properties: {
        Name: 'EventSub',
        Synonym: 'Подписка',
        Source: initialStructuredSource,
      },
      filePath: '',
      parentFilePath: targetXmlPath,
    };

    const { ctx } = createMockContext();

    const webviewProperties = {
      Synonym: 'Новая подписка',
      Source: 'CatalogRef.Products, DocumentRef.Invoice', // display string
    };

    await saveProperties(node, webviewProperties, ctx);

    assert.strictEqual(node.properties.Synonym, 'Новая подписка');
    assert.deepStrictEqual(
      node.properties.Source,
      initialStructuredSource,
      'node.properties.Source must remain structured object, not raw display string'
    );
  });

  test('saveProperties updates Type when new value is explicit XML string from type editor', async () => {
    const initialStructuredType = {
      'v8:Type': 'cfg:CatalogRef.Products',
    };

    const node: TreeNode = {
      id: 'test-node-explicit-type',
      name: 'ProductAttribute',
      type: MetadataType.Attribute,
      properties: {
        Name: 'ProductAttribute',
        Type: initialStructuredType,
      },
      filePath: '',
      parentFilePath: targetXmlPath,
    };

    const { ctx } = createMockContext();

    const updatedTypeXml = '<v8:Type xmlns:d5p1="http://v8.1c.ru/8.1/data/enterprise/current-config">d5p1:CatalogRef.Partners</v8:Type>';
    const webviewProperties = {
      Type: updatedTypeXml,
    };

    await saveProperties(node, webviewProperties, ctx);

    // Explicit XML string should be updated
    assert.strictEqual(node.properties.Type, updatedTypeXml);
  });

  test('rapid consecutive saves do not prematurely clear isSaving via generation counter', async () => {
    const node: TreeNode = {
      id: 'test-node-gen',
      name: 'ProductAttribute',
      type: MetadataType.Attribute,
      properties: {
        Name: 'ProductAttribute',
        Comment: 'C1',
      },
      filePath: '',
      parentFilePath: targetXmlPath,
    };

    let saveGen = 0;
    let isSaving = false;
    const isSavingHistory: boolean[] = [];

    const { ctx } = createMockContext({
      beginSave: () => {
        isSaving = true;
        isSavingHistory.push(true);
        return ++saveGen;
      },
      endSave: (gen: number, delayMs = 600) => {
        setTimeout(() => {
          if (saveGen === gen) {
            isSaving = false;
            isSavingHistory.push(false);
          }
        }, delayMs);
      },
      setIsSaving: (value: boolean) => {
        isSaving = value;
      },
    });

    // Start first save (delayMs = 40)
    const p1 = saveProperties(node, { Comment: 'C2' }, ctx);
    // Almost immediately start second save
    const p2 = saveProperties(node, { Comment: 'C3' }, ctx);

    await Promise.all([p1, p2]);

    // Right after saves finish, isSaving should still be true (delay timer pending)
    assert.strictEqual(isSaving, true, 'isSaving should be true while debounce timer is active');

    // Wait 700ms for debounce timer to fire
    await new Promise((resolve) => setTimeout(resolve, 700));

    // After timer, isSaving should finally be false
    assert.strictEqual(isSaving, false, 'isSaving should be cleared after last generation timer expires');
  });
});
