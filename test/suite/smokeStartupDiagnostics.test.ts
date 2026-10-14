import * as assert from 'assert';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

interface SmokeHarnessResult {
  events: Array<{
    type: 'download' | 'runner';
    options: Record<string, unknown>;
  }>;
  logs: string[];
  processExitCode: number | null;
}

interface SmokeHarnessExecution {
  result: SmokeHarnessResult;
  status: number | null;
}

function runSmokeHarness(mode: 'success' | 'download-failure' | 'runner-failure'): SmokeHarnessExecution {
  const repositoryRoot = path.resolve(__dirname, '../../../');
  const runSmokePath = path.join(repositoryRoot, 'out', 'test', 'runSmoke.js');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-startup-harness-'));
  const preloadPath = path.join(tempRoot, 'mock-test-electron.cjs');
  const resultPath = path.join(tempRoot, 'result.json');
  const fakeExecutable = path.join(repositoryRoot, '.vscode-test', 'fake-vscode', 'Code');

  const preloadSource = `
const fs = require('fs');
const path = require('path');
const repositoryRoot = ${JSON.stringify(repositoryRoot)};
const resultPath = ${JSON.stringify(resultPath)};
const fakeExecutable = ${JSON.stringify(fakeExecutable)};
const mode = ${JSON.stringify(mode)};
const testElectronOut = path.join(repositoryRoot, 'node_modules', '@vscode', 'test-electron', 'out');
const download = require(path.join(testElectronOut, 'download.js'));
const runTest = require(path.join(testElectronOut, 'runTest.js'));
const testElectron = require(path.join(testElectronOut, 'index.js'));
const events = [];
const logs = [];
const originalLog = console.log;
const originalError = console.error;
console.log = (...args) => { logs.push(args.map(String).join(' ')); originalLog(...args); };
console.error = (...args) => { logs.push(args.map(String).join(' ')); originalError(...args); };
download.downloadAndUnzipVSCode = async (options) => {
  events.push({ type: 'download', options });
  if (mode === 'download-failure') throw new Error('fake VS Code download failure');
  return fakeExecutable;
};
runTest.runTests = async (options) => {
  events.push({ type: 'runner', options });
  if (mode === 'runner-failure') throw new testElectron.TestRunFailedError(23, undefined);
  return 0;
};
process.once('exit', (code) => {
  fs.writeFileSync(resultPath, JSON.stringify({ events, logs, processExitCode: code }), 'utf8');
});
`;

  try {
    fs.writeFileSync(preloadPath, preloadSource, 'utf8');
    const execution = childProcess.spawnSync(
      process.execPath,
      ['-r', preloadPath, runSmokePath],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          SMOKE_WORKSPACE: path.join(repositoryRoot, 'test', 'fixtures', 'designer-config'),
        },
      }
    );

    assert.strictEqual(
      execution.error,
      undefined,
      `Smoke harness process failed to start: ${execution.error?.message ?? ''}\n${execution.stderr}`
    );
    assert.ok(fs.existsSync(resultPath), `Smoke harness did not capture its result.\n${execution.stdout}\n${execution.stderr}`);
    return {
      result: JSON.parse(fs.readFileSync(resultPath, 'utf8')) as SmokeHarnessResult,
      status: execution.status,
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runSummary(
  outputPath: string,
  reportPath: string,
  runnerOutcome?: 'success' | 'failure'
): childProcess.SpawnSyncReturns<string> {
  const repositoryRoot = path.resolve(__dirname, '../../../');
  const summaryScript = path.join(repositoryRoot, 'scripts', 'render-suite-report-summary.js');
  return childProcess.spawnSync(
    process.execPath,
    [summaryScript, outputPath, reportPath],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...(runnerOutcome ? { SUITE_REPORT_RUNNER_OUTCOME: runnerOutcome } : {}),
      },
    }
  );
}

suite('Smoke startup diagnostics', () => {
  test('downloads once, passes explicit isolated profiles, and records startup order', () => {
    const { result, status } = runSmokeHarness('success');
    const repositoryRoot = path.resolve(__dirname, '../../../');
    assert.strictEqual(status, 0);
    assert.deepStrictEqual(result.events.map((event) => event.type), ['download', 'runner']);

    const downloadOptions = result.events[0].options;
    const runnerOptions = result.events[1].options;
    assert.ok(!Object.prototype.hasOwnProperty.call(downloadOptions, 'version'));
    assert.strictEqual(downloadOptions.cachePath, path.resolve(__dirname, '../../../.vscode-test'));
    assert.strictEqual(downloadOptions.extensionDevelopmentPath, path.resolve(__dirname, '../../../'));
    assert.ok(result.logs.some((line) => line.includes('versionPolicy":"extension-engines"')));
    assert.strictEqual(
      runnerOptions.vscodeExecutablePath,
      path.join(path.resolve(__dirname, '../../../'), '.vscode-test', 'fake-vscode', 'Code')
    );

    const launchArgs = runnerOptions.launchArgs as string[];
    const workspaceArgIndex = launchArgs.indexOf('--folder-uri');
    assert.ok(workspaceArgIndex >= 0, 'Existing smoke workspace launch argument must remain.');
    assert.strictEqual(
      launchArgs[workspaceArgIndex + 1],
      pathToFileURL(path.join(repositoryRoot, 'test', 'fixtures', 'designer-config')).toString()
    );
    assert.ok(
      launchArgs.includes(`--user-data-dir=${path.join(repositoryRoot, '.vscode-test', 'user-data')}`),
      'User data directory must be explicit and isolated under .vscode-test.'
    );
    assert.ok(
      launchArgs.includes(`--extensions-dir=${path.join(repositoryRoot, '.vscode-test', 'extensions')}`),
      'Extensions directory must be explicit and isolated under .vscode-test.'
    );

    const requestedIndex = result.logs.findIndex((line) => line.includes('SMOKE_LAUNCH_REQUESTED'));
    const resolvedIndex = result.logs.findIndex((line) => line.includes('SMOKE_LAUNCH_RESOLVED'));
    assert.ok(requestedIndex >= 0, 'Requested launch marker must be logged.');
    assert.ok(resolvedIndex > requestedIndex, 'Resolved executable marker must follow the requested marker.');

    const smokeSuiteIndexPath = path.join(repositoryRoot, 'test', 'suite', 'smoke', 'index.ts');
    const smokeSuiteSource = fs.readFileSync(smokeSuiteIndexPath, 'utf8');
    const suiteEnteredIndex = smokeSuiteSource.indexOf('SMOKE_SUITE_ENTERED');
    const mochaStartIndex = smokeSuiteSource.indexOf('const mocha = new Mocha');
    assert.ok(suiteEnteredIndex >= 0, 'Suite entry marker must be present.');
    assert.ok(suiteEnteredIndex < mochaStartIndex, 'Suite entry marker must be emitted before Mocha starts.');
  });

  test('does not launch or retry VS Code when download fails', () => {
    const { result, status } = runSmokeHarness('download-failure');
    assert.strictEqual(status, 1);
    assert.deepStrictEqual(result.events.map((event) => event.type), ['download']);
    assert.ok(result.logs.some((line) => line.includes('SMOKE_LAUNCH_REQUESTED')));
    assert.ok(result.logs.some((line) => line.includes('fake VS Code download failure')));
  });

  test('preserves the VS Code runner exit code without retrying', () => {
    const { result, status } = runSmokeHarness('runner-failure');
    assert.strictEqual(status, 23);
    assert.deepStrictEqual(result.events.map((event) => event.type), ['download', 'runner']);
    assert.ok(result.logs.some((line) => line.includes('SMOKE_LAUNCH_RESOLVED')));
    assert.ok(result.logs.some((line) => line.includes('SMOKE_RUNNER_FAILED')));
  });

  test('explains a missing report after runner failure', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-report-summary-'));
    const outputPath = path.join(tempRoot, 'summary.md');
    const reportPath = path.join(tempRoot, 'smoke.json');
    try {
      const result = runSummary(outputPath, reportPath, 'failure');
      assert.strictEqual(result.status, 0, result.stderr);
      const summary = fs.readFileSync(outputPath, 'utf8');
      assert.match(summary, /smoke runner failed before it was written/i);
      assert.match(summary, /smoke-tests\.log/i);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('still fails on a missing report after runner success and renders an existing report', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-report-summary-'));
    const outputPath = path.join(tempRoot, 'summary.md');
    const missingReportPath = path.join(tempRoot, 'smoke.json');
    const existingReportPath = path.join(tempRoot, 'smoke.json');
    try {
      const missing = runSummary(outputPath, missingReportPath, 'success');
      assert.notStrictEqual(missing.status, 0, 'A successful runner must still require its smoke suite report.');

      fs.writeFileSync(
        existingReportPath,
        JSON.stringify({
          job: 'smoke',
          discoveredSuites: ['suite/smoke/smoke.test.js'],
          executedSuites: ['suite/smoke/smoke.test.js'],
          mandatorySuites: ['suite/smoke/smoke.test.js'],
          missingMandatorySuites: [],
          testStats: { total: 1, passes: 1, failures: 0, pending: 0 },
        }),
        'utf8'
      );
      const present = runSummary(outputPath, existingReportPath, 'failure');
      assert.strictEqual(present.status, 0, present.stderr);
      assert.match(fs.readFileSync(outputPath, 'utf8'), /executed suites: 1/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('preserves runner failure in the actual Bash workflow block under errexit', function (this: Mocha.Context) {
    const repositoryRoot = path.resolve(__dirname, '../../../');
    const bashPath = process.platform === 'win32'
      ? [
          process.env.GIT_BASH_PATH,
          'C:\\Program Files\\Git\\bin\\bash.exe',
          'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
        ].filter((candidate): candidate is string => candidate !== undefined && fs.existsSync(candidate))
      : ['bash'];
    const availableBash = bashPath.find((candidate) =>
      childProcess.spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0
    );
    if (!availableBash) {
      this.skip();
      return;
    }

    const workflowPath = path.join(repositoryRoot, '.github', 'workflows', 'lint.yml');
    const workflowSource = fs.readFileSync(workflowPath, 'utf8');
    const runnerStepStart = workflowSource.indexOf('      - name: Run smoke tests (blocking)');
    assert.match(workflowSource, /id: smoke-runner/u);
    assert.match(workflowSource, /SUITE_REPORT_RUNNER_OUTCOME: \$\{\{ steps\.smoke-runner\.outcome \}\}/u);
    assert.match(workflowSource, /include-hidden-files: true/u);
    assert.match(workflowSource, /\.vscode-test\/user-data\/logs\/\*/u);
    assert.match(workflowSource, /smoke-tests\.log/u);
    const runBlockStart = workflowSource.indexOf('        run: |', runnerStepStart);
    assert.ok(runnerStepStart >= 0 && runBlockStart > runnerStepStart, 'Smoke runner workflow step must exist.');
    const runContentStart = workflowSource.indexOf('\n', runBlockStart) + 1;
    const nextStepStart = workflowSource.indexOf('\n      - name:', runContentStart);
    const runBlock = workflowSource
      .slice(runContentStart, nextStepStart)
      .split(/\r?\n/u)
      .map((line) => line.replace(/^ {10}/u, ''))
      .join('\n');

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-bash-workflow-'));
    try {
      const script = [
        'xvfb-run() { if [[ "$#" -ne 4 || "$1" != "-a" || "$2" != "npm" || "$3" != "run" || "$4" != "test:smoke" ]]; then return 99; fi; printf "simulated smoke runner error failure\\n" > smoke-tests.log; return 23; }',
        runBlock,
      ].join('\n');
      const result = childProcess.spawnSync(
        availableBash,
        ['-e', '-o', 'pipefail', '-c', script],
        { cwd: tempRoot, encoding: 'utf8', timeout: 5000 }
      );
      assert.strictEqual(result.error, undefined, result.error?.message);
      assert.strictEqual(result.status, 23, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /---- Smoke test errors ----/);
      assert.match(result.stdout, /simulated smoke runner error failure/);
      assert.match(fs.readFileSync(path.join(tempRoot, 'smoke-tests.log'), 'utf8'), /simulated smoke runner error failure/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
