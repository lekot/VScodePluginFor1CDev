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
});
