import * as assert from 'assert';
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
