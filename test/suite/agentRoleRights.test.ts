import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerAgentCommands } from '../../src/agent/agentCommands';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import { compileRoleRightsDsl, planSetRoleRights } from '../../src/agent/agentRoleRights';
import { DebugSessionRegistry } from '../../src/agent/debugSessionRegistry';
import { registerMcpTools } from '../../src/agent/mcpAdapter/toolCatalog';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import type { MutationPlan } from '../../src/services/configurationSession/mutationPlan';
import type { AgentResult, AgentSetRoleRightsResult } from '../../src/agent/types';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

const CONFIGURATION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Configuration uuid="c308661b-d0a1-4c5b-96f5-5db387a060e4">
    <Properties><Name>RoleRightsTest</Name></Properties>
    <ChildObjects><Catalog>Products</Catalog><Role>Operator</Role></ChildObjects>
  </Configuration>
</MetaDataObject>`;

const CATALOG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Catalog uuid="44444444-4444-4444-8444-444444444444">
    <Properties><Name>Products</Name></Properties>
    <ChildObjects>
      <Attribute uuid="11111111-1111-4111-8111-111111111111"><Properties><Name>Code</Name></Properties></Attribute>
      <Attribute uuid="77777777-7777-4777-8777-777777777777"><Properties><Name>Price</Name></Properties></Attribute>
      <TabularSection uuid="22222222-2222-4222-8222-222222222222">
        <Properties><Name>Lines</Name></Properties>
        <ChildObjects><Attribute uuid="33333333-3333-4333-8333-333333333333"><Properties><Name>Item</Name></Properties></Attribute></ChildObjects>
      </TabularSection>
      <Command uuid="66666666-6666-4666-8666-666666666666"><Properties><Name>OpenCard</Name></Properties></Command>
    </ChildObjects>
  </Catalog>
</MetaDataObject>`;

const DESIGNER_ROLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">
  <Role uuid="55555555-5555-4555-8555-555555555555">
    <Properties><Name>Operator</Name><Synonym><v8:item><v8:lang>en</v8:lang><v8:content>Operator</v8:content></v8:item></Synonym></Properties>
    <ExtensionMetadata>must survive</ExtensionMetadata><ChildObjects/>
  </Role>
</MetaDataObject>`;

async function createDesignerFixture(rightsXml?: string): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-role-rights-'));
  await fs.promises.mkdir(path.join(root, 'Roles', 'Operator', 'Ext'), { recursive: true });
  await fs.promises.mkdir(path.join(root, 'Catalogs'), { recursive: true });
  await fs.promises.writeFile(path.join(root, 'Configuration.xml'), CONFIGURATION_XML, 'utf8');
  await fs.promises.writeFile(path.join(root, 'Catalogs', 'Products.xml'), CATALOG_XML, 'utf8');
  await fs.promises.writeFile(path.join(root, 'Roles', 'Operator.xml'), DESIGNER_ROLE_XML, 'utf8');
  if (rightsXml !== undefined) {
    await fs.promises.writeFile(path.join(root, 'Roles', 'Operator', 'Ext', 'Rights.xml'), rightsXml, 'utf8');
  }
  return root;
}

async function createEdtFixture(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-role-rights-edt-'));
  await fs.promises.mkdir(path.join(root, 'src', 'Configuration'), { recursive: true });
  await fs.promises.mkdir(path.join(root, 'src', 'Roles', 'Operator', 'Ext'), { recursive: true });
  await fs.promises.mkdir(path.join(root, 'src', 'Catalogs', 'Products'), { recursive: true });
  await fs.promises.writeFile(
    path.join(root, 'src', 'Configuration', 'Configuration.mdo'),
    `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Configuration uuid="c308661b-d0a1-4c5b-96f5-5db387a060e4"><Properties><Name>RoleRightsTest</Name></Properties></Configuration></MetaDataObject>`,
    'utf8',
  );
  await fs.promises.writeFile(
    path.join(root, 'src', 'Roles', 'Operator', 'Role.mdo'),
    `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20"><Role uuid="55555555-5555-4555-8555-555555555555"><Properties><Name>Operator</Name></Properties><ChildObjects/></Role></MetaDataObject>`,
    'utf8',
  );
  await fs.promises.writeFile(
    path.join(root, 'src', 'Catalogs', 'Products', 'Catalog.mdo'),
    CATALOG_XML,
    'utf8',
  );
  await fs.promises.writeFile(
    path.join(root, 'src', 'Roles', 'Operator', 'Ext', 'Rights.xml'),
    `<?xml version="1.0" encoding="UTF-8"?><Rights xmlns="http://v8.1c.ru/8.2/roles" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Rights" version="2.20"><setForNewObjects>false</setForNewObjects><setForAttributesByDefault>false</setForAttributesByDefault><independentRightsOfChildObjects>false</independentRightsOfChildObjects><object><name>Catalog.Products</name><right><name>Read</name><value>true</value><restrictionByCondition><condition>Owner = &amp;CurrentUser</condition></restrictionByCondition></right><right><name>FutureRight</name><value>true</value></right></object></Rights>`,
    'utf8',
  );
  return root;
}

function separateRightsXml(
  attributesByDefault: boolean,
  independentChildRights: boolean,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Rights xmlns="http://v8.1c.ru/8.2/roles" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Rights" version="2.20">
  <setForNewObjects>false</setForNewObjects>
  <setForAttributesByDefault>${attributesByDefault}</setForAttributesByDefault>
  <independentRightsOfChildObjects>${independentChildRights}</independentRightsOfChildObjects>
  <object><name>Catalog.Products</name>
    <right><name>Read</name><value>true</value><restrictionByCondition><condition>Owner = &amp;CurrentUser</condition></restrictionByCondition></right>
    <right><name>UnknownRight</name><value>keep me</value></right>
  </object>
  <object><name>Catalog.Products.Attribute.Code</name><right><name>View</name><value>false</value></right><right><name>Edit</name><value>true</value></right></object>
  <object><name>Catalog.Products.TabularSection.Lines</name><right><name>View</name><value>true</value></right><right><name>Edit</name><value>false</value></right></object>
  <object><name>Catalog.Products.TabularSection.Lines.Attribute.Item</name><right><name>View</name><value>false</value></right><right><name>Edit</name><value>true</value></right></object>
</Rights>`;
}

function emptyRightsXml(attributesByDefault = false, independentChildRights = false): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Rights xmlns="http://v8.1c.ru/8.2/roles" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Rights" version="2.20">
  <setForNewObjects>false</setForNewObjects>
  <setForAttributesByDefault>${attributesByDefault}</setForAttributesByDefault>
  <independentRightsOfChildObjects>${independentChildRights}</independentRightsOfChildObjects>
</Rights>`;
}

function plannedRoleXml(plan: MutationPlan<AgentResult<AgentSetRoleRightsResult>>): string {
  const write = plan.steps.find((step) => step.type === 'writeFile');
  assert.ok(write && write.type === 'writeFile');
  return write.content;
}

function rightsObjectFragment(xml: string, objectName: string): string {
  const start = xml.indexOf(`<name>${objectName}</name>`);
  if (start < 0) {return '';}
  const nextObject = xml.indexOf('<object>', start);
  return xml.slice(start, nextObject >= 0 ? nextObject : xml.length);
}

function grantedRights(type: string, name: string, definition: string): string[] {
  const [entry] = compileRoleRightsDsl([`${type}.${name}: ${definition}`]);
  return Object.entries(entry!.rights)
    .filter(([, granted]) => granted)
    .map(([right]) => right)
    .sort();
}

function expectGrantedRights(type: string, definition: string, expected: readonly string[]): void {
  assert.deepStrictEqual(grantedRights(type, 'TestObject', definition), [...expected].sort(), `${type} ${definition}`);
}

suite('agent role rights', () => {
  test('uses the platform default for a missing Designer Rights.xml', async () => {
    const root = await createDesignerFixture();
    try {
      const plan = await planSetRoleRights(root, ConfigFormat.Designer, {
        roleName: 'Operator',
        objects: ['Catalog.Products: Read'],
      });
      const write = plan.steps.find((step) => step.type === 'writeFile');
      assert.ok(write && write.type === 'writeFile');
      assert.strictEqual(
        path.relative(root, write.targetPath).split(path.sep).join('/'),
        'Roles/Operator/Ext/Rights.xml',
      );
      assert.match(write.content, /<setForAttributesByDefault>true<\/setForAttributesByDefault>/);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('Designer writes the separate Rights.xml and leaves role metadata untouched', async () => {
    const initialRightsXml = separateRightsXml(false, true);
    const root = await createDesignerFixture(initialRightsXml);
    const roleMetadataPath = path.join(root, 'Roles', 'Operator.xml');
    const rightsPath = path.join(root, 'Roles', 'Operator', 'Ext', 'Rights.xml');
    const roleMetadataBefore = await fs.promises.readFile(roleMetadataPath, 'utf8');
    try {
      const plan = await planSetRoleRights(root, ConfigFormat.Designer, {
        roleName: 'Operator',
        objects: ['Catalog.Products: @edit'],
      });
      const writes = plan.steps.filter((step) => step.type === 'writeFile');
      assert.strictEqual(writes.length, 1);
      assert.ok(writes[0] && writes[0].type === 'writeFile');
      assert.strictEqual(writes[0].targetPath, rightsPath);
      assert.notStrictEqual(writes[0].targetPath, roleMetadataPath);
      assert.strictEqual(await fs.promises.readFile(roleMetadataPath, 'utf8'), roleMetadataBefore);
      assert.match(writes[0].content, /<setForAttributesByDefault>false<\/setForAttributesByDefault>/);
      assert.match(writes[0].content, /<independentRightsOfChildObjects>true<\/independentRightsOfChildObjects>/);
      assert.match(writes[0].content, /restrictionByCondition[\s\S]*Owner = &amp;CurrentUser[\s\S]*<\/restrictionByCondition>/);
      assert.match(writes[0].content, /UnknownRight[\s\S]*keep me/);
      const codeRights = rightsObjectFragment(writes[0].content, 'Catalog.Products.Attribute.Code');
      assert.match(codeRights, /<name>View<\/name>\s*<value>false<\/value>/);
      assert.match(codeRights, /<name>Edit<\/name>\s*<value>true<\/value>/);
      const sectionRights = rightsObjectFragment(writes[0].content, 'Catalog.Products.TabularSection.Lines');
      assert.match(sectionRights, /<name>View<\/name>\s*<value>true<\/value>/);
      assert.match(sectionRights, /<name>Edit<\/name>\s*<value>false<\/value>/);
      const columnRights = rightsObjectFragment(writes[0].content, 'Catalog.Products.TabularSection.Lines.Attribute.Item');
      assert.match(columnRights, /<name>View<\/name>\s*<value>false<\/value>/);
      assert.match(columnRights, /<name>Edit<\/name>\s*<value>true<\/value>/);
      assert.strictEqual(rightsObjectFragment(writes[0].content, 'Catalog.Products.Attribute.Price'), '');
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  for (const [attributesByDefault, independentChildRights] of [[false, true], [true, false]]) {
    test(`EDT preserves role defaults ${attributesByDefault}/${independentChildRights} and explicit child View/Edit`, async () => {
      const root = await createEdtFixture();
      const rightsPath = path.join(root, 'src', 'Roles', 'Operator', 'Ext', 'Rights.xml');
      try {
        await fs.promises.writeFile(
          rightsPath,
          separateRightsXml(attributesByDefault, independentChildRights),
          'utf8',
        );
        const plan = await planSetRoleRights(root, ConfigFormat.EDT, {
          roleName: 'Operator',
          objects: ['Catalog.Products: @edit'],
        });
        const output = plannedRoleXml(plan);
        assert.match(output, new RegExp(`<setForAttributesByDefault>${attributesByDefault}</setForAttributesByDefault>`));
        assert.match(output, new RegExp(`<independentRightsOfChildObjects>${independentChildRights}</independentRightsOfChildObjects>`));

        const codeRights = rightsObjectFragment(output, 'Catalog.Products.Attribute.Code');
        assert.match(codeRights, /<name>View<\/name>\s*<value>false<\/value>/);
        assert.match(codeRights, /<name>Edit<\/name>\s*<value>true<\/value>/);
        const sectionRights = rightsObjectFragment(output, 'Catalog.Products.TabularSection.Lines');
        assert.match(sectionRights, /<name>View<\/name>\s*<value>true<\/value>/);
        assert.match(sectionRights, /<name>Edit<\/name>\s*<value>false<\/value>/);
        const columnRights = rightsObjectFragment(output, 'Catalog.Products.TabularSection.Lines.Attribute.Item');
        assert.match(columnRights, /<name>View<\/name>\s*<value>false<\/value>/);
        assert.match(columnRights, /<name>Edit<\/name>\s*<value>true<\/value>/);
        assert.strictEqual(rightsObjectFragment(output, 'Catalog.Products.Attribute.Unspecified'), '');
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    });
  }

  test('read preset grants the applicable Use rights for non-record metadata types', () => {
    const entries = compileRoleRightsDsl([
      'DataProcessor.Import: @view',
      'Report.Summary: @view',
      'WebService.PublicApi: @view',
    ]);
    assert.deepStrictEqual(entries.map((entry) => entry.rights), [
      { Use: true, View: true },
      { Use: true, View: true },
      { Use: true },
    ]);
  });

  test('@edit retains every applicable @view right for DataProcessor, Report and services', () => {
    for (const type of ['DataProcessor', 'Report']) {
      expectGrantedRights(type, '@view', ['Use', 'View']);
      expectGrantedRights(type, '@edit', ['Use', 'View']);
    }
    for (const type of ['WebService', 'HTTPService', 'IntegrationService', 'ExternalDataSource']) {
      expectGrantedRights(type, '@view', ['Use']);
      expectGrantedRights(type, '@edit', ['Use']);
    }
  });

  test('view and edit presets match the role-spec matrix for Catalog, Document, InformationRegister and ChartOfCharacteristicTypes', () => {
    expectGrantedRights('Catalog', '@view', ['Read', 'View', 'InputByString']);
    expectGrantedRights('Catalog', '@edit', [
      'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'InteractiveInsert',
      'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark', 'InteractiveDelete',
      'InteractiveDeleteMarked', 'InteractiveDeletePredefinedData',
      'InteractiveSetDeletionMarkPredefinedData', 'InteractiveClearDeletionMarkPredefinedData',
      'InteractiveDeleteMarkedPredefinedData',
    ]);

    expectGrantedRights('Document', '@view', ['Read', 'View', 'InputByString']);
    expectGrantedRights('Document', '@edit', [
      'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'InteractiveInsert',
      'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark', 'InteractiveDelete',
      'InteractiveDeleteMarked',
    ]);

    expectGrantedRights('InformationRegister', '@view', ['Read', 'View']);
    expectGrantedRights('InformationRegister', '@edit', ['Read', 'Update', 'View', 'Edit']);

    expectGrantedRights('ChartOfCharacteristicTypes', '@view', ['Read', 'View', 'InputByString']);
    expectGrantedRights('ChartOfCharacteristicTypes', '@edit', [
      'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'InteractiveInsert',
      'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark', 'InteractiveDelete',
      'InteractiveDeleteMarked', 'InteractiveDeletePredefinedData',
      'InteractiveSetDeletionMarkPredefinedData', 'InteractiveClearDeletionMarkPredefinedData',
      'InteractiveDeleteMarkedPredefinedData',
    ]);
  });

  test('@post is exactly @edit plus four posting rights for Document', () => {
    expectGrantedRights('Document', '@post', [
      'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'InteractiveInsert',
      'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark', 'InteractiveDelete',
      'InteractiveDeleteMarked', 'Posting', 'UndoPosting', 'InteractivePosting', 'InteractiveUndoPosting',
    ]);
    for (const right of ['InteractivePostingRegular', 'InteractiveChangeOfPosted']) {
      assert.strictEqual(grantedRights('Document', 'TestObject', '@post').includes(right), false, right);
    }
    for (const type of ['Catalog', 'InformationRegister', 'ChartOfCharacteristicTypes']) {
      assert.throws(
        () => compileRoleRightsDsl([`${type}.TestObject: @post`]),
        (error: unknown) => (error as { code?: string }).code === 'UNSUPPORTED_ROLE_PRESET',
        `${type} must reject @post`,
      );
    }
  });

  test('@admin enables the complete spec rights set and explicit rights remain type-checked', () => {
    const adminRights: Readonly<Record<string, readonly string[]>> = {
      Catalog: [
        'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'InteractiveInsert',
        'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark', 'InteractiveDelete',
        'InteractiveDeleteMarked', 'InteractiveDeletePredefinedData',
        'InteractiveSetDeletionMarkPredefinedData', 'InteractiveClearDeletionMarkPredefinedData',
        'InteractiveDeleteMarkedPredefinedData', 'ReadDataHistory', 'ViewDataHistory',
        'UpdateDataHistory', 'UpdateDataHistoryOfMissingData', 'ReadDataHistoryOfMissingData',
        'UpdateDataHistorySettings', 'UpdateDataHistoryVersionComment',
        'EditDataHistoryVersionComment', 'SwitchToDataHistoryVersion',
      ],
      Document: [
        'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'InteractiveInsert',
        'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark', 'InteractiveDelete',
        'InteractiveDeleteMarked', 'ReadDataHistory', 'ViewDataHistory', 'UpdateDataHistory',
        'UpdateDataHistoryOfMissingData', 'ReadDataHistoryOfMissingData', 'UpdateDataHistorySettings',
        'UpdateDataHistoryVersionComment', 'EditDataHistoryVersionComment', 'SwitchToDataHistoryVersion',
        'Posting', 'UndoPosting', 'InteractivePosting', 'InteractivePostingRegular',
        'InteractiveUndoPosting', 'InteractiveChangeOfPosted',
      ],
      InformationRegister: [
        'Read', 'Update', 'View', 'Edit', 'TotalsControl', 'ReadDataHistory', 'ViewDataHistory',
        'UpdateDataHistory', 'UpdateDataHistoryOfMissingData', 'ReadDataHistoryOfMissingData',
        'UpdateDataHistorySettings', 'UpdateDataHistoryVersionComment',
        'EditDataHistoryVersionComment', 'SwitchToDataHistoryVersion',
      ],
      ChartOfCharacteristicTypes: [
        'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'InteractiveInsert',
        'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark', 'InteractiveDelete',
        'InteractiveDeletePredefinedData', 'InteractiveSetDeletionMarkPredefinedData',
        'InteractiveClearDeletionMarkPredefinedData', 'InteractiveDeleteMarkedPredefinedData',
        'ReadDataHistory', 'ReadDataHistoryOfMissingData', 'UpdateDataHistory',
        'UpdateDataHistoryOfMissingData', 'UpdateDataHistorySettings',
        'UpdateDataHistoryVersionComment', 'InteractiveDeleteMarked',
        'EditDataHistoryVersionComment', 'SwitchToDataHistoryVersion', 'ViewDataHistory',
      ],
    };
    for (const [type, expected] of Object.entries(adminRights)) {
      expectGrantedRights(type, '@admin', expected);
    }

    expectGrantedRights('Catalog', 'ReadDataHistory', ['ReadDataHistory']);
    expectGrantedRights('Document', 'Posting', ['Posting']);
    expectGrantedRights('InformationRegister', 'TotalsControl', ['TotalsControl']);
    expectGrantedRights('ChartOfCharacteristicTypes', 'SwitchToDataHistoryVersion', ['SwitchToDataHistoryVersion']);

    for (const type of ['Catalog', 'InformationRegister', 'ChartOfCharacteristicTypes']) {
      assert.throws(
        () => compileRoleRightsDsl([`${type}.TestObject: Posting`]),
        (error: unknown) => (error as { code?: string }).code === 'UNSUPPORTED_ROLE_RIGHT',
        `${type} must reject the Posting right`,
      );
    }
  });

  test('does not create false-only child rights objects for a read-only parent', async () => {
    const root = await createDesignerFixture(emptyRightsXml());
    try {
      const plan = await planSetRoleRights(root, ConfigFormat.Designer, {
        roleName: 'Operator',
        objects: ['Catalog.Products: Read'],
      });
      const output = plannedRoleXml(plan);
      assert.doesNotMatch(output, /Products\.Attribute\.Code/);
      assert.doesNotMatch(output, /Products\.TabularSection\.Lines/);
      assert.doesNotMatch(output, /Products\.TabularSection\.Lines\.Attribute\.Item/);
      assert.doesNotMatch(output, /Products\.Command\.OpenCard/);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('grants View to existing object commands when the parent has View', async () => {
    const root = await createDesignerFixture(emptyRightsXml());
    try {
      const plan = await planSetRoleRights(root, ConfigFormat.Designer, {
        roleName: 'Operator',
        objects: ['Catalog.Products: @view'],
      });
      const output = plannedRoleXml(plan);
      assert.match(output, /<name>Catalog\.Products\.Command\.OpenCard<\/name>[\s\S]*?<name>View<\/name>\s*<value>true<\/value>/);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('plans writes against real EDT MDO and Rights.xml paths while preserving RLS and unknown rights', async () => {
    const root = await createEdtFixture();
    try {
      const plan = await planSetRoleRights(root, ConfigFormat.EDT, {
        roleName: 'Operator',
        objects: ['Catalog.Products: @edit'],
      });
      const write = plan.steps.find((step) => step.type === 'writeFile');
      assert.ok(write && write.type === 'writeFile');
      assert.equal(path.relative(root, write.targetPath).split(path.sep).join('/'), 'src/Roles/Operator/Ext/Rights.xml');
      assert.match(write.content, /restrictionByCondition[\s\S]*Owner = &amp;CurrentUser[\s\S]*<\/restrictionByCondition>/);
      assert.match(write.content, /FutureRight/);
      assert.doesNotMatch(write.content, /Catalog\.Products\.Attribute\.Code/);
      assert.doesNotMatch(write.content, /Catalog\.Products\.TabularSection\.Lines/);
      assert.match(write.content, /Catalog\.Products\.Command\.OpenCard/);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('writes explicit false overrides when setForNewObjects is true and preserves RLS', async () => {
    const root = await createEdtFixture();
    const rightsPath = path.join(root, 'src', 'Roles', 'Operator', 'Ext', 'Rights.xml');
    const original = `<?xml version="1.0" encoding="UTF-8"?>
<Rights xmlns="http://v8.1c.ru/8.2/roles" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Rights" version="2.20">
  <setForNewObjects>true</setForNewObjects><setForAttributesByDefault>false</setForAttributesByDefault><independentRightsOfChildObjects>false</independentRightsOfChildObjects>
  <object><name>Catalog.Products</name>
    <right><name>Read</name><value>true</value><restrictionByCondition><condition>Owner = &amp;CurrentUser</condition></restrictionByCondition></right>
    <right><name>Insert</name><value>true</value></right><right><name>Update</name><value>true</value></right>
  </object>
</Rights>`;
    try {
      await fs.promises.writeFile(rightsPath, original, 'utf8');
      const plan = await planSetRoleRights(root, ConfigFormat.EDT, {
        roleName: 'Operator',
        objects: ['Catalog.Products: @view'],
      });
      const output = plannedRoleXml(plan);
      assert.match(output, /<setForNewObjects>true<\/setForNewObjects>/);
      assert.match(output, /<right>\s*<name>Insert<\/name>\s*<value>false<\/value>\s*<\/right>/);
      assert.match(output, /<right>\s*<name>Update<\/name>\s*<value>false<\/value>\s*<\/right>/);
      assert.match(output, /<name>Read<\/name>[\s\S]*?restrictionByCondition[\s\S]*Owner = &amp;CurrentUser/);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('rejects malformed EDT Rights.xml before creating a write plan and preserves the source bytes', async () => {
    const root = await createEdtFixture();
    const rightsPath = path.join(root, 'src', 'Roles', 'Operator', 'Ext', 'Rights.xml');
    const malformed = `<?xml version="1.0" encoding="UTF-8"?>
<Rights xmlns="http://v8.1c.ru/8.2/roles" version="2.20"><setForNewObjects>false</setForNewObjects>
  <object><name>Catalog.Products</name><right><name>Read</name><value>true</value></right>`;
    try {
      await fs.promises.writeFile(rightsPath, malformed, 'utf8');
      await assert.rejects(
        () => planSetRoleRights(root, ConfigFormat.EDT, {
          roleName: 'Operator',
          objects: ['Catalog.Products: @view'],
        }),
        (error: unknown) => (error as { code?: string }).code === 'ROLE_RIGHTS_METADATA_INVALID',
      );
      assert.strictEqual(await fs.promises.readFile(rightsPath, 'utf8'), malformed);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('uses the configuration name from EDT Configuration.mdo without indexing it as a metadata type', async () => {
    const root = await createEdtFixture();
    try {
      const plan = await planSetRoleRights(root, ConfigFormat.EDT, {
        roleName: 'Operator',
        objects: ['Configuration.RoleRightsTest: @admin'],
      });
      const write = plan.steps.find((step) => step.type === 'writeFile');
      assert.ok(write && write.type === 'writeFile');
      assert.match(write.content, /Configuration\.RoleRightsTest/);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('commits Designer rights through the registered Agent command and compact MCP dispatcher', async () => {
    const root = await createDesignerFixture(separateRightsXml(false, false));
    const registry = new WorkspaceRegistry();
    resetVscodeTestState();
    try {
      await registry.refresh([{ configPath: root }]);
      const descriptor = registry.list()[0];
      assert.ok(descriptor);
      assert.strictEqual(descriptor.format, ConfigFormat.Designer);

      const context = { subscriptions: [] as Array<{ dispose(): void }> };
      registerAgentCommands(context as never, () => null, async () => registry, new DebugSessionRegistry());
      const commandId = '1c-metadata-tree.agent.roles.setRights';
      const agentHandler = vscodeTestState.registeredCommandHandlers.get(commandId);
      assert.ok(agentHandler, 'roles.setRights command should be registered');

      const directResult = await agentHandler({
        configurationId: descriptor.configurationId,
        roleName: 'Operator',
        objects: ['Catalog.Products: @view'],
      }) as AgentResult<AgentSetRoleRightsResult>;
      assert.strictEqual(directResult.success, true, directResult.error);
      assert.ok(directResult.operationId);
      assert.strictEqual(directResult.snapshotVersion, 1);
      assert.strictEqual(directResult.configurationId, descriptor.configurationId);

      const rightsPath = path.join(root, 'Roles', 'Operator', 'Ext', 'Rights.xml');
      const directXml = await fs.promises.readFile(rightsPath, 'utf8');
      assert.match(directXml, /<name>Catalog\.Products<\/name>/);
      assert.match(directXml, /<name>View<\/name>\s*<value>true<\/value>/);
      assert.match(directXml, /restrictionByCondition[\s\S]*Owner = &amp;CurrentUser[\s\S]*<\/restrictionByCondition>/);
      assert.match(directXml, /UnknownRight[\s\S]*keep me/);
      assert.strictEqual(fs.existsSync(path.join(root, '.cdt-journal')), false);

      type CompactHandler = (
        args: Record<string, unknown>,
        extra: { signal: AbortSignal },
      ) => Promise<CallToolResult>;
      const compactHandlers = new Map<string, CompactHandler>();
      const server = {
        registerTool(name: string, _config: unknown, handler: CompactHandler): void {
          compactHandlers.set(name, handler);
        },
      } as unknown as McpServer;
      registerMcpTools(server, async (command, args) => {
        const handler = vscodeTestState.registeredCommandHandlers.get(command);
        assert.ok(handler, `Agent command ${command} should be registered`);
        return handler(args);
      });

      const compactWrite = compactHandlers.get('cdt_write');
      assert.ok(compactWrite, 'compact cdt_write tool should be registered');
      const mcpResult = await compactWrite({
        operation: 'cdt_roles_set_rights',
        arguments: {
          configurationId: descriptor.configurationId,
          roleName: 'Operator',
          objects: ['Catalog.Products: @edit'],
        },
      }, { signal: new AbortController().signal });
      const dispatchedResult = mcpResult.structuredContent as unknown as AgentResult<AgentSetRoleRightsResult>;
      assert.strictEqual(dispatchedResult.success, true, dispatchedResult.error);
      assert.ok(dispatchedResult.operationId);
      assert.notStrictEqual(dispatchedResult.operationId, directResult.operationId);
      assert.strictEqual(dispatchedResult.snapshotVersion, 2);
      assert.strictEqual(dispatchedResult.configurationId, descriptor.configurationId);

      const mcpXml = await fs.promises.readFile(rightsPath, 'utf8');
      assert.match(mcpXml, /<name>Insert<\/name>\s*<value>true<\/value>/);
      assert.match(mcpXml, /restrictionByCondition[\s\S]*Owner = &amp;CurrentUser[\s\S]*<\/restrictionByCondition>/);
      assert.match(mcpXml, /UnknownRight[\s\S]*keep me/);
      assert.strictEqual(registry.require(descriptor.configurationId).snapshotVersion, 2);
      assert.strictEqual(fs.existsSync(path.join(root, '.cdt-journal')), false);
    } finally {
      await registry.dispose();
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      resetVscodeTestState();
    }
  });
});
