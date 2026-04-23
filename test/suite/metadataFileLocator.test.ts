import * as assert from 'assert';
import * as path from 'path';
import { locateMetadataFile, MetadataLocation } from '../../src/services/metadataFileLocator';

// Normalise to native separators — the locator accepts any absolute path.
function p(configRoot: string, ...segments: string[]): string {
  return path.join(configRoot, ...segments);
}

suite('metadataFileLocator', () => {
  const root = path.normalize('C:/conf/main');
  const roots = [root] as const;

  // -------------------------------------------------------------------------
  // 1. CommonModule BSL
  // -------------------------------------------------------------------------
  test('CommonModule BSL → commonModule subPath', () => {
    const result = locateMetadataFile(p(root, 'CommonModules/Общий/Ext/Module.bsl'), roots);
    assert.ok(result, 'expected non-null result');
    assert.strictEqual(result.objectType, 'CommonModules');
    assert.strictEqual(result.objectName, 'Общий');
    assert.deepStrictEqual(result.subPath, { kind: 'commonModule' });
  });

  // -------------------------------------------------------------------------
  // 2a. ObjectModule
  // -------------------------------------------------------------------------
  test('ObjectModule BSL', () => {
    const result = locateMetadataFile(p(root, 'Catalogs/Товары/Ext/ObjectModule.bsl'), roots);
    assert.ok(result);
    assert.strictEqual(result.objectType, 'Catalogs');
    assert.strictEqual(result.objectName, 'Товары');
    assert.deepStrictEqual(result.subPath, { kind: 'objectModule' });
  });

  // -------------------------------------------------------------------------
  // 2b. ManagerModule
  // -------------------------------------------------------------------------
  test('ManagerModule BSL', () => {
    const result = locateMetadataFile(p(root, 'Catalogs/Товары/Ext/ManagerModule.bsl'), roots);
    assert.ok(result);
    assert.deepStrictEqual(result.subPath, { kind: 'managerModule' });
  });

  // -------------------------------------------------------------------------
  // 2c. RecordSetModule
  // -------------------------------------------------------------------------
  test('RecordSetModule BSL (registers)', () => {
    const result = locateMetadataFile(
      p(root, 'InformationRegisters/ЦеныНоменклатуры/Ext/RecordSetModule.bsl'),
      roots
    );
    assert.ok(result);
    assert.strictEqual(result.objectType, 'InformationRegisters');
    assert.strictEqual(result.objectName, 'ЦеныНоменклатуры');
    assert.deepStrictEqual(result.subPath, { kind: 'recordSetModule' });
  });

  // -------------------------------------------------------------------------
  // 2d. ValueManagerModule
  // -------------------------------------------------------------------------
  test('ValueManagerModule BSL (Constants)', () => {
    const result = locateMetadataFile(
      p(root, 'Constants/МаксимальнаяСкидка/Ext/ValueManagerModule.bsl'),
      roots
    );
    assert.ok(result);
    assert.strictEqual(result.objectType, 'Constants');
    assert.strictEqual(result.objectName, 'МаксимальнаяСкидка');
    assert.deepStrictEqual(result.subPath, { kind: 'valueManagerModule' });
  });

  // -------------------------------------------------------------------------
  // 3. Flat catalog XML (Catalogs/Товары.xml)
  // -------------------------------------------------------------------------
  test('flat object XML returns no subPath', () => {
    const result = locateMetadataFile(p(root, 'Catalogs/Товары.xml'), roots);
    assert.ok(result);
    assert.strictEqual(result.objectType, 'Catalogs');
    assert.strictEqual(result.objectName, 'Товары');
    assert.strictEqual(result.subPath, undefined);
  });

  // -------------------------------------------------------------------------
  // 4a. Form: flat Forms/Y.xml
  // -------------------------------------------------------------------------
  test('form flat XML (Forms/Y.xml)', () => {
    const result = locateMetadataFile(
      p(root, 'Catalogs/Товары/Forms/ФормаЭлемента.xml'),
      roots
    );
    assert.ok(result);
    assert.strictEqual(result.objectName, 'Товары');
    assert.deepStrictEqual(result.subPath, {
      kind: 'form',
      name: 'ФормаЭлемента',
      subFile: 'xml',
    });
  });

  // -------------------------------------------------------------------------
  // 4b. Form: container node (Forms/Y/Ext/Form.xml)
  // -------------------------------------------------------------------------
  test('form container (Forms/Y/Ext/Form.xml)', () => {
    const result = locateMetadataFile(
      p(root, 'Catalogs/Товары/Forms/ФормаЭлемента/Ext/Form.xml'),
      roots
    );
    assert.ok(result);
    assert.deepStrictEqual(result.subPath, {
      kind: 'form',
      name: 'ФормаЭлемента',
      subFile: 'container',
    });
  });

  // -------------------------------------------------------------------------
  // 4c. Form: module (Forms/Y/Ext/Form/Module.bsl)
  // -------------------------------------------------------------------------
  test('form module (Forms/Y/Ext/Form/Module.bsl)', () => {
    const result = locateMetadataFile(
      p(root, 'Catalogs/Товары/Forms/ФормаЭлемента/Ext/Form/Module.bsl'),
      roots
    );
    assert.ok(result);
    assert.deepStrictEqual(result.subPath, {
      kind: 'form',
      name: 'ФормаЭлемента',
      subFile: 'module',
    });
  });

  // -------------------------------------------------------------------------
  // 5a. Command: flat Commands/Z.xml
  // -------------------------------------------------------------------------
  test('command flat XML (Commands/Z.xml)', () => {
    const result = locateMetadataFile(
      p(root, 'Catalogs/Товары/Commands/СоздатьНаОснове.xml'),
      roots
    );
    assert.ok(result);
    assert.deepStrictEqual(result.subPath, {
      kind: 'command',
      name: 'СоздатьНаОснове',
      subFile: 'xml',
    });
  });

  // -------------------------------------------------------------------------
  // 5b. Command: module (Commands/Z/Ext/CommandModule.bsl)
  // -------------------------------------------------------------------------
  test('command module (Commands/Z/Ext/CommandModule.bsl)', () => {
    const result = locateMetadataFile(
      p(root, 'Catalogs/Товары/Commands/СоздатьНаОснове/Ext/CommandModule.bsl'),
      roots
    );
    assert.ok(result);
    assert.deepStrictEqual(result.subPath, {
      kind: 'command',
      name: 'СоздатьНаОснове',
      subFile: 'module',
    });
  });

  // -------------------------------------------------------------------------
  // 6. Template
  // -------------------------------------------------------------------------
  test('template XML', () => {
    const result = locateMetadataFile(
      p(root, 'Catalogs/Товары/Templates/ШаблонПечати.xml'),
      roots
    );
    assert.ok(result);
    assert.deepStrictEqual(result.subPath, { kind: 'template', name: 'ШаблонПечати' });
  });

  // -------------------------------------------------------------------------
  // 7. Role XML
  // -------------------------------------------------------------------------
  test('role object XML (Roles/R.xml)', () => {
    const result = locateMetadataFile(p(root, 'Roles/Администратор.xml'), roots);
    assert.ok(result);
    assert.strictEqual(result.objectType, 'Roles');
    assert.strictEqual(result.objectName, 'Администратор');
    assert.strictEqual(result.subPath, undefined);
  });

  // -------------------------------------------------------------------------
  // 8. Role Rights.xml
  // -------------------------------------------------------------------------
  test('role Rights.xml → rights subPath', () => {
    const result = locateMetadataFile(
      p(root, 'Roles/Администратор/Ext/Rights.xml'),
      roots
    );
    assert.ok(result);
    assert.strictEqual(result.objectType, 'Roles');
    assert.strictEqual(result.objectName, 'Администратор');
    assert.deepStrictEqual(result.subPath, { kind: 'rights' });
  });

  // -------------------------------------------------------------------------
  // 9. XDTOPackage flat
  // -------------------------------------------------------------------------
  test('XDTOPackage flat XML', () => {
    const result = locateMetadataFile(p(root, 'XDTOPackages/МойПакет.xml'), roots);
    assert.ok(result);
    assert.strictEqual(result.objectType, 'XDTOPackages');
    assert.strictEqual(result.objectName, 'МойПакет');
    assert.strictEqual(result.subPath, undefined);
  });

  // -------------------------------------------------------------------------
  // 10. Subsystem 1 level
  // -------------------------------------------------------------------------
  test('subsystem 1 level (Subsystems/A.xml)', () => {
    const result = locateMetadataFile(p(root, 'Subsystems/Продажи.xml'), roots);
    assert.ok(result);
    assert.strictEqual(result.objectType, 'Subsystems');
    assert.strictEqual(result.objectName, 'Продажи');
    assert.deepStrictEqual(result.hierarchy, ['Продажи']);
  });

  // -------------------------------------------------------------------------
  // 11. Subsystem 2 levels
  // -------------------------------------------------------------------------
  test('subsystem 2 levels (Subsystems/A/Subsystems/B.xml)', () => {
    const result = locateMetadataFile(
      p(root, 'Subsystems/Продажи/Subsystems/Заказы.xml'),
      roots
    );
    assert.ok(result);
    assert.strictEqual(result.objectName, 'Продажи');
    assert.deepStrictEqual(result.hierarchy, ['Продажи', 'Заказы']);
  });

  // -------------------------------------------------------------------------
  // 12. Subsystem 3 levels
  // -------------------------------------------------------------------------
  test('subsystem 3 levels', () => {
    const result = locateMetadataFile(
      p(root, 'Subsystems/Продажи/Subsystems/Заказы/Subsystems/Черновики.xml'),
      roots
    );
    assert.ok(result);
    assert.deepStrictEqual(result.hierarchy, ['Продажи', 'Заказы', 'Черновики']);
  });

  // -------------------------------------------------------------------------
  // 13. Extension path
  // -------------------------------------------------------------------------
  test('extension path sets extensionName', () => {
    const result = locateMetadataFile(
      p(root, 'ConfigurationExtensions/Базовое/Catalogs/Товары/Ext/ObjectModule.bsl'),
      roots
    );
    assert.ok(result);
    assert.strictEqual(result.extensionName, 'Базовое');
    assert.strictEqual(result.objectType, 'Catalogs');
    assert.strictEqual(result.objectName, 'Товары');
    assert.deepStrictEqual(result.subPath, { kind: 'objectModule' });
  });

  // -------------------------------------------------------------------------
  // 14. Path outside configRoot → null
  // -------------------------------------------------------------------------
  test('path outside configRoot returns null', () => {
    const result = locateMetadataFile('/totally/random/path.bsl', roots);
    assert.strictEqual(result, null);
  });

  // -------------------------------------------------------------------------
  // 15. Unsupported type → null
  // -------------------------------------------------------------------------
  test('unsupported type folder returns null', () => {
    const result = locateMetadataFile(p(root, 'SomeUnknownFolder/Object.xml'), roots);
    assert.strictEqual(result, null);
  });

  // -------------------------------------------------------------------------
  // 16. Multi-root: longest prefix wins
  // -------------------------------------------------------------------------
  test('multi-root: longer configRoot prefix is preferred', () => {
    const shortRoot = path.normalize('C:/conf');
    const longRoot = path.normalize('C:/conf/main');
    const multiRoots = [shortRoot, longRoot] as const;

    const filePath = p(longRoot, 'Catalogs/Товары.xml');
    const result = locateMetadataFile(filePath, multiRoots);
    assert.ok(result);
    assert.strictEqual(result.configRoot, longRoot, 'should pick the longer (more specific) root');
    assert.strictEqual(result.objectName, 'Товары');
  });

  // -------------------------------------------------------------------------
  // 17. PredefinedData.xml
  // -------------------------------------------------------------------------
  test('PredefinedData.xml subPath', () => {
    const result = locateMetadataFile(
      p(root, 'Catalogs/Товары/Ext/PredefinedData.xml'),
      roots
    );
    assert.ok(result);
    assert.strictEqual(result.objectName, 'Товары');
    assert.deepStrictEqual(result.subPath, { kind: 'predefinedData' });
  });

  // -------------------------------------------------------------------------
  // 18. Windows mixed separators (Windows-only: path.normalize on Linux does not convert backslashes)
  // -------------------------------------------------------------------------
  (process.platform === 'win32' ? test : test.skip)(
    'Windows mixed separators are normalised correctly',
    () => {
      // Simulate a path with backslashes (Windows-style)
      const winPath =
        root.replace(/\//g, '\\') + '\\Catalogs\\Товары\\Forms\\ФормаЭлемента\\Ext\\Form.xml';
      const result = locateMetadataFile(winPath, roots);
      assert.ok(result, 'should handle backslash paths');
      assert.deepStrictEqual(result.subPath, {
        kind: 'form',
        name: 'ФормаЭлемента',
        subFile: 'container',
      });
    }
  );

  // -------------------------------------------------------------------------
  // Additional: configRoot field is set correctly
  // -------------------------------------------------------------------------
  test('configRoot is populated in result', () => {
    const result = locateMetadataFile(p(root, 'Roles/Менеджер.xml'), roots);
    assert.ok(result);
    assert.strictEqual(result.configRoot, root);
  });

  // -------------------------------------------------------------------------
  // Additional: CommonModule flat XML (no subPath)
  // -------------------------------------------------------------------------
  test('CommonModule flat XML has no subPath', () => {
    const result = locateMetadataFile(p(root, 'CommonModules/Общий.xml'), roots);
    assert.ok(result);
    assert.strictEqual(result.objectType, 'CommonModules');
    assert.strictEqual(result.objectName, 'Общий');
    assert.strictEqual(result.subPath, undefined);
  });

  // -------------------------------------------------------------------------
  // Additional: extensionName is absent for main config path
  // -------------------------------------------------------------------------
  test('main config path has no extensionName', () => {
    const result = locateMetadataFile(p(root, 'Catalogs/Товары.xml'), roots);
    assert.ok(result);
    assert.strictEqual(result.extensionName, undefined);
  });
});
