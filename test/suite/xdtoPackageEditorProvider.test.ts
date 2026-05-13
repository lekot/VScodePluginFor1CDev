import * as assert from 'assert';
import * as path from 'path';
import { resolveXdtoPackageSchemaPath } from '../../src/xdtoPackageEditor/xdtoPackagePaths';

suite('XdtoPackageEditorProvider (pure helpers)', () => {
  test('resolves Designer Package.xdto path from flat metadata XML', () => {
    const metadataPath = path.join('C:', 'cfg', 'XDTOPackages', 'Exchange.xml');
    const result = resolveXdtoPackageSchemaPath(metadataPath, 'Exchange');
    assert.strictEqual(
      result,
      path.join('C:', 'cfg', 'XDTOPackages', 'Exchange', 'Ext', 'Package.xdto')
    );
  });
});
