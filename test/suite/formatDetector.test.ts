import * as assert from 'assert';
import * as path from 'path';
import { FormatDetector, ConfigFormat } from '../../src/parsers/formatDetector';

suite('FormatDetector', () => {
  test('should detect Designer format', async () => {
    const configPath = path.join(__dirname, '../fixtures/designer-config');
    const format = await FormatDetector.detect(configPath);

    assert.strictEqual(format, ConfigFormat.Designer);
  });

  test('should return Unknown for non-existent path', async () => {
    const configPath = path.join(__dirname, '../fixtures/non-existent');
    const format = await FormatDetector.detect(configPath);

    assert.strictEqual(format, ConfigFormat.Unknown);
  });

  test('should validate configuration path', async () => {
    const configPath = path.join(__dirname, '../fixtures/designer-config');
    const isValid = await FormatDetector.isValidConfigurationPath(configPath);

    assert.strictEqual(isValid, true);
  });

  test('should return false for invalid configuration path', async () => {
    const configPath = path.join(__dirname, '../fixtures/non-existent');
    const isValid = await FormatDetector.isValidConfigurationPath(configPath);

    assert.strictEqual(isValid, false);
  });

  test('should find configuration root in workspace', async () => {
    const workspacePath = path.join(__dirname, '../fixtures');
    const configRoot = await FormatDetector.findConfigurationRoot(workspacePath);

    assert.ok(configRoot);
    assert.ok(configRoot?.includes('designer-config'));
  });

  test('should return null if configuration not found', async () => {
    const workspacePath = path.join(__dirname, '../fixtures/non-existent');
    const configRoot = await FormatDetector.findConfigurationRoot(workspacePath);

    assert.strictEqual(configRoot, null);
  });

  test('findAllConfigurationRoots returns all configs in workspace folders', async () => {
    const fixturesPath = path.join(__dirname, '../fixtures');
    const result = await FormatDetector.findAllConfigurationRoots([fixturesPath]);

    assert.ok(Array.isArray(result));
    assert.ok(result.length >= 1, 'at least designer-config');
    const designerEntry = result.find((r) => r.configPath.includes('designer-config'));
    assert.ok(designerEntry);
    assert.strictEqual(designerEntry.workspaceFolderPath, fixturesPath);
  });

  test('findAllConfigurationRoots deduplicates same config path', async () => {
    const fixturesPath = path.join(__dirname, '../fixtures');
    const result = await FormatDetector.findAllConfigurationRoots([fixturesPath, fixturesPath]);

    const configPaths = result.map((r) => r.configPath);
    const unique = new Set(configPaths);
    assert.strictEqual(unique.size, result.length, 'no duplicate config paths');
  });

  test('findAllConfigurationRoots returns empty for empty input', async () => {
    const result = await FormatDetector.findAllConfigurationRoots([]);
    assert.deepStrictEqual(result, []);
  });
});
