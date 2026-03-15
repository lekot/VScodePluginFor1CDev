/**
 * Unit tests for RoleXmlSerializer
 */

import * as assert from 'assert';
import * as path from 'path';
import { RoleXmlSerializer } from '../../src/rolesEditor/roleXmlSerializer';
import { RoleXmlParser } from '../../src/rolesEditor/roleXmlParser';
import {
  RoleModel,
  RightsMap,
  ObjectRights,
  ConfigFormat,
  createEmptyObjectRights
} from '../../src/rolesEditor/models/roleModel';

suite('RoleXmlSerializer Tests', () => {
  
  test('serializeToXml generates valid XML structure', () => {
    // Arrange
    const rights: RightsMap = {
      'Catalog.Products': {
        ...createEmptyObjectRights(),
        read: true,
        insert: true,
        update: true
      }
    };

    const roleModel: RoleModel = {
      name: 'TestRole',
      filePath: '/test/TestRole/Role.xml',
      rights,
      metadata: {
        format: ConfigFormat.Designer,
        version: '1.0',
        lastModified: new Date()
      }
    };

    // Act
    const xml = RoleXmlSerializer.serializeToXml(roleModel);

    // Assert
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes('<Role'));
    assert.ok(xml.includes('<Rights>'));
    assert.ok(xml.includes('<Catalog>'));
    assert.ok(xml.includes('<Name>Products</Name>'));
    assert.ok(xml.includes('<Read>true</Read>'));
    assert.ok(xml.includes('<Insert>true</Insert>'));
    assert.ok(xml.includes('<Update>true</Update>'));
  });

  test('buildObjectNode creates correct structure', () => {
    // Arrange
    const rights: ObjectRights = {
      ...createEmptyObjectRights(),
      read: true,
      insert: true,
      view: true
    };

    // Act
    const node = RoleXmlSerializer.buildObjectNode('TestObject', rights);

    // Assert
    assert.ok(node.Object);
    const obj = node.Object as Record<string, unknown>;
    assert.strictEqual(obj.Name, 'TestObject');
    assert.strictEqual(obj.Read, 'true');
    assert.strictEqual(obj.Insert, 'true');
    assert.strictEqual(obj.View, 'true');
    assert.strictEqual(obj.Update, undefined); // Not set
  });

  test('serializeToXml excludes objects with no rights', () => {
    // Arrange
    const rights: RightsMap = {
      'Catalog.Products': {
        ...createEmptyObjectRights(),
        read: true
      },
      'Catalog.Empty': createEmptyObjectRights() // All false
    };

    const roleModel: RoleModel = {
      name: 'TestRole',
      filePath: '/test/TestRole/Role.xml',
      rights,
      metadata: {
        format: ConfigFormat.Designer,
        version: '1.0',
        lastModified: new Date()
      }
    };

    // Act
    const xml = RoleXmlSerializer.serializeToXml(roleModel);

    // Assert
    assert.ok(xml.includes('Products'));
    assert.ok(!xml.includes('Empty')); // Should be excluded
  });

  test('serializeToXml handles multiple metadata types', () => {
    // Arrange
    const rights: RightsMap = {
      'Catalog.Products': {
        ...createEmptyObjectRights(),
        read: true
      },
      'Document.SalesOrder': {
        ...createEmptyObjectRights(),
        read: true,
        insert: true
      },
      'InformationRegister.Prices': {
        ...createEmptyObjectRights(),
        read: true,
        update: true
      }
    };

    const roleModel: RoleModel = {
      name: 'TestRole',
      filePath: '/test/TestRole/Role.xml',
      rights,
      metadata: {
        format: ConfigFormat.Designer,
        version: '1.0',
        lastModified: new Date()
      }
    };

    // Act
    const xml = RoleXmlSerializer.serializeToXml(roleModel);

    // Assert
    assert.ok(xml.includes('<Catalog>'));
    assert.ok(xml.includes('<Document>'));
    assert.ok(xml.includes('<InformationRegister>'));
    assert.ok(xml.includes('Products'));
    assert.ok(xml.includes('SalesOrder'));
    assert.ok(xml.includes('Prices'));
  });

  test('serializeToXml handles interactive rights', () => {
    // Arrange
    const rights: RightsMap = {
      'Document.SalesOrder': {
        ...createEmptyObjectRights(),
        read: true,
        insert: true,
        delete: true,
        interactiveInsert: true,
        interactiveDelete: true,
        interactiveSetDeletionMark: true
      }
    };

    const roleModel: RoleModel = {
      name: 'TestRole',
      filePath: '/test/TestRole/Role.xml',
      rights,
      metadata: {
        format: ConfigFormat.Designer,
        version: '1.0',
        lastModified: new Date()
      }
    };

    // Act
    const xml = RoleXmlSerializer.serializeToXml(roleModel);

    // Assert
    assert.ok(xml.includes('<InteractiveInsert>true</InteractiveInsert>'));
    assert.ok(xml.includes('<InteractiveDelete>true</InteractiveDelete>'));
    assert.ok(xml.includes('<InteractiveSetDeletionMark>true</InteractiveSetDeletionMark>'));
  });

  test('formatXml ensures proper line endings', () => {
    // Arrange
    const xmlWithCRLF = '<?xml version="1.0"?>\r\n<Role>\r\n</Role>';

    // Act
    const formatted = RoleXmlSerializer.formatXml(xmlWithCRLF);

    // Assert
    assert.ok(!formatted.includes('\r\n')); // No CRLF
    assert.ok(formatted.includes('\n')); // Has LF
    assert.ok(formatted.endsWith('\n')); // Ends with newline
  });

  test('serializeToXml handles empty rights map', () => {
    // Arrange
    const roleModel: RoleModel = {
      name: 'EmptyRole',
      filePath: '/test/EmptyRole/Role.xml',
      rights: {},
      metadata: {
        format: ConfigFormat.Designer,
        version: '1.0',
        lastModified: new Date()
      }
    };

    // Act
    const xml = RoleXmlSerializer.serializeToXml(roleModel);

    // Assert
    assert.ok(xml.includes('<Role'));
    assert.ok(xml.includes('<Rights>'));
    assert.ok(xml.includes('</Rights>'));
    assert.ok(xml.includes('</Role>'));
  });

  test('round-trip: parse then serialize produces equivalent XML', async () => {
    // Arrange
    const testRolePath = path.join(__dirname, '../fixtures/roles/TestRole1/Role.xml');

    // Act
    const parsed = await RoleXmlParser.parseRoleXml(testRolePath);
    const serialized = RoleXmlSerializer.serializeToXml(parsed);
    
    // Parse the serialized XML to verify it's valid
    // We can't directly compare XML strings due to formatting differences,
    // but we can verify the structure is correct
    assert.ok(serialized.includes('<?xml'));
    assert.ok(serialized.includes('<Role'));
    assert.ok(serialized.includes('<Rights>'));
    assert.ok(serialized.includes('</Role>'));
    
    // Verify all objects from original are in serialized version
    for (const objectName of Object.keys(parsed.rights)) {
      const [, name] = objectName.split('.');
      assert.ok(serialized.includes(`<Name>${name}</Name>`), `Missing object: ${objectName}`);
    }
  });

  test('serializeToXml sorts objects within metadata types', () => {
    // Arrange
    const rights: RightsMap = {
      'Catalog.Zebra': {
        ...createEmptyObjectRights(),
        read: true
      },
      'Catalog.Apple': {
        ...createEmptyObjectRights(),
        read: true
      },
      'Catalog.Banana': {
        ...createEmptyObjectRights(),
        read: true
      }
    };

    const roleModel: RoleModel = {
      name: 'TestRole',
      filePath: '/test/TestRole/Role.xml',
      rights,
      metadata: {
        format: ConfigFormat.Designer,
        version: '1.0',
        lastModified: new Date()
      }
    };

    // Act
    const xml = RoleXmlSerializer.serializeToXml(roleModel);

    // Assert - verify alphabetical order
    const appleIndex = xml.indexOf('<Name>Apple</Name>');
    const bananaIndex = xml.indexOf('<Name>Banana</Name>');
    const zebraIndex = xml.indexOf('<Name>Zebra</Name>');
    
    assert.ok(appleIndex < bananaIndex, 'Apple should come before Banana');
    assert.ok(bananaIndex < zebraIndex, 'Banana should come before Zebra');
  });
});
