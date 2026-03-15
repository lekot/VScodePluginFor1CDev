import * as assert from 'assert';
import { getConfigurationPathSync } from '../../src/rolesEditor/metadataLoader';

describe('MetadataLoader', () => {
  describe('getConfigurationPathSync', () => {
    test('should extract configuration path from Designer format role path', () => {
      const roleFilePath = '/workspace/MyConfig/Roles/Administrator/Role.xml';
      const configPath = getConfigurationPathSync(roleFilePath);

      assert.strictEqual(
        configPath,
        '/workspace/MyConfig',
        'Should extract config root from Designer format path'
      );
    });

    test('should extract configuration path from EDT format role path', () => {
      const roleFilePath = '/workspace/MyConfig/Roles/Administrator.xml';
      const configPath = getConfigurationPathSync(roleFilePath);

      assert.strictEqual(
        configPath,
        '/workspace/MyConfig',
        'Should extract config root from EDT format path'
      );
    });

    test('should handle Windows paths', () => {
      const roleFilePath = 'C:\\workspace\\MyConfig\\Roles\\Administrator\\Role.xml';
      const configPath = getConfigurationPathSync(roleFilePath);

      assert.strictEqual(
        configPath,
        'C:\\workspace\\MyConfig',
        'Should handle Windows paths correctly'
      );
    });
  });
});
