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

  test('should validate configuration path', () => {
    const configPath = path.join(__dirname, '../fixtures/designer-config');
    const isValid = FormatDetector.isValidConfigurationPath(configPath);

    assert.strictEqual(isValid, true);
  });

  test('should return false for invalid configuration path', () => {
    const configPath = path.join(__dirname, '../fixtures/non-existent');
    const isValid = FormatDetector.isValidConfigurationPath(configPath);

    assert.strictEqual(isValid, false);
  });

  test('should find configuration root in workspace', () => {
    const workspacePath = path.join(__dirname, '../fixtures');
    const configRoot = FormatDetector.findConfigurationRoot(workspacePath);

    assert.ok(configRoot);
    assert.ok(configRoot?.includes('designer-config'));
  });

  test('should return null if configuration not found', () => {
    const workspacePath = path.join(__dirname, '../fixtures/non-existent');
    const configRoot = FormatDetector.findConfigurationRoot(workspacePath);

    assert.strictEqual(configRoot, null);
  });
});
