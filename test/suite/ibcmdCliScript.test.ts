import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function repoRootFromSuite(): string {
  // Compiled to `out/test/suite`; repo root is three levels up.
  return path.resolve(__dirname, '../../..');
}

function cliPath(): string {
  return path.join(repoRootFromSuite(), 'scripts', 'ibcmd-cli.cjs');
}

function runCli(
  extraEnv: NodeJS.ProcessEnv,
  args: string[]
): { status: number | null; stderr: string; combined: string } {
  const r = spawnSync(process.execPath, [cliPath(), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { status: r.status, stderr: (r.stderr ?? '').toString(), combined };
}

function rmDirQuiet(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

suite('ibcmd-cli.cjs (VS Code tasks helper)', () => {
  test('prints usage and exits 2 without mode', () => {
    const r = spawnSync(process.execPath, [cliPath()], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2);
    const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.ok(combined.includes('Usage'));
  });

  test('exits 1 when IBCMD_PATH or IBCMD_INFOBASE_CONFIG missing', () => {
    const r = runCli(
      { IBCMD_PATH: '', IBCMD_INFOBASE_CONFIG: '' },
      ['check']
    );
    assert.strictEqual(r.status, 1);
    assert.ok(r.combined.includes('IBCMD_PATH'));
  });

  test.skip('check: forwards to ibcmd with resolved --config and optional --force', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ibcmd-cli-'));
    try {
      const cfg = path.join(tmp, 'ib.yml');
      const reports = path.join(tmp, 'reports');
      const fake =
        process.platform === 'win32'
          ? (() => {
              const p = path.join(tmp, 'ibcmd-fake.cmd');
              fs.writeFileSync(p, '@echo fake-ibcmd\r\n@exit /b 0\r\n', 'utf8');
              return p;
            })()
          : (() => {
              const p = path.join(tmp, 'ibcmd-fake');
              fs.writeFileSync(p, '#!/bin/sh\necho fake-ibcmd\nexit 0\n', 'utf8');
              fs.chmodSync(p, 0o755);
              return p;
            })();
      fs.writeFileSync(cfg, '# stub\n', 'utf8');

      const r = runCli(
        {
          IBCMD_PATH: fake,
          IBCMD_INFOBASE_CONFIG: cfg,
          IBCMD_CONFIG_CHECK_FORCE: '1',
          IBCMD_REPORT_DIR: reports,
        },
        ['check']
      );
      assert.strictEqual(r.status, 0);
      assert.ok(r.combined.includes('[ibcmd-cli] exitCode: 0'));
      assert.ok(r.combined.includes('[ibcmd-cli] report:'), 'report path should be printed');
      const reportPath = path.join(reports, 'check-last.log');
      assert.ok(fs.existsSync(reportPath), 'check report should be written');
      const report = fs.readFileSync(reportPath, 'utf8');
      assert.ok(report.includes('mode=check'));
      assert.ok(report.includes('fake-ibcmd'));
    } finally {
      rmDirQuiet(tmp);
    }
  });

  test.skip('import: requires MATRIX_WORK_DIR with Configuration.xml', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ibcmd-cli-import-'));
    try {
      const cfg = path.join(tmp, 'ib.yml');
      const fake =
        process.platform === 'win32'
          ? (() => {
              const p = path.join(tmp, 'ibcmd-fake.cmd');
              fs.writeFileSync(p, '@exit /b 0\r\n', 'utf8');
              return p;
            })()
          : (() => {
              const p = path.join(tmp, 'ibcmd-fake');
              fs.writeFileSync(p, '#!/bin/sh\nexit 0\n', 'utf8');
              fs.chmodSync(p, 0o755);
              return p;
            })();
      fs.writeFileSync(cfg, '# stub\n', 'utf8');

      const noCfg = runCli(
        { IBCMD_PATH: fake, IBCMD_INFOBASE_CONFIG: cfg, MATRIX_WORK_DIR: tmp },
        ['import']
      );
      assert.strictEqual(noCfg.status, 1);
      assert.ok(noCfg.combined.includes('Configuration.xml'));

      const sample = path.join(repoRootFromSuite(), 'FormatSamples', 'empty_conf');
      const ok = runCli(
        {
          IBCMD_PATH: fake,
          IBCMD_INFOBASE_CONFIG: cfg,
          MATRIX_WORK_DIR: sample,
        },
        ['import']
      );
      assert.strictEqual(ok.status, 0);
    } finally {
      rmDirQuiet(tmp);
    }
  });

  test.skip('check: writes report with non-zero exit code on ibcmd failure', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ibcmd-cli-fail-'));
    try {
      const cfg = path.join(tmp, 'ib.yml');
      const reports = path.join(tmp, 'reports');
      const fake =
        process.platform === 'win32'
          ? (() => {
              const p = path.join(tmp, 'ibcmd-fail.cmd');
              fs.writeFileSync(p, '@echo fail-stderr 1>&2\r\n@exit /b 2\r\n', 'utf8');
              return p;
            })()
          : (() => {
              const p = path.join(tmp, 'ibcmd-fail');
              fs.writeFileSync(p, '#!/bin/sh\necho fail-stderr 1>&2\nexit 2\n', 'utf8');
              fs.chmodSync(p, 0o755);
              return p;
            })();
      fs.writeFileSync(cfg, '# stub\n', 'utf8');

      const r = runCli(
        {
          IBCMD_PATH: fake,
          IBCMD_INFOBASE_CONFIG: cfg,
          IBCMD_REPORT_DIR: reports,
        },
        ['check']
      );
      assert.strictEqual(r.status, 2);
      assert.ok(r.combined.includes('[ibcmd-cli] exitCode: 2'));
      const reportPath = path.join(reports, 'check-last.log');
      assert.ok(fs.existsSync(reportPath), 'failure report should be written');
      const report = fs.readFileSync(reportPath, 'utf8');
      assert.ok(report.includes('exitCode=2'));
      assert.ok(report.includes('fail-stderr'));
    } finally {
      rmDirQuiet(tmp);
    }
  });

  test('.vscode/tasks.json lists CDT ibcmd tasks wired to scripts/ibcmd-cli.cjs', () => {
    const raw = fs.readFileSync(path.join(repoRootFromSuite(), '.vscode', 'tasks.json'), 'utf8');
    const doc = JSON.parse(raw) as {
      tasks?: Array<{
        label?: string;
        args?: string[];
        options?: { env?: Record<string, string> };
      }>;
    };
    const tasks = doc.tasks ?? [];
    const check = tasks.find((t) => t.label === 'CDT: ibcmd — check infobase configuration');
    const imp = tasks.find((t) => t.label === 'CDT: ibcmd — import configuration from XML');
    assert.ok(check, 'check task');
    assert.ok(imp, 'import task');
    assert.deepStrictEqual(check!.args, ['scripts/ibcmd-cli.cjs', 'check']);
    assert.deepStrictEqual(imp!.args, ['scripts/ibcmd-cli.cjs', 'import']);
    assert.strictEqual(
      check!.options?.env?.IBCMD_REPORT_DIR,
      '${workspaceFolder}/.ibcmd-reports'
    );
    assert.strictEqual(
      imp!.options?.env?.IBCMD_REPORT_DIR,
      '${workspaceFolder}/.ibcmd-reports'
    );
  });
});
