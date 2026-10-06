import * as assert from 'assert';
import * as path from 'path';
import { configurationPathKey } from '../../src/utils/configurationPathIdentity';

suite('configurationPathKey', () => {
  test('returns the same normalized absolute key for path aliases', () => {
    const relativeAlias = path.join('configuration-path-identity', '.', 'nested', '..', 'Config', '.');
    const absoluteAlias = path.resolve('configuration-path-identity', 'Config');
    const key = configurationPathKey(relativeAlias);
    const expected = process.platform === 'win32'
      ? path.resolve(absoluteAlias).toLowerCase()
      : path.resolve(absoluteAlias);

    assert.strictEqual(path.isAbsolute(key), true);
    assert.strictEqual(key, expected);
    assert.strictEqual(configurationPathKey(absoluteAlias), expected);
  });

  test('preserves case and treats backslashes as ordinary characters on POSIX', function () {
    if (process.platform === 'win32') {
      this.skip();
      return;
    }

    const root = path.parse(process.cwd()).root;
    const upperCasePath = path.join(root, 'configuration-path-identity', 'Config');
    const lowerCasePath = path.join(root, 'configuration-path-identity', 'config');

    assert.notStrictEqual(configurationPathKey(upperCasePath), configurationPathKey(lowerCasePath));
    assert.notStrictEqual(
      configurationPathKey('/workspace/Config\\nested'),
      configurationPathKey('/workspace/Config/nested'),
    );
    assert.strictEqual(
      configurationPathKey('/workspace/Config\\nested'),
      path.resolve('/workspace/Config\\nested'),
    );
  });

  test('folds case and coalesces separator, dot-segment, and trailing-separator aliases on Windows', function () {
    if (process.platform !== 'win32') {
      this.skip();
      return;
    }

    const root = path.parse(process.cwd()).root;
    const mixedAlias = `${root}ConfigurationIdentity\\Config\\..\\CONFIG\\.\\`;
    const normalizedAlias = `${root.toLowerCase()}configurationidentity/config/`;

    assert.strictEqual(
      configurationPathKey(mixedAlias),
      configurationPathKey(normalizedAlias),
    );
    assert.strictEqual(configurationPathKey(mixedAlias), path.resolve(mixedAlias).toLowerCase());
  });
});
