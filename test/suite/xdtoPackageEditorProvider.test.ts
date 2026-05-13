import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveXdtoPackageSchemaPath } from '../../src/xdtoPackageEditor/xdtoPackagePaths';
import { buildXdtoPackageSkeleton } from '../../src/xdtoPackageEditor/xdtoPackageFiles';

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
});
