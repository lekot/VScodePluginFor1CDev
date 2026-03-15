/**
 * Unit tests for filterUtils
 */

import * as assert from 'assert';
import { applyFilter } from '../../src/rolesEditor/filterUtils';
import { MetadataObject } from '../../src/rolesEditor/models/metadataObject';
import { FilterState } from '../../src/rolesEditor/models/filterState';
import { RoleModel, RightsMap, ConfigFormat, createEmptyObjectRights } from '../../src/rolesEditor/models/roleModel';
import { MetadataType } from '../../src/models/treeNode';

suite('FilterUtils Tests', () => {
  let allObjects: MetadataObject[];
  let roleModel: RoleModel;

  setup(() => {
    // Create test metadata objects
    allObjects = [
      {
        fullName: 'Catalog.Products',
        type: MetadataType.Catalog,
        name: 'Products',
        displayName: 'Товары',
        hasRights: true
      },
      {
        fullName: 'Catalog.Customers',
        type: MetadataType.Catalog,
        name: 'Customers',
        displayName: 'Клиенты',
        hasRights: false
      },
      {
        fullName: 'Document.SalesOrder',
        type: MetadataType.Document,
        name: 'SalesOrder',
        displayName: 'Заказ покупателя',
        hasRights: true
      },
      {
        fullName: 'Document.Invoice',
        type: MetadataType.Document,
        name: 'Invoice',
        displayName: 'Счет',
        hasRights: false
      },
      {
        fullName: 'InformationRegister.Prices',
        type: MetadataType.InformationRegister,
        name: 'Prices',
        displayName: 'Цены',
        hasRights: false
      }
    ];

    // Create test role model with rights for some objects
    const rights: RightsMap = {
      'Catalog.Products': {
        ...createEmptyObjectRights(),
        read: true,
        insert: true
      },
      'Document.SalesOrder': {
        ...createEmptyObjectRights(),
        read: true,
        update: true
      }
    };

    roleModel = {
      name: 'TestRole',
      filePath: '/test/TestRole/Role.xml',
      rights,
      metadata: {
        format: ConfigFormat.Designer,
        version: '1.0',
        lastModified: new Date()
      }
    };
  });

  suite('applyFilter', () => {
    test('returns empty array for empty input', () => {
      // Arrange
      const filterState: FilterState = {
        showAll: false,
        searchQuery: '',
        typeFilter: []
      };

      // Act
      const result = applyFilter([], roleModel, filterState);

      // Assert
      assert.strictEqual(result.length, 0);
    });

    test('shows only objects with rights by default (showAll=false)', () => {
      // Arrange
      const filterState: FilterState = {
        showAll: false,
        searchQuery: '',
        typeFilter: []
      };

      // Act
      const result = applyFilter(allObjects, roleModel, filterState);

      // Assert
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].fullName, 'Catalog.Products');
      assert.strictEqual(result[1].fullName, 'Document.SalesOrder');
    });

    test('shows all objects when showAll=true', () => {
      // Arrange
      const filterState: FilterState = {
        showAll: true,
        searchQuery: '',
        typeFilter: []
      };

      // Act
      const result = applyFilter(allObjects, roleModel, filterState);

      // Assert
      assert.strictEqual(result.length, 5);
    });

    test('filters by search query (case-insensitive, matches name)', () => {
      // Arrange
      const filterState: FilterState = {
        showAll: true,
        searchQuery: 'prod',
        typeFilter: []
      };

      // Act
      const result = applyFilter(allObjects, roleModel, filterState);

      // Assert
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].fullName, 'Catalog.Products');
    });

    test('filters by search query (case-insensitive, matches displayName)', () => {
      // Arrange
      const filterState: FilterState = {
        showAll: true,
        searchQuery: 'товары',
        typeFilter: []
      };

      // Act
      const result = applyFilter(allObjects, roleModel, filterState);

      // Assert
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].fullName, 'Catalog.Products');
    });

    test('filters by search query with uppercase', () => {
      // Arrange
      const filterState: FilterState = {
        showAll: true,
        searchQuery: 'SALES',
        typeFilter: []
      };

      // Act
      const result = applyFilter(allObjects, roleModel, filterState);

      // Assert
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].fullName, 'Document.SalesOrder');
    });

    test('filters by metadata type', () => {
      // Arrange
      const filterState: FilterState = {
        showAll: true,
        searchQuery: '',
        typeFilter: [MetadataType.Catalog]
      };

      // Act
      const result = applyFilter(allObjects, roleModel, filterState);

      // Assert
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].type, MetadataType.Catalog);
      assert.strictEqual(result[1].type, MetadataType.Catalog);
    });

    test('filters by multiple metadata types', () => {
      // Arrange
      const filterState: FilterState = {
        showAll: true,
        searchQuery: '',
        typeFilter: [MetadataType.Catalog, MetadataType.Document]
      };

      // Act
      const result = applyFilter(allObjects, roleModel, filterState);

      // Assert
      assert.strictEqual(result.length, 4);
    });

    test('combines showAll and search query filters', () => {
      // Arrange
      const filterState: FilterState = {
        showAll: false,
        searchQuery: 'prod',
        typeFilter: []
      };

      // Act
      const result = applyFilter(allObjects, roleModel, filterState);

      // Assert
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].fullName, 'Catalog.Products');
    });

    test('combines showAll and type filter', () => {
      // Arrange
      const filterState: FilterState = {
        showAll: false,
        searchQuery: '',
        typeFilter: [MetadataType.Document]
      };

      // Act
      const result = applyFilter(allObjects, roleModel, filterState);

      // Assert
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].fullName, 'Document.SalesOrder');
    });

    test('combines all three filters', () => {
      // Arrange
      const filterState: FilterState = {
        showAll: true,
        searchQuery: 'order',
        typeFilter: [MetadataType.Document]
      };

      // Act
      const result = applyFilter(allObjects, roleModel, filterState);

      // Assert
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].fullName, 'Document.SalesOrder');
    });

    test('returns empty array when no objects match filters', () => {
      // Arrange
      const filterState: FilterState = {
        showAll: true,
        searchQuery: 'nonexistent',
        typeFilter: []
      };

      // Act
      const result = applyFilter(allObjects, roleModel, filterState);

      // Assert
      assert.strictEqual(result.length, 0);
    });

    test('does not modify original allObjects array', () => {
      // Arrange
      const originalLength = allObjects.length;
      const filterState: FilterState = {
        showAll: false,
        searchQuery: '',
        typeFilter: []
      };

      // Act
      applyFilter(allObjects, roleModel, filterState);

      // Assert
      assert.strictEqual(allObjects.length, originalLength);
    });

    test('maintains original object order', () => {
      // Arrange
      const filterState: FilterState = {
        showAll: true,
        searchQuery: '',
        typeFilter: []
      };

      // Act
      const result = applyFilter(allObjects, roleModel, filterState);

      // Assert
      assert.strictEqual(result[0].fullName, 'Catalog.Products');
      assert.strictEqual(result[1].fullName, 'Catalog.Customers');
      assert.strictEqual(result[2].fullName, 'Document.SalesOrder');
      assert.strictEqual(result[3].fullName, 'Document.Invoice');
      assert.strictEqual(result[4].fullName, 'InformationRegister.Prices');
    });

    test('handles empty search query as no filter', () => {
      // Arrange
      const filterState: FilterState = {
        showAll: true,
        searchQuery: '',
        typeFilter: []
      };

      // Act
      const result = applyFilter(allObjects, roleModel, filterState);

      // Assert
      assert.strictEqual(result.length, 5);
    });

    test('handles empty type filter as no filter', () => {
      // Arrange
      const filterState: FilterState = {
        showAll: true,
        searchQuery: '',
        typeFilter: []
      };

      // Act
      const result = applyFilter(allObjects, roleModel, filterState);

      // Assert
      assert.strictEqual(result.length, 5);
    });
  });
});
