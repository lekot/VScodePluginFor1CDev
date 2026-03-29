import * as assert from 'assert';
import {
  bindingKey,
  detectIbcmdExtensionNameFromConfigRelativePath,
  normalizeConfigRelativePath,
} from '../../src/bindings/bindingPathUtils';

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

  test('bindingKey with ibcmdExtensionName appends NUL-separated segment (Phase 4 #64)', () => {
    const base = bindingKey('ws', 'src/Configuration.xml');
    const withExt = bindingKey('ws', 'src/Configuration.xml', 'MyExt');
    assert.ok(withExt.startsWith(`${base}\0`));
    assert.ok(withExt.endsWith('MyExt'));
    assert.notStrictEqual(withExt, base);
  });

  test('bindingKey trims extension name and matches empty-as-absent', () => {
    assert.strictEqual(
      bindingKey('w', 'c.xml', '  '),
      bindingKey('w', 'c.xml'),
    );
  });

  test('detectIbcmdExtensionNameFromConfigRelativePath reads segment after /Extensions/', () => {
    assert.strictEqual(
      detectIbcmdExtensionNameFromConfigRelativePath('src/Extensions/ИмяРасширения/Configuration.xml'),
      'ИмяРасширения',
    );
  });

  test('detectIbcmdExtensionNameFromConfigRelativePath is case-insensitive for Extensions token', () => {
    assert.strictEqual(
      detectIbcmdExtensionNameFromConfigRelativePath('x/EXTENSIONS/MyExt/sub/Configuration.xml'),
      'MyExt',
    );
  });

  test('detectIbcmdExtensionNameFromConfigRelativePath returns undefined without Extensions segment', () => {
    assert.strictEqual(detectIbcmdExtensionNameFromConfigRelativePath('src/Configuration.xml'), undefined);
  });
});
