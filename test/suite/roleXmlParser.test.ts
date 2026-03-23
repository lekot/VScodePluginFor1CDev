import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RoleXmlParser } from '../../src/rolesEditor/roleXmlParser';
import { ConfigFormat } from '../../src/rolesEditor/models/roleModel';

suite('RoleXmlParser Tests', () => {
  test('parseRoleXml parses designer fixture role and rights', async () => {
    const rolePath = path.join(__dirname, '../fixtures/roles/TestRole1/Role.xml');
    const model = await RoleXmlParser.parseRoleXml(rolePath);

    assert.strictEqual(model.name, 'TestRole1');
    assert.strictEqual(model.metadata.format, ConfigFormat.Designer);
    assert.ok(model.metadata.lastModified instanceof Date);

    assert.ok(model.rights['Catalog.Products']);
    assert.strictEqual(model.rights['Catalog.Products'].read, true);
    assert.strictEqual(model.rights['Catalog.Products'].delete, false);
    assert.strictEqual(model.rights['Catalog.Products'].interactiveInsert, true);

    assert.ok(model.rights['Document.SalesOrder']);
    assert.strictEqual(model.rights['Document.SalesOrder'].interactiveDelete, true);
    assert.strictEqual(model.rights['Document.SalesOrder'].interactiveSetDeletionMark, true);
  });

  test('parseRoleXml returns empty rights for empty role', async () => {
    const rolePath = path.join(__dirname, '../fixtures/roles/EmptyRole/Role.xml');
    const model = await RoleXmlParser.parseRoleXml(rolePath);

    assert.deepStrictEqual(model.rights, {});
  });

  test('parseRoleXml throws for missing file', async () => {
    const missingPath = path.join(__dirname, '../fixtures/roles/DoesNotExist/Role.xml');

    await assert.rejects(
      async () => RoleXmlParser.parseRoleXml(missingPath),
      (err: unknown) =>
        err instanceof Error && err.message.includes('Role.xml file not found')
    );
  });

  test('parseRoleXml handles malformed fixture without crashing', async () => {
    const malformedPath = path.join(__dirname, '../fixtures/roles/MalformedRole/Role.xml');
    const model = await RoleXmlParser.parseRoleXml(malformedPath);
    assert.strictEqual(model.name, 'MalformedRole');
    assert.ok(model.rights);
  });

  test('extractRights handles namespaced tags and mixed boolean values', () => {
    const parsed = {
      'v8:Role': {
        'v8:Rights': {
          'v8:Catalog': {
            'v8:Object': {
              'v8:Name': { '#text': 'Items' },
              'v8:Read': '1',
              'v8:Update': 'yes',
              'v8:Delete': 0
            }
          }
        }
      }
    } as Record<string, unknown>;

    const rights = RoleXmlParser.extractRights(parsed);
    assert.ok(rights['Catalog.Items']);
    assert.strictEqual(rights['Catalog.Items'].read, true);
    assert.strictEqual(rights['Catalog.Items'].update, true);
    assert.strictEqual(rights['Catalog.Items'].delete, false);
  });

  test('decodeBasicXmlEntities decodes common entities', () => {
    const s = RoleXmlParser.decodeBasicXmlEntities('&lt;a&gt; &quot;b&quot; &amp; c');
    assert.strictEqual(s, '<a> "b" & c');
  });

  test('extractRestrictionTemplatesBlocks finds restrictionTemplate elements', () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<Rights>',
      '  <object><name>X</name></object>',
      '  <restrictionTemplate>',
      '    <name>T1</name>',
      '    <condition>true</condition>',
      '  </restrictionTemplate>',
      '  <v8:restrictionTemplate><v8:name>T2</v8:name></v8:restrictionTemplate>',
      '</Rights>'
    ].join('\n');
    const blocks = RoleXmlParser.extractRestrictionTemplatesBlocks(xml);
    assert.ok(blocks.includes('<restrictionTemplate>'));
    assert.ok(blocks.includes('T1'));
    assert.ok(blocks.includes('v8:restrictionTemplate'));
    assert.ok(blocks.includes('T2'));
  });

  test('parseRoleXml prefers EDT Rights.xml when present', async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-role-'));
    const roleFilePath = path.join(tempRoot, 'src', 'Roles', 'TestRole.xml');
    const rightsDir = path.join(tempRoot, 'src', 'Roles', 'TestRole', 'Ext');
    const rightsFilePath = path.join(rightsDir, 'Rights.xml');

    await fs.promises.mkdir(path.dirname(roleFilePath), { recursive: true });
    await fs.promises.mkdir(rightsDir, { recursive: true });

    const roleXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Role xmlns="http://v8.1c.ru/8.3/MDClasses">',
      '  <Rights/>',
      '</Role>',
      ''
    ].join('\n');
    await fs.promises.writeFile(roleFilePath, roleXml, 'utf-8');

    const rightsXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Rights>',
      '  <object>',
      '    <name>Catalog.FromRightsXml</name>',
      '    <right><name>Read</name><value>true</value></right>',
      '    <right><name>Delete</name><value>1</value></right>',
      '  </object>',
      '</Rights>',
      ''
    ].join('\n');
    await fs.promises.writeFile(rightsFilePath, rightsXml, 'utf-8');

    try {
      const model = await RoleXmlParser.parseRoleXml(roleFilePath);
      assert.strictEqual(model.metadata.format, ConfigFormat.EDT);
      assert.ok(model.rights['Catalog.FromRightsXml']);
      assert.strictEqual(model.rights['Catalog.FromRightsXml'].read, true);
      assert.strictEqual(model.rights['Catalog.FromRightsXml'].delete, true);
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('parseRoleXml reads Rights.xml object and right names when name nodes are #text + xsi:type (fast-xml-parser)', async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cviewer-rights-name-'));
    const roleFilePath = path.join(tempRoot, 'src', 'Roles', 'TestRole.xml');
    const rightsDir = path.join(tempRoot, 'src', 'Roles', 'TestRole', 'Ext');
    const rightsFilePath = path.join(rightsDir, 'Rights.xml');

    await fs.promises.mkdir(path.dirname(roleFilePath), { recursive: true });
    await fs.promises.mkdir(rightsDir, { recursive: true });

    const roleXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Role xmlns="http://v8.1c.ru/8.3/MDClasses">',
      '  <Rights/>',
      '</Role>',
      ''
    ].join('\n');
    await fs.promises.writeFile(roleFilePath, roleXml, 'utf-8');

    const rightsXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Rights xmlns="http://v8.1c.ru/8.2/roles" xmlns:xs="http://www.w3.org/2001/XMLSchema" ',
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Rights" version="2.20">',
      '  <object>',
      '    <name xsi:type="xs:string">Catalog.NameTextNodeObject</name>',
      '    <right>',
      '      <name xsi:type="xs:string">Read</name>',
      '      <value>true</value>',
      '    </right>',
      '  </object>',
      '</Rights>',
      ''
    ].join('\n');
    await fs.promises.writeFile(rightsFilePath, rightsXml, 'utf-8');

    try {
      const model = await RoleXmlParser.parseRoleXml(roleFilePath);
      assert.ok(
        model.rights['Catalog.NameTextNodeObject'],
        'object key must not be [object Object] from String(nameElement)'
      );
      assert.strictEqual(model.rights['Catalog.NameTextNodeObject'].read, true);
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
