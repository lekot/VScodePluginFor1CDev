import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveXdtoPackageSchemaPath } from '../../src/xdtoPackageEditor/xdtoPackagePaths';
import { buildXdtoPackageSkeleton } from '../../src/xdtoPackageEditor/xdtoPackageFiles';
import {
  parseAndValidateXdtoSourceForSave,
  serializeAndValidateXdtoModelForSave,
} from '../../src/xdtoPackageEditor/xdtoPackageEditorProvider';
import type { XdtoPackageModel } from '../../src/types/xdtoPackage';

suite('XdtoPackageEditorProvider (pure helpers)', () => {
  test('resolves Designer Package.bin path from flat metadata XML', () => {
    const metadataPath = path.join('C:', 'cfg', 'XDTOPackages', 'Exchange.xml');
    const result = resolveXdtoPackageSchemaPath(metadataPath, 'Exchange');
    assert.strictEqual(
      result,
      path.join('C:', 'cfg', 'XDTOPackages', 'Exchange', 'Ext', 'Package.bin')
    );
  });

  test('prefers existing Package.bin over legacy Package.xdto', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdto-path-'));
    try {
      const metadataPath = path.join(root, 'XDTOPackages', 'Exchange.xml');
      const extPath = path.join(root, 'XDTOPackages', 'Exchange', 'Ext');
      fs.mkdirSync(extPath, { recursive: true });
      fs.writeFileSync(path.join(extPath, 'Package.xdto'), '<package/>', 'utf8');
      fs.writeFileSync(path.join(extPath, 'Package.bin'), '<package/>', 'utf8');

      assert.strictEqual(
        resolveXdtoPackageSchemaPath(metadataPath, 'Exchange'),
        path.join(extPath, 'Package.bin')
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('builds 1C package skeleton without empty targetNamespace', () => {
    const skeleton = buildXdtoPackageSkeleton('');

    assert.ok(skeleton.includes('<package xmlns="http://v8.1c.ru/8.1/xdto"'));
    assert.ok(!skeleton.includes('targetNamespace=""'));
  });

  test('serializes structured save model to package XML and parsed model without empty targetNamespace', () => {
    const model: XdtoPackageModel = {
      imports: [],
      valueTypes: [{ name: 'BoolFlag', baseType: 'xs:boolean', properties: [], attributes: [], raw: {}, unknownNodes: [] }],
      objectTypes: [],
      rootProperties: [{ name: 'Flag', type: 'BoolFlag', raw: {}, unknownNodes: [] }],
      diagnostics: [],
      unknownNodes: [],
    };

    const result = serializeAndValidateXdtoModelForSave(model);

    assert.strictEqual(result.ok, true);
    assert.ok(result.source.includes('<package xmlns="http://v8.1c.ru/8.1/xdto"'));
    assert.ok(result.source.includes('<valueType name="BoolFlag" base="xs:boolean"/>'));
    assert.ok(result.source.includes('<property name="Flag" type="BoolFlag"/>'));
    assert.ok(!result.source.includes('targetNamespace=""'));
    assert.strictEqual(result.model.valueTypes[0]?.name, 'BoolFlag');
    assert.strictEqual(result.model.rootProperties[0]?.name, 'Flag');
  });

  test('returns source with parsed model for raw source save', () => {
    const source = '\uFEFF<package xmlns="http://v8.1c.ru/8.1/xdto"><valueType name="Amount" base="xs:decimal"/></package>';

    const result = parseAndValidateXdtoSourceForSave(source);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.source, source);
    assert.strictEqual(result.model.valueTypes[0]?.name, 'Amount');
  });

  test('rejects model save when serialized source fails XML validation', () => {
    const model: XdtoPackageModel = {
      imports: [],
      valueTypes: [],
      objectTypes: [],
      rootProperties: [],
      diagnostics: [],
      rawRoot: { '@_xmlns:bad prefix': 'urn:bad' },
      unknownNodes: [],
    };

    const result = serializeAndValidateXdtoModelForSave(model);

    assert.strictEqual(result.ok, false);
    assert.ok(result.message.length > 0);
  });

  test('rejects malformed raw source save', () => {
    const result = parseAndValidateXdtoSourceForSave('<package><valueType></package>');

    assert.strictEqual(result.ok, false);
    assert.ok(result.message.length > 0);
  });
});
