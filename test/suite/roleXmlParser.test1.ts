/**
 * Unit tests for RoleXmlParser
 */

import * as assert from 'assert';
import * as path from 'path';
import { RoleXmlParser } from '../../src/rolesEditor/roleXmlParser';
import { ConfigFormat } from '../../src/rolesEditor/models/roleModel';

describe('RoleXmlParser', () => {
  const fixturesPath = path.join(__dirname, 'fixtures', 'roles');

  describe('parseRoleXml', () => {
    it('should parse valid Role.xml with multiple objects and rights', async () => {
      const rolePath = path.join(fixturesPath, 'TestRole1', 'Role.xml');
      const roleModel = await RoleXmlParser.parseRoleXml(rolePath);

      // Check basic properties
      assert.strictEqual(roleModel.name, 'TestRole1');
      assert.strictEqual(roleModel.filePath, rolePath);
      assert.strictEqual(roleModel.metadata.format, ConfigFormat.Designer);

      // Check rights map
      assert.ok(roleModel.rights);
      const rightsKeys = Object.keys(roleModel.rights);
      assert.ok(rightsKeys.length > 0, 'Should have at least one object with rights');

      // Check Catalog.Products rights
      const productsRights = roleModel.rights['Catalog.Products'];
      assert.ok(productsRights, 'Should have rights for Catalog.Products');
      assert.strictEqual(productsRights.read, true);
      assert.strictEqual(productsRights.insert, true);
      assert.strictEqual(productsRights.update, true);
      assert.strictEqual(productsRights.delete, false);
      assert.strictEqual(productsRights.view, true);
      assert.strictEqual(productsRights.edit, true);
      assert.strictEqual(productsRights.interactiveInsert, true);

      // Check Catalog.Customers rights
      const customersRights = roleModel.rights['Catalog.Customers'];
      assert.ok(customersRights, 'Should have rights for Catalog.Customers');
      assert.strictEqual(customersRights.read, true);
      assert.strictEqual(customersRights.insert, false);
      assert.strictEqual(customersRights.update, false);
      assert.strictEqual(customersRights.delete, false);
      assert.strictEqual(customersRights.view, true);

      // Check Document.SalesOrder rights
      const salesOrderRights = roleModel.rights['Document.SalesOrder'];
      assert.ok(salesOrderRights, 'Should have rights for Document.SalesOrder');
      assert.strictEqual(salesOrderRights.read, true);
      assert.strictEqual(salesOrderRights.insert, true);
      assert.strictEqual(salesOrderRights.update, true);
      assert.strictEqual(salesOrderRights.delete, true);
      assert.strictEqual(salesOrderRights.interactiveInsert, true);
      assert.strictEqual(salesOrderRights.interactiveDelete, true);
      assert.strictEqual(salesOrderRights.interactiveSetDeletionMark, true);

      // Check InformationRegister.Prices rights
      const pricesRights = roleModel.rights['InformationRegister.Prices'];
      assert.ok(pricesRights, 'Should have rights for InformationRegister.Prices');
      assert.strictEqual(pricesRights.read, true);
      assert.strictEqual(pricesRights.update, true);
      assert.strictEqual(pricesRights.insert, false);
      assert.strictEqual(pricesRights.delete, false);
    });

    it('should parse empty Role.xml and return empty rights map', async () => {
      const rolePath = path.join(fixturesPath, 'EmptyRole', 'Role.xml');
      const roleModel = await RoleXmlParser.parseRoleXml(rolePath);

      assert.strictEqual(roleModel.name, 'EmptyRole');
      assert.strictEqual(roleModel.filePath, rolePath);
      assert.ok(roleModel.rights);
      assert.strictEqual(Object.keys(roleModel.rights).length, 0, 'Should have no rights');
    });

    it('should throw error for non-existent file', async () => {
      const rolePath = path.join(fixturesPath, 'NonExistent', 'Role.xml');
      
      await assert.rejects(
        async () => await RoleXmlParser.parseRoleXml(rolePath),
        /Role\.xml file not found/
      );
    });

    it('should throw error for malformed XML', async () => {
      const rolePath = path.join(fixturesPath, 'MalformedRole', 'Role.xml');
      
      await assert.rejects(
        async () => await RoleXmlParser.parseRoleXml(rolePath),
        /Malformed XML/
      );
    });

    it('should detect Designer format from path', async () => {
      const rolePath = path.join(fixturesPath, 'TestRole1', 'Role.xml');
      const roleModel = await RoleXmlParser.parseRoleXml(rolePath);

      assert.strictEqual(roleModel.metadata.format, ConfigFormat.Designer);
    });
  });

  describe('extractRights', () => {
    it('should extract rights from parsed XML structure', () => {
      const parsed = {
        Role: {
          Rights: {
            Catalog: {
              Object: {
                Name: 'TestCatalog',
                Read: 'true',
                Insert: 'true',
                Update: 'false'
              }
            }
          }
        }
      };

      const rights = RoleXmlParser.extractRights(parsed);
      
      assert.ok(rights['Catalog.TestCatalog']);
      assert.strictEqual(rights['Catalog.TestCatalog'].read, true);
      assert.strictEqual(rights['Catalog.TestCatalog'].insert, true);
      assert.strictEqual(rights['Catalog.TestCatalog'].update, false);
    });

    it('should handle multiple objects in same metadata type', () => {
      const parsed = {
        Role: {
          Rights: {
            Catalog: [
              {
                Object: {
                  Name: 'Catalog1',
                  Read: 'true'
                }
              },
              {
                Object: {
                  Name: 'Catalog2',
                  Read: 'true',
                  Insert: 'true'
                }
              }
            ]
          }
        }
      };

      const rights = RoleXmlParser.extractRights(parsed);
      
      assert.ok(rights['Catalog.Catalog1']);
      assert.ok(rights['Catalog.Catalog2']);
      assert.strictEqual(rights['Catalog.Catalog1'].read, true);
      assert.strictEqual(rights['Catalog.Catalog2'].read, true);
      assert.strictEqual(rights['Catalog.Catalog2'].insert, true);
    });

    it('should return empty map when no Role element found', () => {
      const parsed = {
        SomeOtherElement: {}
      };

      const rights = RoleXmlParser.extractRights(parsed);
      
      assert.strictEqual(Object.keys(rights).length, 0);
    });

    it('should exclude objects with no rights set to true', () => {
      const parsed = {
        Role: {
          Rights: {
            Catalog: {
              Object: {
                Name: 'NoRights',
                Read: 'false',
                Insert: 'false',
                Update: 'false'
              }
            }
          }
        }
      };

      const rights = RoleXmlParser.extractRights(parsed);
      
      assert.strictEqual(Object.keys(rights).length, 0, 'Should not include objects with all rights false');
    });
  });

  describe('extractObjectRights', () => {
    it('should extract all right types correctly', () => {
      const objectNode = {
        Name: 'TestObject',
        Read: 'true',
        Insert: 'true',
        Update: 'false',
        Delete: 'true',
        View: 'true',
        Edit: 'false',
        InteractiveInsert: 'true',
        InteractiveDelete: 'false',
        InteractiveClear: 'true',
        InteractiveDeleteMarked: 'false',
        InteractiveUndeleteMarked: 'true',
        InteractiveDeletePredefinedData: 'false',
        InteractiveSetDeletionMark: 'true',
        InteractiveClearDeletionMark: 'false',
        InteractiveDeleteMarkedPredefinedData: 'true'
      };

      const rights = RoleXmlParser.extractObjectRights(objectNode);

      assert.strictEqual(rights.read, true);
      assert.strictEqual(rights.insert, true);
      assert.strictEqual(rights.update, false);
      assert.strictEqual(rights.delete, true);
      assert.strictEqual(rights.view, true);
      assert.strictEqual(rights.edit, false);
      assert.strictEqual(rights.interactiveInsert, true);
      assert.strictEqual(rights.interactiveDelete, false);
      assert.strictEqual(rights.interactiveClear, true);
      assert.strictEqual(rights.interactiveDeleteMarked, false);
      assert.strictEqual(rights.interactiveUndeleteMarked, true);
      assert.strictEqual(rights.interactiveDeletePredefinedData, false);
      assert.strictEqual(rights.interactiveSetDeletionMark, true);
      assert.strictEqual(rights.interactiveClearDeletionMark, false);
      assert.strictEqual(rights.interactiveDeleteMarkedPredefinedData, true);
    });

    it('should handle boolean values', () => {
      const objectNode = {
        Name: 'TestObject',
        Read: true,
        Insert: false
      };

      const rights = RoleXmlParser.extractObjectRights(objectNode);

      assert.strictEqual(rights.read, true);
      assert.strictEqual(rights.insert, false);
    });

    it('should handle numeric boolean values', () => {
      const objectNode = {
        Name: 'TestObject',
        Read: 1,
        Insert: 0
      };

      const rights = RoleXmlParser.extractObjectRights(objectNode);

      assert.strictEqual(rights.read, true);
      assert.strictEqual(rights.insert, false);
    });

    it('should default to false for missing rights', () => {
      const objectNode = {
        Name: 'TestObject',
        Read: 'true'
        // Other rights not specified
      };

      const rights = RoleXmlParser.extractObjectRights(objectNode);

      assert.strictEqual(rights.read, true);
      assert.strictEqual(rights.insert, false);
      assert.strictEqual(rights.update, false);
      assert.strictEqual(rights.delete, false);
    });

    it('should ignore unknown elements', () => {
      const objectNode = {
        Name: 'TestObject',
        Read: 'true',
        UnknownElement: 'some value',
        AnotherUnknown: 'another value'
      };

      const rights = RoleXmlParser.extractObjectRights(objectNode);

      assert.strictEqual(rights.read, true);
      // Should not throw error, just ignore unknown elements
    });
  });
});
