import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { DesignerParser } from '../../src/parsers/designerParser';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { getPropertyLabel } from '../../src/constants/propertyLabels';
import { getPropertyEnumValues } from '../../src/constants/propertyEnumValues';
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

  test('exposes Russian labels and sample-backed service enum choices in the shared property palette', () => {
    assert.strictEqual(getPropertyLabel('RootURL'), 'Корневой URL');
    assert.strictEqual(getPropertyLabel('HTTPMethod'), 'Метод HTTP');
    assert.deepStrictEqual(getPropertyEnumValues('ReuseSessions'), ['Use', 'DontUse', 'AutoUse']);
    assert.strictEqual(getPropertyEnumValues('HTTPMethod'), undefined);
    assert.deepStrictEqual(getPropertyEnumValues('TransferDirection'), ['In', 'Out', 'InOut']);
    assert.deepStrictEqual(getPropertyEnumValues('MessageDirection'), ['Receive', 'Send']);
  });
});
