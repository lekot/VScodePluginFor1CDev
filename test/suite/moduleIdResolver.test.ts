import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  resolveModuleId,
  resolveBslPathFromRdbgModule,
  readExtensionName,
  clearDumpMetadataCache,
  clearExtensionNameCache,
} from '../../src/debug/moduleIdResolver';

suite('moduleIdResolver', () => {
  const wsRoot = path.resolve(__dirname, '../../..', 'FormatSamples/empty_conf');

  suiteTeardown(() => {
    clearDumpMetadataCache();
    clearExtensionNameCache();
  });

  // ---------------------------------------------------------------------------
  // ObjectModule
  // ---------------------------------------------------------------------------
  test('ObjectModule resolves correct platform UUID', async () => {
    const bslPath = path.join(wsRoot, 'Catalogs/Справочник55/Ext/ObjectModule.bsl');
    const result = await resolveModuleId(bslPath, wsRoot);
    assert.ok(result, 'result should not be undefined');
    assert.strictEqual(result.moduleId.objectId, 'c39f6b2f-c005-4039-9d58-fe4565807e54');
    assert.strictEqual(result.moduleId.propertyId, 'a637f77f-3840-441d-a1c3-699c8c5cb7e0');
  });

  // ---------------------------------------------------------------------------
  // CommonModule
  // ---------------------------------------------------------------------------
  test('CommonModule resolves correct platform UUID', async () => {
    const bslPath = path.join(wsRoot, 'CommonModules/мойМодлуоьэ/Ext/Module.bsl');
    const result = await resolveModuleId(bslPath, wsRoot);
    assert.ok(result, 'result should not be undefined');
    assert.strictEqual(result.moduleId.objectId, '9ebb972e-f4d0-4a3d-a53f-ed005340852b');
    assert.strictEqual(result.moduleId.propertyId, 'd5963243-262e-4398-b4d7-fb16d06484f6');
  });

  // ---------------------------------------------------------------------------
  // ManagerModule
  // ---------------------------------------------------------------------------
  test('ManagerModule resolves correct platform UUID', async () => {
    const bslPath = path.join(wsRoot, 'Catalogs/Справочник55/Ext/ManagerModule.bsl');
    const result = await resolveModuleId(bslPath, wsRoot);
    assert.ok(result, 'result should not be undefined');
    assert.strictEqual(result.moduleId.objectId, 'c39f6b2f-c005-4039-9d58-fe4565807e54');
    assert.strictEqual(result.moduleId.propertyId, 'd1b64a2c-8078-4982-8190-8f81aefda192');
  });

  test('CalculationRegister ManagerModule resolves forward and reverse from a temporary fixture', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'module-id-calculation-register-'));
    const objectId = '55555555-5555-4555-8555-555555555555';
    const modulePath = path.join(
      root,
      'CalculationRegisters',
      'Payroll',
      'Ext',
      'ManagerModule.bsl'
    );

    try {
      await fs.mkdir(path.dirname(modulePath), { recursive: true });
      await fs.writeFile(
        path.join(root, 'CalculationRegisters', 'Payroll.xml'),
        `<MetaDataObject><CalculationRegister uuid="${objectId}" /></MetaDataObject>`,
        'utf-8'
      );
      await fs.writeFile(modulePath, '', 'utf-8');
      await fs.writeFile(
        path.join(root, 'ConfigDumpInfo.xml'),
        `<ConfigDumpInfo><ConfigVersions><Metadata name="CalculationRegister.Payroll" id="${objectId}"/><Metadata name="CalculationRegister.Payroll.ManagerModule" id="${objectId}.0"/></ConfigVersions></ConfigDumpInfo>`,
        'utf-8'
      );

      const result = await resolveModuleId(modulePath, root);

      assert.ok(result, 'result should not be undefined');
      assert.strictEqual(result.moduleId.objectId, objectId);
      assert.strictEqual(result.moduleId.propertyId, 'd1b64a2c-8078-4982-8190-8f81aefda192');

      const reversePath = await resolveBslPathFromRdbgModule(result.moduleId, root);
      assert.strictEqual(reversePath, modulePath);
    } finally {
      clearDumpMetadataCache();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('Sequence ManagerModule resolves forward and reverse from descriptor-derived maps', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'module-id-sequence-'));
    const objectId = '66666666-6666-4666-8666-666666666666';
    const modulePath = path.join(root, 'Sequences', 'PostingOrder', 'Ext', 'ManagerModule.bsl');

    try {
      await fs.mkdir(path.dirname(modulePath), { recursive: true });
      await fs.writeFile(
        path.join(root, 'Sequences', 'PostingOrder.xml'),
        `<MetaDataObject><Sequence uuid="${objectId}" /></MetaDataObject>`,
        'utf-8'
      );
      await fs.writeFile(modulePath, '', 'utf-8');
      await fs.writeFile(
        path.join(root, 'ConfigDumpInfo.xml'),
        `<ConfigDumpInfo><ConfigVersions><Metadata name="Sequence.PostingOrder" id="${objectId}"/><Metadata name="Sequence.PostingOrder.ManagerModule" id="${objectId}.0"/></ConfigVersions></ConfigDumpInfo>`,
        'utf-8'
      );

      const result = await resolveModuleId(modulePath, root);
      assert.ok(result);
      assert.strictEqual(result.moduleId.objectId, objectId);

      const reversePath = await resolveBslPathFromRdbgModule(result.moduleId, root);
      assert.strictEqual(reversePath, modulePath);
    } finally {
      clearDumpMetadataCache();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Unknown / unrecognised path → undefined
  // ---------------------------------------------------------------------------
  test('returns undefined for unknown path', async () => {
    const bslPath = path.join(wsRoot, 'SomeUnknownFolder/Object/Ext/Module.bsl');
    const result = await resolveModuleId(bslPath, wsRoot);
    assert.strictEqual(result, undefined);
  });

  test('returns undefined for path outside any type folder', async () => {
    const result = await resolveModuleId('/totally/random/path.bsl', wsRoot);
    assert.strictEqual(result, undefined);
  });

  // ---------------------------------------------------------------------------
  // Label format
  // ---------------------------------------------------------------------------
  test('ObjectModule label has correct format', async () => {
    const bslPath = path.join(wsRoot, 'Catalogs/Справочник55/Ext/ObjectModule.bsl');
    const result = await resolveModuleId(bslPath, wsRoot);
    assert.ok(result, 'result should not be undefined');
    // Expected: "Catalog.Справочник55.ObjectModule"
    // (crude singularisation strips trailing 's' from 'Catalogs')
    assert.strictEqual(result.label, 'Catalog.Справочник55.ObjectModule');
  });

  test('CommonModule label has correct format', async () => {
    const bslPath = path.join(wsRoot, 'CommonModules/мойМодлуоьэ/Ext/Module.bsl');
    const result = await resolveModuleId(bslPath, wsRoot);
    assert.ok(result, 'result should not be undefined');
    // Expected: "CommonModule.мойМодлуоьэ.CommonModule"
    // 'CommonModules' → 'CommonModule' (strips trailing 's')
    assert.strictEqual(result.label, 'CommonModule.мойМодлуоьэ.CommonModule');
  });

  // ---------------------------------------------------------------------------
  // Reverse: RDBG module id → BSL path (ConfigDumpInfo)
  // ---------------------------------------------------------------------------
  test('resolveBslPathFromRdbgModule: ObjectModule via catalog object UUID', async () => {
    const abs = await resolveBslPathFromRdbgModule(
      {
        objectId: 'c39f6b2f-c005-4039-9d58-fe4565807e54',
        propertyId: 'a637f77f-3840-441d-a1c3-699c8c5cb7e0',
      },
      wsRoot
    );
    assert.ok(abs, 'resolved path');
    assert.strictEqual(
      abs,
      path.join(wsRoot, 'Catalogs', 'Справочник55', 'Ext', 'ObjectModule.bsl')
    );
  });

  test('resolveBslPathFromRdbgModule: CommonModule by module UUID', async () => {
    const abs = await resolveBslPathFromRdbgModule(
      {
        objectId: '9ebb972e-f4d0-4a3d-a53f-ed005340852b',
        propertyId: 'd5963243-262e-4398-b4d7-fb16d06484f6',
      },
      wsRoot
    );
    assert.ok(abs, 'resolved path');
    assert.strictEqual(
      abs,
      path.join(wsRoot, 'CommonModules', 'мойМодлуоьэ', 'Ext', 'Module.bsl')
    );
  });

  test('resolveBslPathFromRdbgModule: ManagerModule same object UUID as ObjectModule', async () => {
    const abs = await resolveBslPathFromRdbgModule(
      {
        objectId: 'c39f6b2f-c005-4039-9d58-fe4565807e54',
        propertyId: 'd1b64a2c-8078-4982-8190-8f81aefda192',
      },
      wsRoot
    );
    assert.ok(abs, 'resolved path');
    assert.strictEqual(
      abs,
      path.join(wsRoot, 'Catalogs', 'Справочник55', 'Ext', 'ManagerModule.bsl')
    );
  });
});

// ---------------------------------------------------------------------------
// readExtensionName — unit tests
// ---------------------------------------------------------------------------
suite('readExtensionName', () => {
  const mainRoot = path.resolve(__dirname, '../../..', 'test/fixtures/rdbg/configuration-with-extension/main');
  const extRoot = path.resolve(__dirname, '../../..', 'test/fixtures/rdbg/configuration-with-extension/extension');

  suiteTeardown(() => {
    clearExtensionNameCache();
  });

  test('main configuration returns empty string', async () => {
    const name = await readExtensionName(mainRoot);
    assert.strictEqual(name, '', 'main config should have empty extensionName');
  });

  test('extension configuration returns extension name', async () => {
    const name = await readExtensionName(extRoot);
    assert.strictEqual(name, 'МоёРасширение');
  });

  test('non-existent root returns empty string', async () => {
    const name = await readExtensionName('/does/not/exist/anywhere');
    assert.strictEqual(name, '');
  });

  test('cache returns same value on repeated call', async () => {
    const a = await readExtensionName(extRoot);
    const b = await readExtensionName(extRoot);
    assert.strictEqual(a, b);
    assert.strictEqual(b, 'МоёРасширение');
  });
});

// ---------------------------------------------------------------------------
// moduleIdResolver — multi-root
// ---------------------------------------------------------------------------
suite('moduleIdResolver — multi-root', () => {
  const mainRoot = path.resolve(__dirname, '../../..', 'test/fixtures/rdbg/configuration-with-extension/main');
  const extRoot = path.resolve(__dirname, '../../..', 'test/fixtures/rdbg/configuration-with-extension/extension');

  suiteTeardown(() => {
    clearDumpMetadataCache();
    clearExtensionNameCache();
  });

  test('main module path → extensionName empty', async () => {
    const bslPath = path.join(mainRoot, 'CommonModules', 'MainModule', 'Ext', 'Module.bsl');
    const result = await resolveModuleId(bslPath, [mainRoot, extRoot]);
    assert.ok(result, 'should resolve');
    assert.strictEqual(result.moduleId.extensionName ?? '', '', 'main module should have empty extensionName');
    assert.strictEqual(result.configRoot, mainRoot);
    assert.strictEqual(result.moduleId.objectId, '33333333-3333-3333-3333-333333333333');
  });

  test('extension module path → extensionName from Configuration.xml', async () => {
    const bslPath = path.join(extRoot, 'CommonModules', 'ExtModule', 'Ext', 'Module.bsl');
    const result = await resolveModuleId(bslPath, [mainRoot, extRoot]);
    assert.ok(result, 'should resolve');
    assert.strictEqual(result.moduleId.extensionName, 'МоёРасширение');
    assert.strictEqual(result.configRoot, extRoot);
    assert.strictEqual(result.moduleId.objectId, '44444444-4444-4444-4444-444444444444');
  });

  test('reverse map: extensionName picks the right root', async () => {
    const resolverRoots = [
      { extensionName: '', root: mainRoot },
      { extensionName: 'МоёРасширение', root: extRoot },
    ];
    const resolvedPath = await resolveBslPathFromRdbgModule(
      {
        objectId: '44444444-4444-4444-4444-444444444444',
        propertyId: 'd5963243-262e-4398-b4d7-fb16d06484f6',
        extensionName: 'МоёРасширение',
      },
      resolverRoots
    );
    assert.ok(resolvedPath, 'should resolve to a path');
    assert.ok(resolvedPath.startsWith(extRoot), `expected path to start with extRoot, got: ${resolvedPath}`);
  });

  test('legacy single-root signature still works', async () => {
    const bslPath = path.join(mainRoot, 'CommonModules', 'MainModule', 'Ext', 'Module.bsl');
    const result = await resolveModuleId(bslPath, mainRoot);
    assert.ok(result, 'legacy single-root should resolve');
    assert.strictEqual(result.moduleId.objectId, '33333333-3333-3333-3333-333333333333');
  });

  test('configRoot field populated in result', async () => {
    const bslPath = path.join(extRoot, 'CommonModules', 'ExtModule', 'Ext', 'Module.bsl');
    const result = await resolveModuleId(bslPath, [extRoot]);
    assert.ok(result, 'should resolve');
    assert.strictEqual(result.configRoot, extRoot);
  });

  test('path not in any root returns undefined', async () => {
    const result = await resolveModuleId('/totally/random/path.bsl', [mainRoot, extRoot]);
    assert.strictEqual(result, undefined);
  });
});
