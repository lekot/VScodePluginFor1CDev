import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildMissingIbcmdReportMessage,
  getDefaultIbcmdReportDir,
  getIbcmdLastReportPath,
  getIbcmdTaskLabel,
  IBCMD_REPORT_FILE_NAMES,
} from '../../src/services/ibcmdReportPaths';

function repoRootFromSuite(): string {
  return path.resolve(__dirname, '../../..');
}

suite('ibcmdReportPaths', () => {
  test('default report dir is workspace/.ibcmd-reports', () => {
    const root = path.join('home', 'me', 'repo');
    assert.strictEqual(getDefaultIbcmdReportDir(root), path.join(root, '.ibcmd-reports'));
  });

  test('last report paths are deterministic for modes', () => {
    const root = path.join('home', 'me', 'repo');
    assert.strictEqual(
      getIbcmdLastReportPath(root, 'check'),
      path.join(root, '.ibcmd-reports', 'check-last.log')
    );
    assert.strictEqual(
      getIbcmdLastReportPath(root, 'import'),
      path.join(root, '.ibcmd-reports', 'import-last.log')
    );
  });

  test('package.json exposes open-last-ibcmd-report commands', () => {
    const pkgRaw = fs.readFileSync(path.join(repoRootFromSuite(), 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw) as {
      contributes?: { commands?: Array<{ command?: string }> };
    };
    const commandIds = new Set((pkg.contributes?.commands ?? []).map((c) => c.command));
    assert.ok(
      commandIds.has('1c-metadata-tree.openIbcmdCheckReport'),
      'open check report command must be contributed'
    );
    assert.ok(
      commandIds.has('1c-metadata-tree.openIbcmdImportReport'),
      'open import report command must be contributed'
    );
  });

  test('missing report warning contains path and task hint', () => {
    const root = path.join('home', 'me', 'repo');
    const checkPath = getIbcmdLastReportPath(root, 'check');
    const importPath = getIbcmdLastReportPath(root, 'import');

    const checkMsg = buildMissingIbcmdReportMessage('check', checkPath);
    assert.ok(checkMsg.includes(checkPath));
    assert.ok(checkMsg.includes('CDT: ibcmd - check infobase configuration'));

    const importMsg = buildMissingIbcmdReportMessage('import', importPath);
    assert.ok(importMsg.includes(importPath));
    assert.ok(importMsg.includes('CDT: ibcmd - import configuration from XML'));
  });

  test('task labels are stable for check/import modes', () => {
    assert.strictEqual(getIbcmdTaskLabel('check'), 'CDT: ibcmd - check infobase configuration');
    assert.strictEqual(getIbcmdTaskLabel('import'), 'CDT: ibcmd - import configuration from XML');
  });

  test('report file names are stable for check/import modes', () => {
    assert.strictEqual(IBCMD_REPORT_FILE_NAMES.check, 'check-last.log');
    assert.strictEqual(IBCMD_REPORT_FILE_NAMES.import, 'import-last.log');
  });
});

