import * as assert from 'assert';
import { buildDiagnosticsSummaryText } from '../../src/utils/diagnosticsSummary';

suite('diagnosticsSummary', () => {
  test('formats empty workspace and no config roots', () => {
    const text = buildDiagnosticsSummaryText({
      productLabel: 'CDT 41',
      extensionVersion: '0.26.0',
      vscodeVersion: '1.80.0',
      workspaceFolders: [],
      configRoots: [],
      nowIso: '2026-03-24T12:00:00.000Z',
    });

    assert.ok(text.includes('Workspace folders: 0'));
    assert.ok(!text.includes('Host platform:'));
    assert.ok(!text.includes('Host app:'));
    assert.ok(!text.includes('VS Code UI locale:'));
    assert.ok(!text.includes('\nRemote:'));
    assert.ok(!text.includes('Extension run mode:'));
    assert.ok(text.includes('Configuration roots: (none found'));
    assert.ok(text.endsWith('Generated (UTC): 2026-03-24T12:00:00.000Z'));
  });

  test('includes host platform when provided', () => {
    const text = buildDiagnosticsSummaryText({
      productLabel: 'CDT 41',
      extensionVersion: '0.1.0',
      vscodeVersion: '1.80.0',
      hostPlatform: 'linux',
      workspaceFolders: [],
      configRoots: [],
      nowIso: '2026-03-24T12:00:00.000Z',
    });

    assert.ok(text.includes('VS Code version: 1.80.0'));
    assert.ok(text.includes('Host platform: linux'));
    assert.ok(text.indexOf('VS Code version: 1.80.0') < text.indexOf('Host platform: linux'));
    assert.ok(text.indexOf('Host platform: linux') < text.indexOf('Workspace folders: 0'));
  });

  test('includes host app name when provided', () => {
    const text = buildDiagnosticsSummaryText({
      productLabel: 'CDT 41',
      extensionVersion: '0.1.0',
      vscodeVersion: '1.80.0',
      appName: 'Cursor',
      workspaceFolders: [],
      configRoots: [],
      nowIso: '2026-03-24T12:00:00.000Z',
    });

    assert.ok(text.includes('Host app: Cursor'));
    assert.ok(text.indexOf('VS Code version: 1.80.0') < text.indexOf('Host app: Cursor'));
    assert.ok(text.indexOf('Host app: Cursor') < text.indexOf('Workspace folders: 0'));
  });

  test('includes UI locale when provided', () => {
    const text = buildDiagnosticsSummaryText({
      productLabel: 'CDT 41',
      extensionVersion: '0.1.0',
      vscodeVersion: '1.80.0',
      hostPlatform: 'win32',
      uiLocale: 'ru',
      workspaceFolders: [],
      configRoots: [],
      nowIso: '2026-03-24T12:00:00.000Z',
    });

    assert.ok(text.includes('VS Code UI locale: ru'));
    assert.ok(text.indexOf('VS Code UI locale: ru') < text.indexOf('Workspace folders: 0'));
  });

  test('includes remote host name when provided', () => {
    const text = buildDiagnosticsSummaryText({
      productLabel: 'CDT 41',
      extensionVersion: '0.1.0',
      vscodeVersion: '1.80.0',
      uiLocale: 'en',
      remoteName: 'wsl',
      workspaceFolders: [],
      configRoots: [],
      nowIso: '2026-03-24T12:00:00.000Z',
    });

    assert.ok(text.includes('Remote: wsl'));
    assert.ok(text.indexOf('VS Code UI locale: en') < text.indexOf('Remote: wsl'));
    assert.ok(text.indexOf('Remote: wsl') < text.indexOf('Workspace folders: 0'));
  });

  test('includes extension run mode when provided', () => {
    const text = buildDiagnosticsSummaryText({
      productLabel: 'CDT 41',
      extensionVersion: '0.1.0',
      vscodeVersion: '1.80.0',
      extensionRunMode: 'development',
      workspaceFolders: [],
      configRoots: [],
      nowIso: '2026-03-24T12:00:00.000Z',
    });

    assert.ok(text.includes('Extension run mode: development'));
    assert.ok(text.indexOf('Extension run mode: development') < text.indexOf('Workspace folders: 0'));
  });

  test('full bundle field order (snapshot)', () => {
    const text = buildDiagnosticsSummaryText({
      productLabel: 'CDT 41',
      extensionVersion: '0.26.0',
      vscodeVersion: '1.99.0',
      appName: 'Visual Studio Code',
      hostPlatform: 'linux',
      uiLocale: 'ru',
      remoteName: 'wsl',
      extensionRunMode: 'development',
      workspaceFolders: [{ name: 'w', path: '/tmp/w' }],
      configRoots: [],
      nowIso: '2026-03-24T00:00:00.000Z',
    });

    assert.strictEqual(
      text,
      [
        'CDT 41 diagnostics',
        'Extension version: 0.26.0',
        'VS Code version: 1.99.0',
        'Host app: Visual Studio Code',
        'Host platform: linux',
        'VS Code UI locale: ru',
        'Remote: wsl',
        'Extension run mode: development',
        'Workspace folders: 1',
        '  - w: /tmp/w',
        'Configuration roots: (none found under workspace folders, max search depth 5)',
        'Generated (UTC): 2026-03-24T00:00:00.000Z',
      ].join('\n')
    );
  });

  test('full bundle with multiple config roots (snapshot)', () => {
    const text = buildDiagnosticsSummaryText({
      productLabel: 'CDT 41',
      extensionVersion: '0.26.0',
      vscodeVersion: '1.99.0',
      extensionRunMode: 'production',
      workspaceFolders: [
        { name: 'alpha', path: '/proj/alpha' },
        { name: 'beta', path: '/proj/beta' },
      ],
      configRoots: [
        {
          configPath: '/proj/alpha/sub/Configuration',
          workspaceFolderPath: '/proj/alpha',
          format: 'Designer',
        },
        {
          configPath: '/proj/beta',
          workspaceFolderPath: '/proj/beta',
          format: 'EDT',
        },
      ],
      nowIso: '2026-03-24T00:00:00.000Z',
    });

    assert.strictEqual(
      text,
      [
        'CDT 41 diagnostics',
        'Extension version: 0.26.0',
        'VS Code version: 1.99.0',
        'Extension run mode: production',
        'Workspace folders: 2',
        '  - alpha: /proj/alpha',
        '  - beta: /proj/beta',
        'Configuration roots: 2',
        '  - /proj/alpha/sub/Configuration',
        '    format: Designer (workspace folder: /proj/alpha)',
        '  - /proj/beta',
        '    format: EDT (workspace folder: /proj/beta)',
        'Generated (UTC): 2026-03-24T00:00:00.000Z',
      ].join('\n')
    );
  });

  test('lists folders and config roots with formats', () => {
    const text = buildDiagnosticsSummaryText({
      productLabel: 'CDT 41',
      extensionVersion: '1.0.0',
      vscodeVersion: '1.99.0',
      workspaceFolders: [
        { name: 'cfg', path: '/tmp/cfg' },
        { name: 'other', path: '/tmp/other' },
      ],
      configRoots: [
        {
          configPath: '/tmp/cfg',
          workspaceFolderPath: '/tmp/cfg',
          format: 'Designer',
        },
      ],
      nowIso: 'fixed',
    });

    assert.ok(text.includes('  - cfg: /tmp/cfg'));
    assert.ok(text.includes('  - other: /tmp/other'));
    assert.ok(text.includes('Configuration roots: 1'));
    assert.ok(text.includes('  - /tmp/cfg'));
    assert.ok(text.includes('format: Designer (workspace folder: /tmp/cfg)'));
  });
});
