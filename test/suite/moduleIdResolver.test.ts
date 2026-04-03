import * as assert from 'assert';
import * as path from 'path';
import { resolveModuleId } from '../../src/debug/moduleIdResolver';

suite('moduleIdResolver', () => {
  const wsRoot = path.resolve(__dirname, '../../..', 'FormatSamples/empty_conf');

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
});
