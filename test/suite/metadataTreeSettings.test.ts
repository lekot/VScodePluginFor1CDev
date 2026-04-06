import * as assert from 'assert';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';
import {
  getIbcmdPathSetting,
  getIbcmdTimeoutMsSetting,
  getIbcmdAutoDetectSetting,
  getIbcmdConsoleOutputEncodingSetting,
  getIbcmdImportDiagnosticsSetting,
  getGitReloadMetadataOnHeadChangeSetting,
  getGitRefreshInfobaseManagerOnHeadChangeSetting,
  getPlatformPathSetting,
  IBCMD_PATH_SETTINGS_QUERY,
  PLATFORM_PATH_SETTINGS_QUERY,
} from '../../src/services/metadataTreeSettings';

suite('metadataTreeSettings', () => {
  setup(() => {
    resetVscodeTestState();
  });
  teardown(() => {
    resetVscodeTestState();
  });

  // ── getIbcmdPathSetting ──────────────────────────────────────────────────

  suite('getIbcmdPathSetting', () => {
    test('returns empty string when not set', () => {
      assert.strictEqual(getIbcmdPathSetting(), '');
    });

    test('returns configured path', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = '/usr/bin/ibcmd';
      assert.strictEqual(getIbcmdPathSetting(), '/usr/bin/ibcmd');
    });

    test('trims whitespace from path', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = '  /opt/ibcmd  ';
      assert.strictEqual(getIbcmdPathSetting(), '/opt/ibcmd');
    });

    test('returns empty string when value is undefined', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = undefined;
      assert.strictEqual(getIbcmdPathSetting(), '');
    });
  });

  // ── getIbcmdTimeoutMsSetting ─────────────────────────────────────────────

  suite('getIbcmdTimeoutMsSetting', () => {
    test('returns 0 when not set', () => {
      assert.strictEqual(getIbcmdTimeoutMsSetting(), 0);
    });

    test('converts seconds to milliseconds', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.timeout'] = 30;
      assert.strictEqual(getIbcmdTimeoutMsSetting(), 30000);
    });

    test('returns 0 for zero timeout', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.timeout'] = 0;
      assert.strictEqual(getIbcmdTimeoutMsSetting(), 0);
    });

    test('returns 0 for negative timeout', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.timeout'] = -5;
      assert.strictEqual(getIbcmdTimeoutMsSetting(), 0);
    });

    test('returns 0 for non-number value', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.timeout'] = 'fast';
      assert.strictEqual(getIbcmdTimeoutMsSetting(), 0);
    });

    test('returns 0 for Infinity', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.timeout'] = Infinity;
      assert.strictEqual(getIbcmdTimeoutMsSetting(), 0);
    });
  });

  // ── getIbcmdAutoDetectSetting ────────────────────────────────────────────

  suite('getIbcmdAutoDetectSetting', () => {
    test('returns true when not set (default on)', () => {
      assert.strictEqual(getIbcmdAutoDetectSetting(), true);
    });

    test('returns true when explicitly true', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = true;
      assert.strictEqual(getIbcmdAutoDetectSetting(), true);
    });

    test('returns false when explicitly false', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
      assert.strictEqual(getIbcmdAutoDetectSetting(), false);
    });

    test('returns true when value is undefined (absent)', () => {
      // undefined is treated as "not false", so autoDetect is on
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = undefined;
      assert.strictEqual(getIbcmdAutoDetectSetting(), true);
    });

    test('returns true when value is null', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = null;
      assert.strictEqual(getIbcmdAutoDetectSetting(), true);
    });
  });

  // ── getIbcmdConsoleOutputEncodingSetting ─────────────────────────────────

  suite('getIbcmdConsoleOutputEncodingSetting', () => {
    test('returns auto when not set', () => {
      assert.strictEqual(getIbcmdConsoleOutputEncodingSetting(), 'auto');
    });

    test('returns utf8 when set to utf8', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.consoleOutputEncoding'] = 'utf8';
      assert.strictEqual(getIbcmdConsoleOutputEncodingSetting(), 'utf8');
    });

    test('returns utf16le when set to utf16le', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.consoleOutputEncoding'] = 'utf16le';
      assert.strictEqual(getIbcmdConsoleOutputEncodingSetting(), 'utf16le');
    });

    test('returns oem866 when set to oem866', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.consoleOutputEncoding'] = 'oem866';
      assert.strictEqual(getIbcmdConsoleOutputEncodingSetting(), 'oem866');
    });

    test('returns windows1251 when set to windows1251', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.consoleOutputEncoding'] = 'windows1251';
      assert.strictEqual(getIbcmdConsoleOutputEncodingSetting(), 'windows1251');
    });

    test('returns auto for unknown encoding value', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.consoleOutputEncoding'] = 'latin1';
      assert.strictEqual(getIbcmdConsoleOutputEncodingSetting(), 'auto');
    });

    test('returns auto for empty string', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.consoleOutputEncoding'] = '';
      assert.strictEqual(getIbcmdConsoleOutputEncodingSetting(), 'auto');
    });
  });

  // ── getIbcmdImportDiagnosticsSetting ─────────────────────────────────────

  suite('getIbcmdImportDiagnosticsSetting', () => {
    test('returns false when not set (default off)', () => {
      assert.strictEqual(getIbcmdImportDiagnosticsSetting(), false);
    });

    test('returns true when explicitly true', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.importDiagnostics'] = true;
      assert.strictEqual(getIbcmdImportDiagnosticsSetting(), true);
    });

    test('returns false when explicitly false', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.importDiagnostics'] = false;
      assert.strictEqual(getIbcmdImportDiagnosticsSetting(), false);
    });

    test('returns false when value is undefined', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.importDiagnostics'] = undefined;
      assert.strictEqual(getIbcmdImportDiagnosticsSetting(), false);
    });

    test('returns false when value is null', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.importDiagnostics'] = null;
      assert.strictEqual(getIbcmdImportDiagnosticsSetting(), false);
    });
  });

  // ── getGitReloadMetadataOnHeadChangeSetting ──────────────────────────────

  suite('getGitReloadMetadataOnHeadChangeSetting', () => {
    test('returns true when not set (default on)', () => {
      assert.strictEqual(getGitReloadMetadataOnHeadChangeSetting(), true);
    });

    test('returns true when explicitly true', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.git.reloadMetadataOnHeadChange'] = true;
      assert.strictEqual(getGitReloadMetadataOnHeadChangeSetting(), true);
    });

    test('returns false when explicitly false', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.git.reloadMetadataOnHeadChange'] = false;
      assert.strictEqual(getGitReloadMetadataOnHeadChangeSetting(), false);
    });

    test('returns true when value is undefined', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.git.reloadMetadataOnHeadChange'] = undefined;
      assert.strictEqual(getGitReloadMetadataOnHeadChangeSetting(), true);
    });
  });

  // ── getGitRefreshInfobaseManagerOnHeadChangeSetting ──────────────────────

  suite('getGitRefreshInfobaseManagerOnHeadChangeSetting', () => {
    test('returns true when not set (default on)', () => {
      assert.strictEqual(getGitRefreshInfobaseManagerOnHeadChangeSetting(), true);
    });

    test('returns true when explicitly true', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.git.refreshInfobaseManagerOnHeadChange'] = true;
      assert.strictEqual(getGitRefreshInfobaseManagerOnHeadChangeSetting(), true);
    });

    test('returns false when explicitly false', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.git.refreshInfobaseManagerOnHeadChange'] = false;
      assert.strictEqual(getGitRefreshInfobaseManagerOnHeadChangeSetting(), false);
    });

    test('returns true when value is undefined', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.git.refreshInfobaseManagerOnHeadChange'] = undefined;
      assert.strictEqual(getGitRefreshInfobaseManagerOnHeadChangeSetting(), true);
    });
  });

  // ── getPlatformPathSetting ───────────────────────────────────────────────

  suite('getPlatformPathSetting', () => {
    test('returns empty string when not set', () => {
      assert.strictEqual(getPlatformPathSetting(), '');
    });

    test('returns configured path', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.platform.path'] = 'C:\\Program Files\\1cv8\\8.3.25\\bin\\1cv8.exe';
      assert.strictEqual(getPlatformPathSetting(), 'C:\\Program Files\\1cv8\\8.3.25\\bin\\1cv8.exe');
    });

    test('trims whitespace from path', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.platform.path'] = '  /opt/1cv8/bin/1cv8  ';
      assert.strictEqual(getPlatformPathSetting(), '/opt/1cv8/bin/1cv8');
    });

    test('returns empty string when value is undefined', () => {
      vscodeTestState.workspaceConfig['1cMetadataTree.platform.path'] = undefined;
      assert.strictEqual(getPlatformPathSetting(), '');
    });
  });

  // ── constants ────────────────────────────────────────────────────────────

  suite('constants', () => {
    test('IBCMD_PATH_SETTINGS_QUERY matches the config key', () => {
      assert.strictEqual(IBCMD_PATH_SETTINGS_QUERY, '1cMetadataTree.ibcmd.path');
    });

    test('PLATFORM_PATH_SETTINGS_QUERY matches the config key', () => {
      assert.strictEqual(PLATFORM_PATH_SETTINGS_QUERY, '1cMetadataTree.platform.path');
    });
  });
});
