/**
 * Unit tests for RightsValidator
 */

import * as assert from 'assert';
import { RightsValidator } from '../../src/rolesEditor/rightsValidator';
import {
  RoleModel,
  RightsMap,
  ObjectRights,
  ConfigFormat,
  createEmptyObjectRights
} from '../../src/rolesEditor/models/roleModel';

suite('RightsValidator Tests', () => {
  let validator: RightsValidator;

  setup(() => {
    validator = new RightsValidator();
  });

  suite('validateRights', () => {
    test('returns valid for correct rights configuration', () => {
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
      const result = validator.validateRights(roleModel);

      // Assert
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    test('returns invalid when Update enabled without Read', () => {
      // Arrange
      const rights: RightsMap = {
        'Catalog.Products': {
          ...createEmptyObjectRights(),
          update: true,
          read: false
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
      const result = validator.validateRights(roleModel);

      // Assert
      assert.strictEqual(result.isValid, false);
      assert.strictEqual(result.errors.length, 1);
      assert.ok(result.errors[0].includes('Update'));
      assert.ok(result.errors[0].includes('Read'));
    });

    test('returns invalid when Delete enabled without Read', () => {
      // Arrange
      const rights: RightsMap = {
        'Document.SalesOrder': {
          ...createEmptyObjectRights(),
          delete: true,
          read: false
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
      const result = validator.validateRights(roleModel);

      // Assert
      assert.strictEqual(result.isValid, false);
      assert.strictEqual(result.errors.length, 1);
      assert.ok(result.errors[0].includes('Delete'));
      assert.ok(result.errors[0].includes('Read'));
    });

    test('validates multiple objects and accumulates errors', () => {
      // Arrange
      const rights: RightsMap = {
        'Catalog.Products': {
          ...createEmptyObjectRights(),
          update: true,
          read: false
        },
        'Document.SalesOrder': {
          ...createEmptyObjectRights(),
          delete: true,
          read: false
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
      const result = validator.validateRights(roleModel);

      // Assert
      assert.strictEqual(result.isValid, false);
      assert.strictEqual(result.errors.length, 2);
      assert.ok(result.errors.some(e => e.includes('Catalog.Products')));
      assert.ok(result.errors.some(e => e.includes('Document.SalesOrder')));
    });

    test('returns valid for empty rights map', () => {
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
      const result = validator.validateRights(roleModel);

      // Assert
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.errors.length, 0);
    });
  });

  suite('validateObjectRights', () => {
    test('returns no errors for valid rights', () => {
      // Arrange
      const rights: ObjectRights = {
        ...createEmptyObjectRights(),
        read: true,
        insert: true,
        update: true,
        delete: true
      };

      // Act
      const errors = validator.validateObjectRights('Catalog.Products', rights);

      // Assert
      assert.strictEqual(errors.length, 0);
    });

    test('returns error when Update without Read', () => {
      // Arrange
      const rights: ObjectRights = {
        ...createEmptyObjectRights(),
        update: true,
        read: false
      };

      // Act
      const errors = validator.validateObjectRights('Catalog.Products', rights);

      // Assert
      assert.strictEqual(errors.length, 1);
      assert.ok(errors[0].includes('Catalog.Products'));
      assert.ok(errors[0].includes('Update'));
      assert.ok(errors[0].includes('Read'));
    });

    test('returns error when Delete without Read', () => {
      // Arrange
      const rights: ObjectRights = {
        ...createEmptyObjectRights(),
        delete: true,
        read: false
      };

      // Act
      const errors = validator.validateObjectRights('Document.Invoice', rights);

      // Assert
      assert.strictEqual(errors.length, 1);
      assert.ok(errors[0].includes('Document.Invoice'));
      assert.ok(errors[0].includes('Delete'));
      assert.ok(errors[0].includes('Read'));
    });

    test('returns multiple errors for multiple violations', () => {
      // Arrange
      const rights: ObjectRights = {
        ...createEmptyObjectRights(),
        update: true,
        delete: true,
        read: false
      };

      // Act
      const errors = validator.validateObjectRights('Catalog.Products', rights);

      // Assert
      assert.strictEqual(errors.length, 2);
      assert.ok(errors.some(e => e.includes('Update')));
      assert.ok(errors.some(e => e.includes('Delete')));
    });
  });

  suite('checkDependencies', () => {
    test('returns no errors when Update with Read', () => {
      // Arrange
      const rights: ObjectRights = {
        ...createEmptyObjectRights(),
        read: true,
        update: true
      };

      // Act
      const errors = validator.checkDependencies('Catalog.Products', rights);

      // Assert
      assert.strictEqual(errors.length, 0);
    });

    test('returns error when Update without Read', () => {
      // Arrange
      const rights: ObjectRights = {
        ...createEmptyObjectRights(),
        update: true,
        read: false
      };

      // Act
      const errors = validator.checkDependencies('Catalog.Products', rights);

      // Assert
      assert.strictEqual(errors.length, 1);
      assert.ok(errors[0].includes('Update'));
      assert.ok(errors[0].includes('Read'));
    });

    test('returns error when Delete without Read', () => {
      // Arrange
      const rights: ObjectRights = {
        ...createEmptyObjectRights(),
        delete: true,
        read: false
      };

      // Act
      const errors = validator.checkDependencies('Document.Order', rights);

      // Assert
      assert.strictEqual(errors.length, 1);
      assert.ok(errors[0].includes('Delete'));
      assert.ok(errors[0].includes('Read'));
    });

    test('returns multiple errors when both Update and Delete without Read', () => {
      // Arrange
      const rights: ObjectRights = {
        ...createEmptyObjectRights(),
        update: true,
        delete: true,
        read: false
      };

      // Act
      const errors = validator.checkDependencies('Catalog.Items', rights);

      // Assert
      assert.strictEqual(errors.length, 2);
      assert.ok(errors.some(e => e.includes('Update')));
      assert.ok(errors.some(e => e.includes('Delete')));
    });

    test('returns no errors when only Read is enabled', () => {
      // Arrange
      const rights: ObjectRights = {
        ...createEmptyObjectRights(),
        read: true
      };

      // Act
      const errors = validator.checkDependencies('Catalog.Products', rights);

      // Assert
      assert.strictEqual(errors.length, 0);
    });
  });

  suite('validateRightCombination', () => {
    test('returns no errors when interactive right has base right', () => {
      // Arrange
      const rights: ObjectRights = {
        ...createEmptyObjectRights(),
        insert: true,
        interactiveInsert: true
      };

      // Act
      const errors = validator.validateRightCombination('Document.Order', rights);

      // Assert
      assert.strictEqual(errors.length, 0);
    });

    test('returns error when interactiveInsert without insert', () => {
      // Arrange
      const rights: ObjectRights = {
        ...createEmptyObjectRights(),
        interactiveInsert: true,
        insert: false
      };

      // Act
      const errors = validator.validateRightCombination('Document.Order', rights);

      // Assert
      assert.strictEqual(errors.length, 1);
      assert.ok(errors[0].includes('Interactive Insert'));
      assert.ok(errors[0].includes('Insert'));
    });

    test('returns error when interactiveDelete without delete', () => {
      // Arrange
      const rights: ObjectRights = {
        ...createEmptyObjectRights(),
        interactiveDelete: true,
        delete: false
      };

      // Act
      const errors = validator.validateRightCombination('Document.Order', rights);

      // Assert
      assert.strictEqual(errors.length, 1);
      assert.ok(errors[0].includes('Interactive Delete'));
      assert.ok(errors[0].includes('Delete'));
    });

    test('returns error when interactiveSetDeletionMark without delete', () => {
      // Arrange
      const rights: ObjectRights = {
        ...createEmptyObjectRights(),
        interactiveSetDeletionMark: true,
        delete: false
      };

      // Act
      const errors = validator.validateRightCombination('Document.Order', rights);

      // Assert
      assert.strictEqual(errors.length, 1);
      assert.ok(errors[0].includes('Interactive Set Deletion Mark'));
      assert.ok(errors[0].includes('Delete'));
    });

    test('returns multiple errors for multiple interactive rights without base rights', () => {
      // Arrange
      const rights: ObjectRights = {
        ...createEmptyObjectRights(),
        interactiveInsert: true,
        interactiveDelete: true,
        interactiveSetDeletionMark: true,
        insert: false,
        delete: false
      };

      // Act
      const errors = validator.validateRightCombination('Document.Order', rights);

      // Assert
      assert.strictEqual(errors.length, 3);
      assert.ok(errors.some(e => e.includes('Interactive Insert')));
      assert.ok(errors.some(e => e.includes('Interactive Delete')));
      assert.ok(errors.some(e => e.includes('Interactive Set Deletion Mark')));
    });

    test('returns no errors when all interactive rights have base rights', () => {
      // Arrange
      const rights: ObjectRights = {
        ...createEmptyObjectRights(),
        insert: true,
        delete: true,
        interactiveInsert: true,
        interactiveDelete: true,
        interactiveClear: true,
        interactiveSetDeletionMark: true
      };

      // Act
      const errors = validator.validateRightCombination('Document.Order', rights);

      // Assert
      assert.strictEqual(errors.length, 0);
    });

    test('validates all delete-related interactive rights', () => {
      // Arrange - all delete-related interactive rights without delete base right
      const rights: ObjectRights = {
        ...createEmptyObjectRights(),
        interactiveDelete: true,
        interactiveClear: true,
        interactiveDeleteMarked: true,
        interactiveUndeleteMarked: true,
        interactiveDeletePredefinedData: true,
        interactiveSetDeletionMark: true,
        interactiveClearDeletionMark: true,
        interactiveDeleteMarkedPredefinedData: true,
        delete: false
      };

      // Act
      const errors = validator.validateRightCombination('Document.Order', rights);

      // Assert
      assert.strictEqual(errors.length, 8); // All 8 interactive rights should fail
      assert.ok(errors.every(e => e.includes('Delete')));
    });
  });

  suite('Integration tests', () => {
    test('validates complex role with multiple objects and rights', () => {
      // Arrange
      const rights: RightsMap = {
        'Catalog.Products': {
          ...createEmptyObjectRights(),
          read: true,
          insert: true,
          update: true,
          delete: true,
          interactiveInsert: true,
          interactiveDelete: true
        },
        'Document.SalesOrder': {
          ...createEmptyObjectRights(),
          read: true,
          insert: true,
          interactiveInsert: true
        },
        'InformationRegister.Prices': {
          ...createEmptyObjectRights(),
          read: true,
          update: true
        }
      };

      const roleModel: RoleModel = {
        name: 'ComplexRole',
        filePath: '/test/ComplexRole/Role.xml',
        rights,
        metadata: {
          format: ConfigFormat.Designer,
          version: '1.0',
          lastModified: new Date()
        }
      };

      // Act
      const result = validator.validateRights(roleModel);

      // Assert
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    test('detects mixed valid and invalid rights across objects', () => {
      // Arrange
      const rights: RightsMap = {
        'Catalog.Products': {
          ...createEmptyObjectRights(),
          read: true,
          update: true // Valid: has Read
        },
        'Document.Order': {
          ...createEmptyObjectRights(),
          update: true,
          read: false // Invalid: Update without Read
        },
        'Catalog.Items': {
          ...createEmptyObjectRights(),
          read: true,
          delete: true,
          interactiveDelete: true // Valid: has Read and Delete
        },
        'Document.Invoice': {
          ...createEmptyObjectRights(),
          interactiveInsert: true,
          insert: false // Invalid: Interactive without base
        }
      };

      const roleModel: RoleModel = {
        name: 'MixedRole',
        filePath: '/test/MixedRole/Role.xml',
        rights,
        metadata: {
          format: ConfigFormat.Designer,
          version: '1.0',
          lastModified: new Date()
        }
      };

      // Act
      const result = validator.validateRights(roleModel);

      // Assert
      assert.strictEqual(result.isValid, false);
      assert.strictEqual(result.errors.length, 2);
      assert.ok(result.errors.some(e => e.includes('Document.Order')));
      assert.ok(result.errors.some(e => e.includes('Document.Invoice')));
    });
  });
});
