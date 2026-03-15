/**
 * Unit tests for rights update utilities
 */

import * as assert from 'assert';
import {
  updateRight,
  getBaseRight,
  getInteractiveRights,
  isInteractiveRight,
  requiresRead
} from '../../src/rolesEditor/rightsUpdateUtils';
import {
  RoleModel,
  ConfigFormat,
  createEmptyObjectRights
} from '../../src/rolesEditor/models/roleModel';

suite('Rights Update Utils Test Suite', () => {
  let testRoleModel: RoleModel;

  setup(() => {
    // Create a fresh role model for each test
    testRoleModel = {
      name: 'TestRole',
      filePath: '/test/Role.xml',
      rights: {},
      metadata: {
        format: ConfigFormat.Designer,
        version: '1.0',
        lastModified: new Date()
      }
    };
  });

  suite('updateRight() - Basic Functionality', () => {
    test('should enable a single right', () => {
      const result = updateRight(testRoleModel, 'Catalog.Products', 'read', true);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].read, true);
    });

    test('should disable a single right', () => {
      testRoleModel.rights['Catalog.Products'] = createEmptyObjectRights();
      testRoleModel.rights['Catalog.Products'].read = true;
      testRoleModel.rights['Catalog.Products'].insert = true; // Keep another right enabled
      
      const result = updateRight(testRoleModel, 'Catalog.Products', 'read', false);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].read, false);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].insert, true);
    });

    test('should create object rights if not exists', () => {
      const result = updateRight(testRoleModel, 'Document.Invoice', 'insert', true);
      
      assert.strictEqual(result.success, true);
      assert.ok(testRoleModel.rights['Document.Invoice']);
      assert.strictEqual(testRoleModel.rights['Document.Invoice'].insert, true);
    });

    test('should return error for null role model', () => {
      const result = updateRight(null as any, 'Catalog.Products', 'read', true);
      
      assert.strictEqual(result.success, false);
      assert.ok(result.errors.length > 0);
    });

    test('should return error for empty object name', () => {
      const result = updateRight(testRoleModel, '', 'read', true);
      
      assert.strictEqual(result.success, false);
      assert.ok(result.errors.length > 0);
    });
  });

  suite('updateRight() - Automatic Dependency Updates', () => {
    test('should enable Read when enabling Update', () => {
      const result = updateRight(testRoleModel, 'Catalog.Products', 'update', true);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].update, true);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].read, true, 'Read should be automatically enabled');
    });

    test('should enable Read when enabling Delete', () => {
      const result = updateRight(testRoleModel, 'Catalog.Products', 'delete', true);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].delete, true);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].read, true, 'Read should be automatically enabled');
    });

    test('should enable Insert when enabling interactiveInsert', () => {
      const result = updateRight(testRoleModel, 'Catalog.Products', 'interactiveInsert', true);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].interactiveInsert, true);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].insert, true, 'Insert should be automatically enabled');
    });

    test('should enable Delete when enabling interactiveDelete', () => {
      const result = updateRight(testRoleModel, 'Catalog.Products', 'interactiveDelete', true);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].interactiveDelete, true);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].delete, true, 'Delete should be automatically enabled');
    });

    test('should enable Delete and Read when enabling interactiveDeleteMarked', () => {
      const result = updateRight(testRoleModel, 'Catalog.Products', 'interactiveDeleteMarked', true);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].interactiveDeleteMarked, true);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].delete, true, 'Delete should be automatically enabled');
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].read, true, 'Read should be automatically enabled (Delete requires Read)');
    });
  });

  suite('updateRight() - Automatic Cascading Disables', () => {
    test('should disable Update and Delete when disabling Read', () => {
      testRoleModel.rights['Catalog.Products'] = createEmptyObjectRights();
      testRoleModel.rights['Catalog.Products'].read = true;
      testRoleModel.rights['Catalog.Products'].update = true;
      testRoleModel.rights['Catalog.Products'].delete = true;
      testRoleModel.rights['Catalog.Products'].insert = true; // Keep another right to prevent removal
      
      const result = updateRight(testRoleModel, 'Catalog.Products', 'read', false);
      
      assert.strictEqual(result.success, true);
      assert.ok(testRoleModel.rights['Catalog.Products'], 'Object should still exist');
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].read, false);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].update, false, 'Update should be automatically disabled');
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].delete, false, 'Delete should be automatically disabled');
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].insert, true, 'Insert should be preserved');
    });

    test('should disable interactiveInsert when disabling Insert', () => {
      testRoleModel.rights['Catalog.Products'] = createEmptyObjectRights();
      testRoleModel.rights['Catalog.Products'].insert = true;
      testRoleModel.rights['Catalog.Products'].interactiveInsert = true;
      testRoleModel.rights['Catalog.Products'].read = true; // Keep another right to prevent removal
      
      const result = updateRight(testRoleModel, 'Catalog.Products', 'insert', false);
      
      assert.strictEqual(result.success, true);
      assert.ok(testRoleModel.rights['Catalog.Products'], 'Object should still exist');
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].insert, false);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].interactiveInsert, false, 'interactiveInsert should be automatically disabled');
    });

    test('should disable all interactive delete rights when disabling Delete', () => {
      testRoleModel.rights['Catalog.Products'] = createEmptyObjectRights();
      testRoleModel.rights['Catalog.Products'].delete = true;
      testRoleModel.rights['Catalog.Products'].interactiveDelete = true;
      testRoleModel.rights['Catalog.Products'].interactiveDeleteMarked = true;
      testRoleModel.rights['Catalog.Products'].interactiveSetDeletionMark = true;
      testRoleModel.rights['Catalog.Products'].read = true; // Keep another right to prevent removal
      
      const result = updateRight(testRoleModel, 'Catalog.Products', 'delete', false);
      
      assert.strictEqual(result.success, true);
      assert.ok(testRoleModel.rights['Catalog.Products'], 'Object should still exist');
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].delete, false);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].interactiveDelete, false, 'interactiveDelete should be disabled');
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].interactiveDeleteMarked, false, 'interactiveDeleteMarked should be disabled');
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].interactiveSetDeletionMark, false, 'interactiveSetDeletionMark should be disabled');
    });

    test('should disable all delete-related interactive rights when disabling Read', () => {
      testRoleModel.rights['Catalog.Products'] = createEmptyObjectRights();
      testRoleModel.rights['Catalog.Products'].read = true;
      testRoleModel.rights['Catalog.Products'].delete = true;
      testRoleModel.rights['Catalog.Products'].interactiveDelete = true;
      testRoleModel.rights['Catalog.Products'].interactiveClear = true;
      testRoleModel.rights['Catalog.Products'].insert = true; // Keep another right to prevent removal
      
      const result = updateRight(testRoleModel, 'Catalog.Products', 'read', false);
      
      assert.strictEqual(result.success, true);
      assert.ok(testRoleModel.rights['Catalog.Products'], 'Object should still exist');
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].delete, false);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].interactiveDelete, false);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].interactiveClear, false);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].insert, true, 'Insert should be preserved');
    });
  });

  suite('updateRight() - Object Removal', () => {
    test('should remove object from RightsMap when all rights are false', () => {
      testRoleModel.rights['Catalog.Products'] = createEmptyObjectRights();
      testRoleModel.rights['Catalog.Products'].read = true;
      
      const result = updateRight(testRoleModel, 'Catalog.Products', 'read', false);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'], undefined, 'Object should be removed from RightsMap');
      assert.strictEqual(result.updatedRights, null, 'updatedRights should be null when object is removed');
    });

    test('should not remove object if at least one right is true', () => {
      testRoleModel.rights['Catalog.Products'] = createEmptyObjectRights();
      testRoleModel.rights['Catalog.Products'].read = true;
      testRoleModel.rights['Catalog.Products'].insert = true;
      
      const result = updateRight(testRoleModel, 'Catalog.Products', 'read', false);
      
      assert.strictEqual(result.success, true);
      assert.ok(testRoleModel.rights['Catalog.Products'], 'Object should still exist');
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].insert, true);
    });
  });

  suite('updateRight() - Complex Scenarios', () => {
    test('should handle multiple dependency levels correctly', () => {
      // Enable interactiveDeleteMarked which should enable Delete and Read
      const result = updateRight(testRoleModel, 'Catalog.Products', 'interactiveDeleteMarked', true);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].interactiveDeleteMarked, true);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].delete, true);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].read, true);
    });

    test('should preserve unrelated rights when updating', () => {
      testRoleModel.rights['Catalog.Products'] = createEmptyObjectRights();
      testRoleModel.rights['Catalog.Products'].insert = true;
      testRoleModel.rights['Catalog.Products'].view = true;
      
      const result = updateRight(testRoleModel, 'Catalog.Products', 'read', true);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].insert, true, 'Insert should be preserved');
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].view, true, 'View should be preserved');
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].read, true);
    });

    test('should handle toggling the same right multiple times', () => {
      updateRight(testRoleModel, 'Catalog.Products', 'read', true);
      updateRight(testRoleModel, 'Catalog.Products', 'read', false);
      const result = updateRight(testRoleModel, 'Catalog.Products', 'read', true);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(testRoleModel.rights['Catalog.Products'].read, true);
    });
  });

  suite('Helper Functions', () => {
    test('getBaseRight() should return correct base right for interactive rights', () => {
      assert.strictEqual(getBaseRight('interactiveInsert'), 'insert');
      assert.strictEqual(getBaseRight('interactiveDelete'), 'delete');
      assert.strictEqual(getBaseRight('interactiveDeleteMarked'), 'delete');
      assert.strictEqual(getBaseRight('interactiveClear'), 'delete');
    });

    test('getBaseRight() should return null for non-interactive rights', () => {
      assert.strictEqual(getBaseRight('read'), null);
      assert.strictEqual(getBaseRight('insert'), null);
      assert.strictEqual(getBaseRight('update'), null);
    });

    test('getInteractiveRights() should return correct interactive rights for base rights', () => {
      const insertInteractive = getInteractiveRights('insert');
      assert.ok(insertInteractive.includes('interactiveInsert'));
      
      const deleteInteractive = getInteractiveRights('delete');
      assert.ok(deleteInteractive.includes('interactiveDelete'));
      assert.ok(deleteInteractive.includes('interactiveDeleteMarked'));
      assert.ok(deleteInteractive.includes('interactiveClear'));
    });

    test('getInteractiveRights() should return empty array for rights without interactive variants', () => {
      const readInteractive = getInteractiveRights('read');
      assert.strictEqual(readInteractive.length, 0);
    });

    test('isInteractiveRight() should correctly identify interactive rights', () => {
      assert.strictEqual(isInteractiveRight('interactiveInsert'), true);
      assert.strictEqual(isInteractiveRight('interactiveDelete'), true);
      assert.strictEqual(isInteractiveRight('read'), false);
      assert.strictEqual(isInteractiveRight('insert'), false);
    });

    test('requiresRead() should correctly identify rights that require Read', () => {
      assert.strictEqual(requiresRead('update'), true);
      assert.strictEqual(requiresRead('delete'), true);
      assert.strictEqual(requiresRead('read'), false);
      assert.strictEqual(requiresRead('insert'), false);
    });
  });
});
