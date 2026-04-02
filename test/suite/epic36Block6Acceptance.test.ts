import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

type BackupState = {
  coreReportExisted: boolean;
  coreReportContent: string;
  acceptanceReportExisted: boolean;
  acceptanceReportContent: string;
};

suite('epic36 block6 acceptance script', function () {
  this.timeout(30000);
  const repoRoot = process.cwd();
  const scriptPath = path.join(repoRoot, 'scripts', 'epic36-block6-acceptance.cjs');
  const reportsDir = path.join(repoRoot, 'suite-reports');
  const coreReportPath = path.join(reportsDir, 'epic36-block6-core.json');
  const acceptanceReportPath = path.join(reportsDir, 'epic36-block6-acceptance.md');

  let backup: BackupState;

  function restoreFiles(): void {
    if (backup.coreReportExisted) {
      fs.writeFileSync(coreReportPath, backup.coreReportContent, 'utf8');
    } else if (fs.existsSync(coreReportPath)) {
      fs.unlinkSync(coreReportPath);
    }

    if (backup.acceptanceReportExisted) {
      fs.writeFileSync(acceptanceReportPath, backup.acceptanceReportContent, 'utf8');
    } else if (fs.existsSync(acceptanceReportPath)) {
      fs.unlinkSync(acceptanceReportPath);
    }
  }

  suiteSetup(() => {
    fs.mkdirSync(reportsDir, { recursive: true });
    backup = {
      coreReportExisted: fs.existsSync(coreReportPath),
      coreReportContent: fs.existsSync(coreReportPath) ? fs.readFileSync(coreReportPath, 'utf8') : '',
      acceptanceReportExisted: fs.existsSync(acceptanceReportPath),
      acceptanceReportContent: fs.existsSync(acceptanceReportPath)
        ? fs.readFileSync(acceptanceReportPath, 'utf8')
        : '',
    };
  });

  setup(() => {
    restoreFiles();
  });

  suiteTeardown(() => {
    restoreFiles();
  });

  test('writes acceptance markdown with layout-meta gate when core report is present', () => {
    const syntheticCoreReport = {
      discoveredSuites: ['suite/formModelUtils.test.js', 'suite/formModelCommands.test.js'],
      executedSuites: ['suite/formModelUtils.test.js', 'suite/formModelCommands.test.js'],
      missingMandatorySuites: [],
      testStats: { passes: 10, failures: 0, pending: 0, total: 10 },
    };
    fs.writeFileSync(coreReportPath, JSON.stringify(syntheticCoreReport, null, 2), 'utf8');

    const run = spawnSync(process.execPath, [scriptPath, '--skip-tests'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.strictEqual(run.status, 0, run.stderr || run.stdout || String(run.signal));

    const report = fs.readFileSync(acceptanceReportPath, 'utf8');
    assert.ok(
      report.includes('- [PASS] Layout meta: all 1 suite(s) executed'),
      'layout meta gate should be present and passing'
    );
    assert.ok(
      report.includes('- [x] suite/formModelUtils.test.js'),
      'formModelUtils must be listed as passed mandatory suite'
    );
    assert.ok(
      report.includes('PagesRepresentation: TabsOnTop/TabsOnBottom rendered in expected tab strip position.'),
      'manual checklist should include PagesRepresentation criterion'
    );
  });

  test('returns non-zero when --skip-tests is used without core report', () => {
    if (fs.existsSync(coreReportPath)) {
      fs.unlinkSync(coreReportPath);
    }

    const run = spawnSync(process.execPath, [scriptPath, '--skip-tests'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 20000,
    });

    assert.notStrictEqual(run.status, 0, 'script must fail when core report is missing');
    const stderr = String(run.stderr || '');
    assert.ok(
      stderr.includes('Core suite report was not found at:'),
      'error must mention missing core suite report'
    );
  });
});
