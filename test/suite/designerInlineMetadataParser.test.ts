import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { DesignerParser } from '../../src/parsers/designerParser';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { getPropertyLabel } from '../../src/constants/propertyLabels';
import { getPropertyEnumValues } from '../../src/constants/propertyEnumValues';
import { XMLWriter } from '../../src/utils/XMLWriter';
import { cleanupTempDir, createTempDir } from '../helpers/testHelpers';

interface ChildFixture {
  type: string;
  name: string;
  comment?: string;
  children?: ChildFixture[];
}

interface RootFixture {
  folder: string;
  type: string;
  name: string;
  children: ChildFixture[];
}

const INLINE_CASES: RootFixture[] = [
  {
    folder: 'HTTPServices', type: 'HTTPService', name: 'Api', children: [
      { type: 'URLTemplate', name: 'FirstRoute', children: [{ type: 'Method', name: 'Get', comment: 'first handler' }] },
      { type: 'URLTemplate', name: 'SecondRoute', children: [{ type: 'Method', name: 'Get', comment: 'second handler' }] },
    ],
  },
  {
    folder: 'WebServices', type: 'WebService', name: 'PublicApi', children: [
      { type: 'Operation', name: 'FirstOperation', children: [{ type: 'Parameter', name: 'Result', comment: 'first result' }] },
      { type: 'Operation', name: 'SecondOperation', children: [{ type: 'Parameter', name: 'Result', comment: 'second result' }] },
    ],
  },
  { folder: 'IntegrationServices', type: 'IntegrationService', name: 'Messages', children: [{ type: 'IntegrationServiceChannel', name: 'Input' }] },
  { folder: 'Tasks', type: 'Task', name: 'Assignment', children: [{ type: 'AddressingAttribute', name: 'Performer' }] },
  {
    folder: 'ChartsOfAccounts', type: 'ChartOfAccounts', name: 'Accounts', children: [
      { type: 'AccountingFlag', name: 'Currency' },
      { type: 'ExtDimensionAccountingFlag', name: 'Amount' },
    ],
  },
  { folder: 'DocumentJournals', type: 'DocumentJournal', name: 'Documents', children: [{ type: 'Column', name: 'Date' }] },
  { folder: 'Sequences', type: 'Sequence', name: 'Movement', children: [{ type: 'Dimension', name: 'Register' }] },
];

function childXml(child: ChildFixture): string {
  const descendants = child.children ?? [];
  const childObjects = descendants.length > 0
    ? `<ChildObjects>${descendants.map(childXml).join('')}</ChildObjects>`
    : '';
  return `<${child.type}><Properties><Name>${child.name}</Name><Comment>${child.comment ?? ''}</Comment></Properties>${childObjects}</${child.type}>`;
}

function metadataXml(type: string, name: string, children: ChildFixture[]): string {
  return `<MetaDataObject version="2.20"><${type}><Properties><Name>${name}</Name><Comment>root</Comment></Properties><ChildObjects>${children.map(childXml).join('')}</ChildObjects></${type}></MetaDataObject>`;
}

function findByName(nodes: TreeNode[] | undefined, name: string): TreeNode | undefined {
  return nodes?.find((node) => node.name === name);
}

suite('DesignerParser inline metadata children', () => {
  let tempDir: string;

  setup(async () => {
    tempDir = await createTempDir('1cviewer-designer-inline-');
  });

  teardown(async () => {
    await cleanupTempDir(tempDir);
  });

  test('parses confirmed named ChildObjects recursively with full selectors and source file paths', async () => {
    for (const fixture of INLINE_CASES) {
      const typeDir = path.join(tempDir, fixture.folder);
      await fs.promises.mkdir(typeDir, { recursive: true });
      const xmlPath = path.join(typeDir, `${fixture.name}.xml`);
      await fs.promises.writeFile(xmlPath, metadataXml(fixture.type, fixture.name, fixture.children), 'utf8');

      const rootNode: TreeNode = {
        id: `${fixture.folder}.${fixture.name}`,
        name: fixture.name,
        type: fixture.type as MetadataType,
        properties: { Name: fixture.name },
        children: [],
      };
      const children = await DesignerParser.loadChildrenForElement(tempDir, fixture.folder, fixture.name, rootNode);
      const directTypes = fixture.children.map((child) => child.type);
      const dimensionGroup = fixture.type === 'Sequence' ? children.find((node) => node.id === 'Dimensions') : undefined;
      if (fixture.type === 'Sequence') {
        assert.ok(dimensionGroup, 'Sequence.Dimension stays under the existing Dimensions placeholder');
        assert.ok(!children.some((node) => node.type === MetadataType.Dimension && node.nestedPath?.length === 2),
          'Sequence.Dimension must not be duplicated as a direct sibling of the Dimensions group');
      }
      const inlineParentNodes = dimensionGroup?.children ?? children;
      const inlineNodes = inlineParentNodes.filter((node) => directTypes.includes(node.type) && node.nestedPath?.length === 2);
      assert.deepStrictEqual(
        inlineNodes.map((node) => node.type).sort(),
        [...directTypes].sort(),
        `${fixture.type} direct inline children`,
      );

      for (const childFixture of fixture.children) {
        const node = findByName(inlineNodes, childFixture.name);
        assert.ok(node, `${fixture.type}.${childFixture.type}.${childFixture.name}`);
        assert.strictEqual(node!.parentFilePath, xmlPath);
        assert.deepStrictEqual(node!.nestedPath, [
          { type: fixture.type, name: fixture.name },
          { type: childFixture.type, name: childFixture.name },
        ]);
        assert.strictEqual(node!.properties.Comment, childFixture.comment ?? '');
        assert.strictEqual(node!.parent, dimensionGroup ?? rootNode);

        if (childFixture.children?.length) {
          const nestedFixture = childFixture.children[0];
          const nested = findByName(node!.children, nestedFixture.name);
          assert.ok(nested, `${fixture.type}.${childFixture.type}.${childFixture.name}.${nestedFixture.type}.${nestedFixture.name}`);
          assert.strictEqual(nested!.parentFilePath, xmlPath);
          assert.strictEqual(nested!.parent, node);
          assert.deepStrictEqual(nested!.nestedPath, [
            { type: fixture.type, name: fixture.name },
            { type: childFixture.type, name: childFixture.name },
            { type: nestedFixture.type, name: nestedFixture.name },
          ]);
          assert.strictEqual(nested!.properties.Comment, nestedFixture.comment ?? '');
        }
      }

      if (fixture.type === 'HTTPService') {
        const secondRoute = findByName(inlineNodes, 'SecondRoute')!;
        assert.strictEqual(findByName(secondRoute.children, 'Get')?.properties.Comment, 'second handler');
      }
      if (fixture.type === 'WebService') {
        const secondOperation = findByName(inlineNodes, 'SecondOperation')!;
        assert.strictEqual(findByName(secondOperation.children, 'Result')?.properties.Comment, 'second result');
      }
    }
  });

  test('assigns scoped selectors to root attributes, tabular sections, and columns with duplicate names', async () => {
    const typeDir = path.join(tempDir, 'Catalogs');
    await fs.promises.mkdir(typeDir, { recursive: true });
    const xmlPath = path.join(typeDir, 'Items.xml');
    await fs.promises.writeFile(xmlPath, metadataXml('Catalog', 'Items', [
      { type: 'Attribute', name: 'Shared', comment: 'root attribute' },
      {
        type: 'TabularSection', name: 'Lines', children: [
          { type: 'Attribute', name: 'Shared', comment: 'tabular column' },
        ],
      },
    ]), 'utf8');

    const rootNode: TreeNode = {
      id: 'Catalogs.Items', name: 'Items', type: MetadataType.Catalog,
      properties: { Name: 'Items' }, children: [],
    };
    const children = await DesignerParser.loadChildrenForElement(tempDir, 'Catalogs', 'Items', rootNode);
    const attributes = children.find((node) => node.id === 'Attributes')?.children?.find((node) => node.name === 'Shared');
    const section = children.find((node) => node.id === 'TabularSections')?.children?.find((node) => node.name === 'Lines');
    const column = section?.children?.find((node) => node.name === 'Shared');

    assert.strictEqual(attributes?.properties.Comment, 'root attribute');
    assert.deepStrictEqual(attributes?.nestedPath, [
      { type: 'Catalog', name: 'Items' }, { type: 'Attribute', name: 'Shared' },
    ]);
    assert.deepStrictEqual(section?.nestedPath, [
      { type: 'Catalog', name: 'Items' }, { type: 'TabularSection', name: 'Lines' },
    ]);
    assert.strictEqual(column?.properties.Comment, 'tabular column');
    assert.deepStrictEqual(column?.nestedPath, [
      { type: 'Catalog', name: 'Items' },
      { type: 'TabularSection', name: 'Lines' },
      { type: 'Attribute', name: 'Shared' },
    ]);
    assert.strictEqual(column?.parentFilePath, xmlPath);
    assert.strictEqual(attributes?.type, MetadataType.Attribute);
  });

  test('parses external data source tables and fields with file-relative selectors and saves the selected duplicate field', async () => {
    const sourceName = 'Analytics';
    const externalSourcesDir = path.join(tempDir, 'ExternalDataSources');
    const sourceXmlPath = path.join(externalSourcesDir, `${sourceName}.xml`);
    const tablesDir = path.join(externalSourcesDir, sourceName, 'Tables');
    await fs.promises.mkdir(tablesDir, { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, 'Configuration.xml'),
      '<MetaDataObject><Configuration><Properties><Name>Test</Name></Properties></Configuration></MetaDataObject>', 'utf8');
    await fs.promises.writeFile(sourceXmlPath,
      `<MetaDataObject version="2.18"><ExternalDataSource uuid="source-id"><Properties><Name>${sourceName}</Name><Comment>source</Comment></Properties><ChildObjects><Table>Orders</Table><Table>ArchiveOrders</Table><Table>WrongRoot</Table><Table>WrongName</Table><Table>../escape</Table><Function uuid="function-id"><Properties><Name>Orders</Name><Comment>inline function</Comment></Properties></Function></ChildObjects></ExternalDataSource></MetaDataObject>`,
      'utf8');

    const tableXml = (name: string, sourceNameInDataSource: string, fieldSourceName: string, fieldComment: string): string =>
      `<MetaDataObject version="2.18"><Table uuid="${name}-id"><Properties><Name>${name}</Name><Comment>${name} table</Comment><TableType>Table</TableType><NameInDataSource>${sourceNameInDataSource}</NameInDataSource><TableDataType>ObjectData</TableDataType></Properties><ChildObjects><Field uuid="${name}-field-id"><Properties><Name>Identifier</Name><Comment>${fieldComment}</Comment><Type><v8:Type>xs:string</v8:Type></Type><NameInDataSource>${fieldSourceName}</NameInDataSource><AllowNull>false</AllowNull></Properties></Field></ChildObjects></Table></MetaDataObject>`;
    const ordersXmlPath = path.join(tablesDir, 'Orders.xml');
    const archiveXmlPath = path.join(tablesDir, 'ArchiveOrders.xml');
    await fs.promises.writeFile(ordersXmlPath, tableXml('Orders', 'sales.orders', 'order_id', 'orders field'), 'utf8');
    await fs.promises.writeFile(archiveXmlPath, tableXml('ArchiveOrders', 'archive.orders', 'archive_id', 'archive field'), 'utf8');
    await fs.promises.writeFile(path.join(tablesDir, 'WrongRoot.xml'),
      '<MetaDataObject version="2.18"><Catalog uuid="wrong-root-id"><Properties><Name>WrongRoot</Name></Properties></Catalog></MetaDataObject>', 'utf8');
    await fs.promises.writeFile(path.join(tablesDir, 'WrongName.xml'),
      '<MetaDataObject version="2.18"><Table uuid="wrong-name-id"><Properties><Name>DifferentName</Name><NameInDataSource>wrong.name</NameInDataSource></Properties></Table></MetaDataObject>', 'utf8');
    await fs.promises.writeFile(path.join(externalSourcesDir, sourceName, 'escape.xml'),
      tableXml('Escape', 'escape', 'escape_id', 'must not be loaded'), 'utf8');

    const parsed = await DesignerParser.parse(tempDir);
    const externalSources = parsed.children?.find((node) => node.name === 'ExternalDataSources');
    const source = externalSources?.children?.find((node) => node.name === sourceName);
    assert.ok(source, 'ExternalDataSource should be in the parsed tree');

    const orders = source!.children?.find((node) => String(node.type) === 'Table' && node.name === 'Orders');
    const archiveOrders = source!.children?.find((node) => String(node.type) === 'Table' && node.name === 'ArchiveOrders');
    const inlineFunction = source!.children?.find((node) => String(node.type) === 'Function' && node.name === 'Orders');
    assert.ok(orders, 'the scalar Table ref should resolve to its separate Table XML');
    assert.ok(archiveOrders, 'all scalar Table refs should be represented');
    assert.ok(inlineFunction, 'the inline Function should be represented independently of the same-named Table');
    assert.ok(!source!.children?.some((node) => String(node.type) === 'Table' && node.name === 'WrongRoot'),
      'a Table reference must not load a file whose XML root is not Table');
    assert.ok(!source!.children?.some((node) => String(node.type) === 'Table' && node.name === 'WrongName'),
      'a Table reference must not load a Table file with a different Properties.Name');
    assert.ok(!source!.children?.some((node) => node.name === '../escape'), 'table references must stay inside Tables');
    assert.strictEqual(orders!.filePath, ordersXmlPath);
    assert.strictEqual((orders!.properties as Record<string, unknown>)['NameInDataSource'], 'sales.orders');
    assert.strictEqual(orders!.parent, source);
    assert.strictEqual(inlineFunction!.parentFilePath, sourceXmlPath);
    assert.deepStrictEqual(inlineFunction!.nestedPath, [
      { type: 'ExternalDataSource', name: sourceName },
      { type: 'Function', name: 'Orders' },
    ]);

    const ordersField = orders!.children?.find((node) => String(node.type) === 'Field' && node.name === 'Identifier');
    const archiveField = archiveOrders!.children?.find((node) => String(node.type) === 'Field' && node.name === 'Identifier');
    assert.ok(ordersField, 'the inline field should appear under its Table');
    assert.ok(archiveField, 'a duplicate field name should remain scoped to the second Table');
    assert.strictEqual(ordersField!.parentFilePath, ordersXmlPath);
    assert.deepStrictEqual(ordersField!.nestedPath, [
      { type: 'Table', name: 'Orders' },
      { type: 'Field', name: 'Identifier' },
    ]);
    assert.strictEqual((ordersField!.properties as Record<string, unknown>)['NameInDataSource'], 'order_id');
    assert.strictEqual((ordersField!.properties as Record<string, unknown>)['AllowNull'], false);
    assert.strictEqual(archiveField!.parentFilePath, archiveXmlPath);
    assert.deepStrictEqual(archiveField!.nestedPath, [
      { type: 'Table', name: 'ArchiveOrders' },
      { type: 'Field', name: 'Identifier' },
    ]);
    assert.strictEqual(archiveField!.properties.Comment, 'archive field');

    await XMLWriter.writeNestedElementProperties(
      ordersField!.parentFilePath!,
      ordersField!.type,
      ordersField!.name,
      { ...ordersField!.properties, NameInDataSource: 'saved_order_id' },
      ['NameInDataSource'],
      { nestedPath: ordersField!.nestedPath },
    );
    const fieldSavedXml = await fs.promises.readFile(ordersXmlPath, 'utf8');
    assert.strictEqual((fieldSavedXml.match(/<NameInDataSource>saved_order_id<\/NameInDataSource>/g) ?? []).length, 1);
    assert.strictEqual((fieldSavedXml.match(/<NameInDataSource>sales\.orders<\/NameInDataSource>/g) ?? []).length, 1);

    await XMLWriter.updateProperty(orders!.filePath!, 'NameInDataSource', 'sales.orders.saved');
    const savedOrdersXml = await fs.promises.readFile(ordersXmlPath, 'utf8');
    const untouchedArchiveXml = await fs.promises.readFile(archiveXmlPath, 'utf8');
    assert.strictEqual((savedOrdersXml.match(/<NameInDataSource>sales\.orders\.saved<\/NameInDataSource>/g) ?? []).length, 1);
    assert.strictEqual((savedOrdersXml.match(/<NameInDataSource>saved_order_id<\/NameInDataSource>/g) ?? []).length, 1);
    assert.doesNotMatch(savedOrdersXml, /<NameInDataSource>sales\.orders<\/NameInDataSource>/);
    assert.match(untouchedArchiveXml, /<NameInDataSource>archive_id<\/NameInDataSource>/);

    const lazySource = (await DesignerParser.parseTypeContents(tempDir, 'ExternalDataSources'))
      .find((node) => node.name === sourceName)!;
    const loadedChildren = await DesignerParser.loadChildrenForElement(
      tempDir, 'ExternalDataSources', sourceName, lazySource,
    );
    assert.ok(loadedChildren.some((node) => String(node.type) === 'Table' && node.name === 'Orders'));
    assert.ok(loadedChildren.some((node) => String(node.type) === 'Function' && node.name === 'Orders'));
  });

  test('exposes Russian labels and sample-backed service enum choices in the shared property palette', () => {
    assert.strictEqual(getPropertyLabel('RootURL'), 'Корневой URL');
    assert.strictEqual(getPropertyLabel('HTTPMethod'), 'Метод HTTP');
    assert.strictEqual(getPropertyLabel('NameInDataSource'), 'Имя в источнике данных');
    assert.strictEqual(getPropertyLabel('TableType'), 'Тип таблицы');
    assert.strictEqual(getPropertyLabel('AllowNull'), 'Разрешить NULL');
    assert.strictEqual(getPropertyLabel('ReturnValue'), 'Возвращаемое значение');
    assert.deepStrictEqual(getPropertyEnumValues('ReuseSessions'), ['Use', 'DontUse', 'AutoUse']);
    assert.strictEqual(getPropertyEnumValues('HTTPMethod'), undefined);
    assert.deepStrictEqual(getPropertyEnumValues('TransferDirection'), ['In', 'Out', 'InOut']);
    assert.deepStrictEqual(getPropertyEnumValues('MessageDirection'), ['Receive', 'Send']);
  });
});
