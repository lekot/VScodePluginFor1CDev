import * as assert from 'assert';
import * as fs from 'fs';
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

  test('CalculationRegister ManagerModule BSL', () => {
    const result = locateMetadataFile(
      p(root, 'CalculationRegisters/Payroll/Ext/ManagerModule.bsl'),
      roots
    );
    assert.ok(result);
    assert.strictEqual(result.objectType, 'CalculationRegisters');
    assert.strictEqual(result.objectName, 'Payroll');
    assert.deepStrictEqual(result.subPath, { kind: 'managerModule' });
  });

  test('CalculationRegister RecordSetModule BSL reveal descriptor', () => {
    const result = locateMetadataFile(
      p(root, 'CalculationRegisters/Payroll/Ext/RecordSetModule.bsl'),
      roots
    );
    assert.ok(result);
    assert.strictEqual(result.objectType, 'CalculationRegisters');
    assert.strictEqual(result.objectName, 'Payroll');
    assert.deepStrictEqual(result.subPath, { kind: 'recordSetModule' });
  });

  test('Sequence XML and modules are located as a hierarchical metadata object', () => {
    const xml = locateMetadataFile(p(root, 'Sequences/PostingOrder.xml'), roots);
    const manager = locateMetadataFile(p(root, 'Sequences/PostingOrder/Ext/ManagerModule.bsl'), roots);
    const recordSet = locateMetadataFile(p(root, 'Sequences/PostingOrder/Ext/RecordSetModule.bsl'), roots);

    assert.strictEqual(xml?.objectName, 'PostingOrder');
    assert.deepStrictEqual(manager?.subPath, { kind: 'managerModule' });
    assert.deepStrictEqual(recordSet?.subPath, { kind: 'recordSetModule' });
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

  test('common form module (CommonForms/Y/Ext/Form/Module.bsl)', () => {
    const result = locateMetadataFile(
      p(root, 'CommonForms/CustomerPicker/Ext/Form/Module.bsl'),
      roots
    );
    assert.ok(result);
    assert.strictEqual(result.objectType, 'CommonForms');
    assert.strictEqual(result.objectName, 'CustomerPicker');
    assert.deepStrictEqual(result.subPath, {
      kind: 'form',
      name: 'CustomerPicker',
      subFile: 'module',
    });
  });

  test('common form container (CommonForms/Y/Ext/Form.xml)', () => {
    const result = locateMetadataFile(
      p(root, 'CommonForms/CustomerPicker/Ext/Form.xml'),
      roots
    );
    assert.ok(result);
    assert.strictEqual(result.objectType, 'CommonForms');
    assert.strictEqual(result.objectName, 'CustomerPicker');
    assert.deepStrictEqual(result.subPath, {
      kind: 'form',
      name: 'CustomerPicker',
      subFile: 'container',
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

  test('common command module (CommonCommands/Z/Ext/CommandModule.bsl)', () => {
    const result = locateMetadataFile(
      p(root, 'CommonCommands/OpenDashboard/Ext/CommandModule.bsl'),
      roots
    );
    assert.ok(result);
    assert.strictEqual(result.objectType, 'CommonCommands');
    assert.strictEqual(result.objectName, 'OpenDashboard');
    assert.deepStrictEqual(result.subPath, {
      kind: 'command',
      name: 'OpenDashboard',
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

  test('extension path keeps extensionName when extension root is also configured', () => {
    const extensionRoot = p(root, 'ConfigurationExtensions', 'SalesPatch');
    const result = locateMetadataFile(
      p(extensionRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl'),
      [root, extensionRoot]
    );

    assert.ok(result);
    assert.strictEqual(result.configRoot, extensionRoot);
    assert.strictEqual(result.extensionName, 'SalesPatch');
    assert.strictEqual(result.objectType, 'Catalogs');
    assert.strictEqual(result.objectName, 'Products');
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

  test('Windows: locates metadata file across 8.3 short-name aliases (#328)', function () {
    if (process.platform !== 'win32' || !process.env.TEMP) {
      this.skip();
      return;
    }
    const shortTemp = process.env.TEMP;
    let longTemp: string;
    try {
      longTemp = fs.realpathSync.native(shortTemp);
    } catch {
      this.skip();
      return;
    }
    if (shortTemp.toLowerCase() === longTemp.toLowerCase()) {
      this.skip();
      return;
    }

    const shortRoot = path.join(shortTemp, 'test-config-328');
    const longRoot = path.join(longTemp, 'test-config-328');

    // 1. CommonModule: roots have long path, filePath has short path
    const shortCommonModule = path.join(shortRoot, 'CommonModules', 'FlatOnlyModule.xml');
    const result1 = locateMetadataFile(shortCommonModule, [longRoot]);
    assert.ok(result1, 'expected non-null result for short filePath with long configRoot');
    assert.strictEqual(result1?.objectType, 'CommonModules');
    assert.strictEqual(result1?.objectName, 'FlatOnlyModule');

    // 2. CommonModule: roots have short path, filePath has long path
    const longCommonModule = path.join(longRoot, 'CommonModules', 'FlatOnlyModule.xml');
    const result2 = locateMetadataFile(longCommonModule, [shortRoot]);
    assert.ok(result2, 'expected non-null result for long filePath with short configRoot');
    assert.strictEqual(result2?.objectType, 'CommonModules');
    assert.strictEqual(result2?.objectName, 'FlatOnlyModule');

    // 3. Document Form: roots have long path, filePath has short path
    const shortForm = path.join(shortRoot, 'Documents', 'TestDoc', 'Forms', 'DocumentMainForm', 'Ext', 'Form.xml');
    const result3 = locateMetadataFile(shortForm, [longRoot]);
    assert.ok(result3, 'expected non-null result for short form filePath with long configRoot');
    assert.strictEqual(result3?.objectType, 'Documents');
    assert.strictEqual(result3?.objectName, 'TestDoc');
    assert.deepStrictEqual(result3?.subPath, { kind: 'form', name: 'DocumentMainForm', subFile: 'container' });

    // 4. Catalog: roots have long path, filePath has short path
    const shortCatalog = path.join(shortRoot, 'Catalogs', 'CatalogGoodsA.xml');
    const result4 = locateMetadataFile(shortCatalog, [longRoot]);
    assert.ok(result4, 'expected non-null result for short catalog filePath with long configRoot');
    assert.strictEqual(result4?.objectType, 'Catalogs');
    assert.strictEqual(result4?.objectName, 'CatalogGoodsA');
  });

  test('locates metadata file using canonical fallback when root alias resolves on filesystem', () => {
    const tempDir = fs.mkdtempSync(path.join(path.resolve('.'), 'tmp-locator-'));
    try {
      const realConfig = path.join(tempDir, 'real-config');
      const modulePath = path.join(realConfig, 'CommonModules', 'Helper.xml');
      fs.mkdirSync(path.dirname(modulePath), { recursive: true });
      fs.writeFileSync(modulePath, '<xml/>');

      const aliasConfig = path.join(tempDir, 'alias-config');
      let hasAlias = false;
      try {
        fs.symlinkSync(realConfig, aliasConfig, process.platform === 'win32' ? 'junction' : 'dir');
        hasAlias = true;
      } catch {
        // Platform or permission limitation
      }

      if (hasAlias) {
        const result = locateMetadataFile(modulePath, [aliasConfig]);
        assert.ok(result);
        assert.strictEqual(result.objectType, 'CommonModules');
        assert.strictEqual(result.objectName, 'Helper');
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('nested roots: selects innermost root when parent root has long alias and inner root has short path (#330 review)', () => {
    const tempDir = fs.mkdtempSync(path.join(path.resolve('.'), 'tmp-nested-'));
    try {
      const parent = path.join(tempDir, 'p');
      const inner = path.join(parent, 'inner');
      const catalogFile = path.join(inner, 'Catalogs', 'Goods.xml');
      fs.mkdirSync(path.dirname(catalogFile), { recursive: true });
      fs.writeFileSync(catalogFile, '<xml/>');

      const longAlias = path.join(tempDir, 'a-very-long-parent-root-alias-pointing-to-p');
      let hasAlias = false;
      try {
        fs.symlinkSync(parent, longAlias, process.platform === 'win32' ? 'junction' : 'dir');
        hasAlias = true;
      } catch {
        // Fallback
      }

      if (hasAlias) {
        // Test with [longAlias, inner] - longAlias is longer string but parent in hierarchy
        const result1 = locateMetadataFile(catalogFile, [longAlias, inner]);
        assert.ok(result1, 'expected non-null result when roots=[longAlias, inner]');
        assert.strictEqual(result1?.configRoot, inner, 'inner root must be selected over parent alias');
        assert.strictEqual(result1?.objectType, 'Catalogs');
        assert.strictEqual(result1?.objectName, 'Goods');

        // Test with reverse order [inner, longAlias]
        const result2 = locateMetadataFile(catalogFile, [inner, longAlias]);
        assert.ok(result2, 'expected non-null result when roots=[inner, longAlias]');
        assert.strictEqual(result2?.configRoot, inner, 'inner root must be selected regardless of root order');
        assert.strictEqual(result2?.objectType, 'Catalogs');
        assert.strictEqual(result2?.objectName, 'Goods');
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('nested roots: selects innermost extension root inside main root regardless of root order', () => {
    const tempDir = fs.mkdtempSync(path.join(path.resolve('.'), 'tmp-ext-nested-'));
    try {
      const mainRoot = path.join(tempDir, 'MainVeryLongConfigurationPathName');
      const extRoot = path.join(mainRoot, 'sub', 'ext');
      const extCatalog = path.join(extRoot, 'Catalogs', 'ExtGoods.xml');
      fs.mkdirSync(path.dirname(extCatalog), { recursive: true });
      fs.writeFileSync(extCatalog, '<xml/>');

      const result1 = locateMetadataFile(extCatalog, [mainRoot, extRoot]);
      assert.ok(result1);
      assert.strictEqual(result1?.configRoot, extRoot);
      assert.strictEqual(result1?.objectType, 'Catalogs');
      assert.strictEqual(result1?.objectName, 'ExtGoods');

      const result2 = locateMetadataFile(extCatalog, [extRoot, mainRoot]);
      assert.ok(result2);
      assert.strictEqual(result2?.configRoot, extRoot);
      assert.strictEqual(result2?.objectType, 'Catalogs');
      assert.strictEqual(result2?.objectName, 'ExtGoods');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
