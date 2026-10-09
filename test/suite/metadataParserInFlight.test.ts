import * as assert from 'assert';
import { MetadataParser } from '../../src/parsers/metadataParser';
import { ConfigFormat } from '../../src/parsers/formatDetector';

suite('MetadataParser In-Flight Keys (#198)', () => {
  // Access private static method for testing in-flight key construction
  const getInFlightKey = (configPath: string, typeName: string, format: ConfigFormat, platform?: NodeJS.Platform): string => {
    return (MetadataParser as unknown as {
      getTypeContentsInFlightKey: (configPath: string, typeName: string, format: ConfigFormat, platform?: NodeJS.Platform) => string;
    }).getTypeContentsInFlightKey(configPath, typeName, format, platform);
  };

  test('differentiates case-distinct roots on POSIX platform (#198)', () => {
    const keyUpper = getInFlightKey('/workspace/Config', 'Catalogs', ConfigFormat.Designer, 'linux');
    const keyLower = getInFlightKey('/workspace/config', 'Catalogs', ConfigFormat.Designer, 'linux');
    assert.notStrictEqual(keyUpper, keyLower, 'POSIX must preserve case distinction for distinct config roots');
  });

  test('coalesces case aliases on Windows platform', () => {
    const keyUpper = getInFlightKey('C:\\workspace\\Config', 'Catalogs', ConfigFormat.Designer, 'win32');
    const keyLower = getInFlightKey('c:\\workspace\\config', 'Catalogs', ConfigFormat.Designer, 'win32');
    assert.strictEqual(keyUpper, keyLower, 'Windows must fold case aliases');
  });

  test('normalizes relative dot-segments and redundant slashes without corrupting path identity', () => {
    const key1 = getInFlightKey('/workspace/project/./sub/../sub', 'Documents', ConfigFormat.Designer);
    const key2 = getInFlightKey('/workspace/project/sub', 'Documents', ConfigFormat.Designer);
    assert.strictEqual(key1, key2, 'Dot-segments must coalesce to the canonical resolved path');
  });

  test('distinguishes format in in-flight keys for the same root and type', () => {
    const designerKey = getInFlightKey('/workspace/project', 'Catalogs', ConfigFormat.Designer);
    const edtKey = getInFlightKey('/workspace/project', 'Catalogs', ConfigFormat.EDT);
    assert.notStrictEqual(designerKey, edtKey, 'Different formats must have distinct in-flight keys');
  });

  test('distinguishes different types in the same configuration root', () => {
    const catalogsKey = getInFlightKey('/workspace/project', 'Catalogs', ConfigFormat.Designer);
    const documentsKey = getInFlightKey('/workspace/project', 'Documents', ConfigFormat.Designer);
    assert.notStrictEqual(catalogsKey, documentsKey, 'Different metadata types must have distinct in-flight keys');
  });
});
