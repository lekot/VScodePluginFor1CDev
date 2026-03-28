import * as assert from 'assert';
import { bindingKey, normalizeConfigRelativePath } from '../../src/bindings/bindingPathUtils';

suite('bindingPathUtils', () => {
  test('normalizeConfigRelativePath uses forward slashes and trims', () => {
    assert.strictEqual(normalizeConfigRelativePath('  src\\\\Cfg\\Configuration.xml  '), 'src/Cfg/Configuration.xml');
  });

  test('normalizeConfigRelativePath strips leading ./', () => {
    assert.strictEqual(normalizeConfigRelativePath('./src/Configuration.xml'), 'src/Configuration.xml');
  });

  test('bindingKey is stable for equivalent paths', () => {
    assert.strictEqual(
      bindingKey('root', 'src/Configuration.xml'),
      bindingKey('root', '.\\src\\Configuration.xml'),
    );
  });
});
