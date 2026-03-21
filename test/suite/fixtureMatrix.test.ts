import * as assert from 'assert';
import * as path from 'path';
import { ConfigFormat, FormatDetector } from '../../src/parsers/formatDetector';
import { MetadataParser } from '../../src/parsers/metadataParser';
import { XmlParser } from '../../src/parsers/xmlParser';

suite('Fixture matrix', () => {
  const matrixRoot = path.join(__dirname, '../fixtures/matrix');
  const validVariants = ['small', 'medium', 'large', 'overlay-a', 'overlay-b', 'unicode-тест'];

  test('findAllConfigurationRoots discovers all matrix variants', async () => {
    const entries = await FormatDetector.findAllConfigurationRoots([matrixRoot]);
    const discoveredNames = entries.map((entry) => path.basename(entry.configPath)).sort();

    for (const variant of validVariants) {
      assert.ok(discoveredNames.includes(variant), `Expected fixture variant "${variant}" to be discovered`);
    }
  });

  test('valid matrix variants have designer format and parse root node', async () => {
    for (const variant of validVariants) {
      const configPath = path.join(matrixRoot, variant);
      const format = await FormatDetector.detect(configPath);
      assert.strictEqual(format, ConfigFormat.Designer, `Expected Designer format for "${variant}"`);

      const rootNode = await MetadataParser.parse(configPath);
      assert.ok(rootNode, `Expected parsed root node for "${variant}"`);
    }
  });

  test('malformed matrix variant yields empty parsed payload', async () => {
    const malformedPath = path.join(matrixRoot, 'malformed');
    const malformedConfigXml = path.join(malformedPath, 'Configuration.xml');
    const parsed = await XmlParser.parseFileAsync(malformedConfigXml);
    assert.strictEqual(Object.keys(parsed).length, 0, 'Malformed matrix XML must not expose metadata root');
  });
});
