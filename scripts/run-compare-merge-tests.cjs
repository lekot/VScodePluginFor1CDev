'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUN_ROOT_PREFIX = '.tmp-compare-merge-run-';
const MAX_LOG_CHARS = 12000;
const COMPILE_TIMEOUT_MS = 180_000;
const MOCHA_TIMEOUT_MS = 300_000;
const MOCHA_CASE_TIMEOUT_MS = 10_000;
const SUITES = [
  'configurationCompareService',
  'configCompareProvider',
  'configCompareProvider.bulk',
  'configCompareWebview.runtime',
  'compareTreeProjection',
  'compareDisplayTree',
  'bslInventoryCollection',
  'bslSourceRetention',
  'bslRoutineDiff',
  'bslModuleIndexer.cooperative',
  'configurationCompareWorkspace',
  'linkedDesignerPackages',
  'configurationCompareCommands',
  'metadataXmlAdapter',
  'formXmlAdapter',
  'extensionCompareValidation',
  'capturedFileWrite',
  'bslRoutineLogicalMerge',
  'extensionCompare',
  'metadataIndexer',
  'configurationInventory',
  'linkedDesignerPackageBinding',
];
const ADDITIONAL_SUITE_FILES = [
  path.join('test', 'suite', 'metadataFileLocator.test.ts'),
];
const SUITE_COUNT = SUITES.length + ADDITIONAL_SUITE_FILES.length;

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function validateOwnedRunRoot(runRoot, suiteReportsRoot) {
  const absoluteRunRoot = path.resolve(runRoot);
  const absoluteSuiteReports = path.resolve(suiteReportsRoot);
  const runRootName = path.basename(absoluteRunRoot);
  if (
    !samePath(path.dirname(absoluteRunRoot), absoluteSuiteReports) ||
    !runRootName.startsWith(RUN_ROOT_PREFIX)
  ) {
    throw new Error(`Refusing to clean an unowned Compare & Merge run directory: ${absoluteRunRoot}`);
  }

  const reportsInfo = fs.lstatSync(absoluteSuiteReports);
  if (!reportsInfo.isDirectory() || reportsInfo.isSymbolicLink()) {
    throw new Error(`Refusing cleanup because suite-reports is not a real directory: ${absoluteSuiteReports}`);
  }
  const realReports = fs.realpathSync(absoluteSuiteReports);
  const realParent = fs.realpathSync(path.dirname(absoluteRunRoot));
  if (!samePath(realParent, realReports)) {
    throw new Error(`Refusing cleanup because the run directory escapes suite-reports: ${absoluteRunRoot}`);
  }

  const runInfo = fs.lstatSync(absoluteRunRoot);
  if (!runInfo.isDirectory() || runInfo.isSymbolicLink()) {
    throw new Error(`Refusing cleanup because the owned run path is not a real directory: ${absoluteRunRoot}`);
  }
  const realRunRoot = fs.realpathSync(absoluteRunRoot);
  if (!samePath(realRunRoot, path.join(realReports, runRootName))) {
    throw new Error(`Refusing cleanup because the run directory resolves outside its owner: ${absoluteRunRoot}`);
  }
  return absoluteRunRoot;
}

function cleanupOwnedRunRoot(runRoot, suiteReportsRoot) {
  const validatedPath = validateOwnedRunRoot(runRoot, suiteReportsRoot);
  fs.rmSync(validatedPath, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 });
}

function capLog(text) {
  if (text.length <= MAX_LOG_CHARS) {
    return text;
  }
  return `[earlier output omitted; retained last ${MAX_LOG_CHARS} characters]\n${text.slice(-MAX_LOG_CHARS)}`;
}

function makeCombinedFailure(primaryError, secondaryErrors) {
  const details = [];
  if (primaryError) {
    details.push(`Runner failed: ${primaryError.message || String(primaryError)}`);
  }
  for (const error of secondaryErrors) {
    details.push(`Cleanup or log write failed: ${error.message || String(error)}`);
  }
  const combined = new Error(details.join('\n'));
  combined.cause = primaryError || secondaryErrors[0];
  combined.primaryError = primaryError;
  combined.secondaryErrors = secondaryErrors;
  combined.exitCode = primaryError && Number.isInteger(primaryError.exitCode) ? primaryError.exitCode : 1;
  return combined;
}

function runTargetedCompareMergeTests(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, '..'));
  const suiteReportsRoot = path.join(projectRoot, 'suite-reports');
  const logPath = path.join(suiteReportsRoot, 'compare-merge-targeted.log');
  const runProcess = options.spawnSyncImpl || spawnSync;
  const cleanup = options.cleanupImpl || cleanupOwnedRunRoot;
  const output = options.outputSink || { stdout: process.stdout, stderr: process.stderr };
  const logParts = [
    'Targeted Compare & Merge run (' + SUITE_COUNT + ' suites)',
    'Compare & Merge suites: ' + SUITES.join(', '),
    'Additional suites: ' + ADDITIONAL_SUITE_FILES.join(', '),
  ];

  let runRoot;
  let primaryError;
  const secondaryErrors = [];

  try {
    fs.mkdirSync(suiteReportsRoot, { recursive: true });
    runRoot = fs.mkdtempSync(path.join(suiteReportsRoot, RUN_ROOT_PREFIX));
    const buildRoot = path.join(runRoot, 'build');
    const fixturesTempRoot = path.join(runRoot, 'fixtures-temp');
    fs.mkdirSync(fixturesTempRoot, { recursive: true });
    const compilerConfigPath = path.join(runRoot, 'tsconfig.json');
    const compilerConfig = {
      extends: path.join(projectRoot, 'tsconfig.test.json'),
      compilerOptions: { outDir: buildRoot },
      include: [
        path.join(projectRoot, 'test', 'helpers', 'vscodeStubRegister.ts'),
        ...ADDITIONAL_SUITE_FILES.map((suiteFile) => path.join(projectRoot, suiteFile)),
        ...SUITES.map((suite) => path.join(projectRoot, 'test', 'suite', 'compareMerge', `${suite}.test.ts`)),
      ],
    };
    fs.writeFileSync(compilerConfigPath, `${JSON.stringify(compilerConfig, null, 2)}\n`, 'utf8');

    const typescriptCli = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    runStep('TypeScript compile', [typescriptCli, '-p', compilerConfigPath], COMPILE_TIMEOUT_MS, fixturesTempRoot);

    const mochaCli = path.join(projectRoot, 'node_modules', 'mocha', 'bin', 'mocha.js');
    const helperPath = path.join(buildRoot, 'test', 'helpers', 'vscodeStubRegister.js');
    const suitePaths = [
      ...SUITES.map((suite) => path.join(buildRoot, 'test', 'suite', 'compareMerge', `${suite}.test.js`)),
      ...ADDITIONAL_SUITE_FILES.map((suiteFile) => path.join(buildRoot, suiteFile.slice(0, -3) + '.js')),
    ];
    runStep('Targeted Mocha suites', [
      mochaCli,
      '--ui',
      'tdd',
      '--reporter',
      'dot',
      '--timeout',
      String(MOCHA_CASE_TIMEOUT_MS),
      '--require',
      helperPath,
      ...suitePaths,
    ], MOCHA_TIMEOUT_MS, fixturesTempRoot);
  } catch (error) {
    primaryError = error;
    const message = error && error.stack ? error.stack : String(error);
    logParts.push(`Runner error: ${message}`);
    output.stderr.write(`${message}\n`);
  } finally {
    if (runRoot) {
      try {
        cleanup(runRoot, suiteReportsRoot);
        logParts.push('Owned build directory removed.');
      } catch (error) {
        secondaryErrors.push(error);
      }
    }

    try {
      fs.writeFileSync(logPath, `${capLog(logParts.join('\n\n'))}\n`, 'utf8');
    } catch (error) {
      secondaryErrors.push(error);
    }
  }

  if (secondaryErrors.length > 0) {
    throw makeCombinedFailure(primaryError, secondaryErrors);
  }
  return primaryError ? (Number.isInteger(primaryError.exitCode) ? primaryError.exitCode : 1) : 0;

  function runStep(label, args, timeoutMs, fixturesTempRoot) {
    logParts.push(`=== ${label} ===`);
    const result = runProcess(process.execPath, args, {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      env: {
        ...process.env,
        TEMP: fixturesTempRoot,
        TMP: fixturesTempRoot,
        TMPDIR: fixturesTempRoot,
      },
      windowsHide: true,
    });
    const stdout = result && result.stdout ? String(result.stdout) : '';
    const stderr = result && result.stderr ? String(result.stderr) : '';
    if (stdout) {
      output.stdout.write(stdout);
      logParts.push(stdout);
    }
    if (stderr) {
      output.stderr.write(stderr);
      logParts.push(stderr);
    }
    if (result && result.error) {
      const message = result.error.message || String(result.error);
      const failure = result.error.code === 'ETIMEDOUT'
        ? new Error(`${label} exceeded its ${timeoutMs} ms timeout.`)
        : new Error(`${label} could not start: ${message}`);
      failure.cause = result.error;
      failure.exitCode = 1;
      throw failure;
    }

    const status = result && Number.isInteger(result.status) ? result.status : 1;
    logParts.push(`Exit code: ${status}`);
    if (status !== 0) {
      const failure = new Error(`${label} failed with exit code ${status}.`);
      failure.exitCode = status;
      throw failure;
    }
  }
}

if (require.main === module) {
  try {
    process.exitCode = runTargetedCompareMergeTests();
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = error && Number.isInteger(error.exitCode) ? error.exitCode : 1;
  }
}

module.exports = { runTargetedCompareMergeTests };
