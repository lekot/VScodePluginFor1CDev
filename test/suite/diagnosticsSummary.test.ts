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
    assert.ok(text.includes('Configuration roots: (none found'));
    assert.ok(text.endsWith('Generated (UTC): 2026-03-24T12:00:00.000Z'));
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
