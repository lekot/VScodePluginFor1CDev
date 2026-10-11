import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { XMLValidator } from 'fast-xml-parser';
import { compileRoleRightsDsl } from '../../src/agent/agentRoleRights';
import { RoleXmlParser } from '../../src/rolesEditor/roleXmlParser';
import { RoleXmlSerializer } from '../../src/rolesEditor/roleXmlSerializer';
import { ConfigFormat, RoleModel } from '../../src/rolesEditor/models/roleModel';
import { updateRight } from '../../src/rolesEditor/rightsUpdateUtils';
import {
  extractDesignerRoleRightsXml,
  mergeDesignerRoleRightsXml,
} from '../../src/rolesEditor/designerRoleRightsMerger';
import {
  createMinimalRightsDom,
  loadRightsXml,
  mergeNamedRightsIntoDom,
  mergeRightsIntoDom,
  serializeRightsDomToXml,
} from '../../src/rolesEditor/rightsXmlEditWriter';
import { getRoleRightsForType, ROLE_RIGHTS_REGISTRY } from '../../src/rolesEditor/roleRightsRegistry';

const RICH_DESIGNER_ROLE = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" version="2.20">
  <Role uuid="11111111-1111-4111-8111-111111111111">
    <Properties><Name>Power</Name></Properties>
    <Rights>
      <Document><Object><Name>Sale &amp; Return</Name><Read>true</Read><View>false</View><Posting>true</Posting><UndoPosting>false</UndoPosting><InteractivePosting>true</InteractivePosting><ReadDataHistory>true</ReadDataHistory><InteractiveClear>true</InteractiveClear><InteractiveUndeleteMarked>true</InteractiveUndeleteMarked><FutureRight mode="vendor"><Payload>A &amp; B</Payload></FutureRight></Object>
        <Object><Name>Neighbor</Name><Read>false</Read><Posting>false</Posting></Object>
      </Document>
      <Catalog><Object><Name>Products</Name><Read>true</Read><Update>false</Update><Edit>true</Edit><VendorExtension><Nested><Value>keep &lt;exactly&gt;</Value></Nested></VendorExtension>
        <Attribute><Object><Name>Code</Name><Read>true</Read><FutureNestedRight><Value>untouched</Value></FutureNestedRight></Object></Attribute>
      </Object></Catalog>
      <InformationRegister><Object><Name>Prices</Name><Read>true</Read><TotalsControl>true</TotalsControl></Object></InformationRegister>
      <Task><Object><Name>Approval</Name><Read>true</Read><Execute>true</Execute></Object></Task>
      <DataProcessor><Object><Name>Import</Name><Use>true</Use></Object></DataProcessor>
    </Rights>
  </Role>
</MetaDataObject>
`;

const NAMESPACE_COLLISION_ROLES = [
  {
    name: 'default 1C namespace',
    xml: `<Role xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:ext="urn:vendor:role-extension">
  <ext:Rights><ext:Document><ext:Object><ext:Name>Sale</ext:Name><ext:Read>false</ext:Read><ext:FutureRight>true</ext:FutureRight></ext:Object></ext:Document></ext:Rights>
  <Rights><Document><Object><Name>Sale</Name><ext:Read>false</ext:Read><Read>false</Read><View>true</View></Object></Document></Rights>
</Role>`,
    expected: `<Role xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:ext="urn:vendor:role-extension">
  <ext:Rights><ext:Document><ext:Object><ext:Name>Sale</ext:Name><ext:Read>false</ext:Read><ext:FutureRight>true</ext:FutureRight></ext:Object></ext:Document></ext:Rights>
  <Rights><Document><Object><Name>Sale</Name><ext:Read>false</ext:Read><Read>true</Read><View>true</View></Object></Document></Rights>
</Role>`,
  },
  {
    name: 'prefixed 1C namespace',
    xml: `<m:MetaDataObject xmlns:m="http://v8.1c.ru/8.3/MDClasses" xmlns:ext="urn:vendor:role-extension"><m:Role>
  <ext:Rights><ext:Document><ext:Object><ext:Name>Sale</ext:Name><ext:Read>false</ext:Read><ext:FutureRight>true</ext:FutureRight></ext:Object></ext:Document></ext:Rights>
  <m:Rights><m:Document><m:Object><m:Name>Sale</m:Name><ext:Read>false</ext:Read><m:Read>false</m:Read><m:View>true</m:View></m:Object></m:Document></m:Rights>
</m:Role></m:MetaDataObject>`,
    expected: `<m:MetaDataObject xmlns:m="http://v8.1c.ru/8.3/MDClasses" xmlns:ext="urn:vendor:role-extension"><m:Role>
  <ext:Rights><ext:Document><ext:Object><ext:Name>Sale</ext:Name><ext:Read>false</ext:Read><ext:FutureRight>true</ext:FutureRight></ext:Object></ext:Document></ext:Rights>
  <m:Rights><m:Document><m:Object><m:Name>Sale</m:Name><ext:Read>false</ext:Read><m:Read>true</m:Read><m:View>true</m:View></m:Object></m:Document></m:Rights>
</m:Role></m:MetaDataObject>`,
  },
];

suite('role rights lossless domain model (#262)', () => {
  test('parses non-grid domain rights and unrelated UI save changes only the requested XML node', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'role-rights-lossless-'));
    const rolePath = path.join(root, 'Roles', 'Power', 'Role.xml');
    await fs.promises.mkdir(path.dirname(rolePath), { recursive: true });
    await fs.promises.writeFile(rolePath, RICH_DESIGNER_ROLE, 'utf8');

    try {
      const model = await RoleXmlParser.parseRoleXml(rolePath);
      const docRights = model.rights['Document.Sale & Return'] as unknown as Record<string, boolean>;
      const registerRights = model.rights['InformationRegister.Prices'] as unknown as Record<string, boolean>;
      const taskRights = model.rights['Task.Approval'] as unknown as Record<string, boolean>;
      const processorRights = model.rights['DataProcessor.Import'] as unknown as Record<string, boolean>;

      assert.strictEqual(docRights.posting, true, 'Document.Posting must be represented in the domain model');
      assert.strictEqual(docRights.undoPosting, false, 'explicit false must remain distinguishable from absence');
      assert.strictEqual(docRights.readDataHistory, true);
      assert.strictEqual(registerRights.totalsControl, true, 'register totals are a recognized domain right');
      assert.strictEqual(taskRights.execute, true, 'Task.Execute is recognized');
      assert.strictEqual(processorRights.use, true, 'Use is recognized outside the grid');

      updateRight(model, 'Document.Sale & Return', 'view', true);
      const output = RoleXmlSerializer.serializeToXml(model, '2.20');
      const expected = RICH_DESIGNER_ROLE.replace('<View>false</View>', '<View>true</View>');
      assert.strictEqual(output, expected, 'an unrelated edit must preserve source formatting and all other XML byte-for-byte');
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('applies an explicit false without removing absent or neighboring rights', () => {
    const sourceXml = RICH_DESIGNER_ROLE.replace('<View>false</View>', '<View>true</View>');
    const roleModel = {
      name: 'Power',
      filePath: 'Role.xml',
      rights: {
        'Document.Sale & Return': {
          read: true,
          insert: false,
          update: false,
          delete: false,
          view: true,
          edit: false,
          interactiveInsert: false,
          interactiveDelete: false,
          interactiveDeleteMarked: false,
          interactiveDeletePredefinedData: false,
          interactiveSetDeletionMark: false,
          interactiveClearDeletionMark: false,
          interactiveDeleteMarkedPredefinedData: false,
          posting: true,
        },
      },
      metadata: { format: ConfigFormat.Designer, version: '2.20', lastModified: new Date() },
      sourceXml,
      changedRights: { 'Document.Sale & Return': { view: false } },
    } as unknown as RoleModel;

    const output = RoleXmlSerializer.serializeToXml(roleModel, '2.20');
    assert.strictEqual(
      output,
      sourceXml.replace('<View>true</View>', '<View>false</View>'),
      'the touched false value must be written while explicit false, unknown, and neighboring nodes remain present'
    );
    assert.match(output, /<Posting>true<\/Posting><UndoPosting>false<\/UndoPosting>/);
    assert.match(output, /<FutureRight mode="vendor"><Payload>A &amp; B<\/Payload><\/FutureRight>/);
    assert.match(output, /<InteractiveClear>true<\/InteractiveClear><InteractiveUndeleteMarked>true<\/InteractiveUndeleteMarked>/);
    assert.match(output, /<Name>Neighbor<\/Name><Read>false<\/Read><Posting>false<\/Posting>/);
    assert.match(output, /<FutureNestedRight><Value>untouched<\/Value><\/FutureNestedRight>/);
  });

  test('registry applicability, Agent DSL, and parser agree for non-grid Document, Task, and register rights', () => {
    const adminEntries = compileRoleRightsDsl([
      'Document.Sale: @admin',
      'Task.Approval: @admin',
      'InformationRegister.Prices: @admin',
      'DataProcessor.Import: @admin',
    ]);
    const entryByType = new Map(adminEntries.map((entry) => [entry.type, entry]));

    for (const type of ['Document', 'Task', 'InformationRegister', 'DataProcessor']) {
      const registeredNames = getRoleRightsForType(type).map((right) => right.xmlName).sort();
      assert.deepStrictEqual(Object.keys(entryByType.get(type)!.rights).sort(), registeredNames);
      assert.ok(getRoleRightsForType(type).every((right) => ROLE_RIGHTS_REGISTRY.includes(right)));
    }
    assert.strictEqual(entryByType.get('Document')!.rights.Posting, true);
    assert.strictEqual(entryByType.get('Task')!.rights.Execute, true);
    assert.strictEqual(entryByType.get('InformationRegister')!.rights.TotalsControl, true);
    assert.strictEqual(entryByType.get('DataProcessor')!.rights.Use, true);
  });

  test('Agent-created EDT rights survive parsing and a UI edit; unknown siblings and XML escaping remain intact', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-rights-ui-roundtrip-'));
    const roleDir = path.join(root, 'src', 'Roles', 'Power');
    const rolePath = path.join(roleDir, 'Power.xml');
    const rightsPath = path.join(roleDir, 'Ext', 'Rights.xml');
    await fs.promises.mkdir(path.dirname(rightsPath), { recursive: true });
    await fs.promises.writeFile(rolePath, '<Role><Properties><Name>Power</Name></Properties></Role>', 'utf8');

    try {
      const [agentEntry] = compileRoleRightsDsl(['Document.Sale: @post']);
      const dom = createMinimalRightsDom('2.20');
      mergeNamedRightsIntoDom(dom, { [agentEntry!.objectName]: agentEntry!.rights });
      const createdRightsXml = serializeRightsDomToXml(dom, '2.20').replace(
        '</object>',
        '<right><name>FutureRight</name><value>true</value></right></object>'
      );
      assert.strictEqual(XMLValidator.validate(createdRightsXml), true);
      await fs.promises.writeFile(rightsPath, createdRightsXml, 'utf8');

      const model = await RoleXmlParser.parseRoleXml(rolePath);
      const parsed = model.rights['Document.Sale'] as unknown as Record<string, boolean>;
      assert.strictEqual(parsed.posting, true);
      assert.strictEqual(parsed.undoPosting, true);
      assert.strictEqual(parsed.interactivePosting, true);

      updateRight(model, 'Document.Sale', 'view', false);
      const editedDom = await loadRightsXml(rightsPath, '2.20');
      mergeRightsIntoDom(editedDom, model.changedRights ?? {});
      const savedRightsXml = serializeRightsDomToXml(editedDom, '2.20');
      assert.strictEqual(XMLValidator.validate(savedRightsXml), true);
      assert.match(savedRightsXml, /<name>Posting<\/name>\s*<value>true<\/value>/);
      assert.match(savedRightsXml, /<name>FutureRight<\/name>\s*<value>true<\/value>/);

      await fs.promises.writeFile(rightsPath, savedRightsXml, 'utf8');
      const reopened = await RoleXmlParser.parseRoleXml(rolePath);
      const reopenedRights = reopened.rights['Document.Sale'] as unknown as Record<string, boolean>;
      assert.strictEqual(reopenedRights.posting, true);
      assert.strictEqual(reopenedRights.view, false);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('inserts a missing Designer right with escaped object names while retaining sibling objects', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'designer-right-insert-'));
    const rolePath = path.join(root, 'Roles', 'Power', 'Role.xml');
    await fs.promises.mkdir(path.dirname(rolePath), { recursive: true });
    await fs.promises.writeFile(rolePath, RICH_DESIGNER_ROLE, 'utf8');

    try {
      const model = await RoleXmlParser.parseRoleXml(rolePath);
      updateRight(model, 'Document.New & Return', 'posting', true);
      const output = RoleXmlSerializer.serializeToXml(model, '2.20');
      assert.strictEqual(XMLValidator.validate(output), true);
      assert.match(output, /<Name>New &amp; Return<\/Name><Posting>true<\/Posting>/);
      assert.match(output, /<Name>Neighbor<\/Name><Read>false<\/Read><Posting>false<\/Posting>/);
      assert.match(output, /<FutureRight mode="vendor"><Payload>A &amp; B<\/Payload><\/FutureRight>/);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('updates a prefixed self-closing right without dropping its attributes', () => {
    const sourceXml = '<v8:MetaDataObject xmlns:v8="http://v8.1c.ru/8.3/MDClasses"><v8:Role><v8:Rights><v8:Document><v8:Object><v8:Name>Sale</v8:Name><v8:View marker="keep" /></v8:Object></v8:Document></v8:Rights></v8:Role></v8:MetaDataObject>';
    const output = mergeDesignerRoleRightsXml(sourceXml, {
      'Document.Sale': { view: true },
    });
    assert.strictEqual(XMLValidator.validate(output), true);
    assert.ok(output.includes('<v8:View marker="keep" >true</v8:View>'));
  });

  test('patches only 1C Rights and Read elements when extension namespaces reuse their local names', () => {
    for (const fixture of NAMESPACE_COLLISION_ROLES) {
      const output = mergeDesignerRoleRightsXml(fixture.xml, {
        'Document.Sale': { read: true },
      });
      assert.strictEqual(output, fixture.expected, `${fixture.name} extension elements must remain untouched`);
    }
  });

  test('does not treat xmlns-like text inside quoted attributes as namespace declarations', () => {
    const cases = [
      {
        attributes: `note=" xmlns:m='urn:shadow' " marker='keep &quot;quotes&quot; and xmlns:x="urn:shadow-x"'`,
      },
      {
        attributes: `note=' xmlns:m="urn:shadow" ' marker="keep 'quotes' and xmlns:x='urn:shadow-x'"`,
      },
    ];

    for (const { attributes } of cases) {
      const sourceXml = `<m:MetaDataObject xmlns:m="http://v8.1c.ru/8.3/MDClasses"><m:Role><m:Rights><m:Document><m:Object><m:Name>Sale</m:Name><m:Read ${attributes}>false</m:Read></m:Object></m:Document></m:Rights></m:Role></m:MetaDataObject>`;
      assert.strictEqual(XMLValidator.validate(sourceXml), true);
      const expected = sourceXml.replace('>false</m:Read>', '>true</m:Read>');
      const output = mergeDesignerRoleRightsXml(sourceXml, {
        'Document.Sale': { read: true },
      });
      assert.strictEqual(output, expected, 'the existing 1C Read must be patched without duplication or attribute changes');
    }
  });

  test('preserves an explicit false non-grid right and omits a neighboring object with no rights after UI save', async () => {
    const sourceXml = `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><Role><Rights><Document><Object><Name>Sale</Name><Posting>false</Posting></Object><Object><Name>Neighbor</Name></Object></Document></Rights></Role></MetaDataObject>`;
    const extracted = extractDesignerRoleRightsXml(sourceXml);
    const saleRights = extracted['Document.Sale'];
    assert.ok(saleRights, 'recognized explicit-false rights must retain their object in the intermediate model');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(saleRights, 'posting'), true);
    assert.strictEqual(saleRights.posting, false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(saleRights, 'read'), false, 'an absent right must remain absent');
    assert.strictEqual(extracted['Document.Neighbor'], undefined, 'an object with no rights must not be created');

    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'role-rights-explicit-false-'));
    const rolePath = path.join(root, 'Roles', 'Power', 'Role.xml');
    await fs.promises.mkdir(path.dirname(rolePath), { recursive: true });
    await fs.promises.writeFile(rolePath, sourceXml, 'utf8');

    try {
      const model = await RoleXmlParser.parseRoleXml(rolePath);
      assert.strictEqual(model.rights['Document.Sale']?.posting, false);
      assert.strictEqual(model.rights['Document.Neighbor'], undefined);

      updateRight(model, 'Document.Sale', 'view', true);
      const savedXml = RoleXmlSerializer.serializeToXml(model, '2.20');
      assert.match(savedXml, /<Posting>false<\/Posting><View>true<\/View>/);
      assert.match(savedXml, /<Object><Name>Neighbor<\/Name><\/Object>/);

      await fs.promises.writeFile(rolePath, savedXml, 'utf8');
      const reopened = await RoleXmlParser.parseRoleXml(rolePath);
      assert.strictEqual(reopened.rights['Document.Sale']?.posting, false);
      assert.strictEqual(reopened.rights['Document.Sale']?.view, true);
      assert.strictEqual(reopened.rights['Document.Neighbor'], undefined);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('parses only 1C Read elements when extension namespaces reuse their local name', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'role-namespace-collision-'));
    const rolePath = path.join(root, 'Roles', 'Power', 'Role.xml');
    await fs.promises.mkdir(path.dirname(rolePath), { recursive: true });

    try {
      for (const fixture of NAMESPACE_COLLISION_ROLES) {
        const parserXml = fixture.xml
          .replace(
            '<ext:Read>false</ext:Read><ext:FutureRight>true',
            '<ext:Read>true</ext:Read><ext:View>true</ext:View><ext:FutureRight>true'
          )
          .replace(
            '<ext:Read>false</ext:Read><Read>false</Read>',
            '<Read>false</Read><View>true</View><ext:Read>true</ext:Read>'
          );
        await fs.promises.writeFile(rolePath, parserXml, 'utf8');
        const model = await RoleXmlParser.parseRoleXml(rolePath);
        assert.strictEqual(
          model.rights['Document.Sale']?.read,
          false,
          `${fixture.name} parser must ignore extension Read and read the 1C element`
        );
        assert.strictEqual(model.rights['Document.Sale']?.view, true);
      }
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
