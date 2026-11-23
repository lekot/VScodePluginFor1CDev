'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTargetedCompareMergeTests } = require('./run-compare-merge-tests.cjs');

function createFixture() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-merge-runner-lifecycle-'));
  return { projectRoot, suiteReportsRoot: path.join(projectRoot, 'suite-reports') };
}

function createOutputSink() {
  const output = { stdout: '', stderr: '' };
  return {
    output,
    sink: {
      stdout: { write: (text) => { output.stdout += text; } },
      stderr: { write: (text) => { output.stderr += text; } },
    },
  };
}

function fakeProcess({ compileStatus = 0, mochaStatus = 0, spawnErrorAt } = {}) {
  const calls = [];
  let compilerConfig;
  let runRoot;
  const spawnSyncImpl = (command, args, options) => {
    assert.equal(command, process.execPath);
    calls.push({ args, options });
    if (args[0].endsWith(`${path.sep}tsc`)) {
      compilerConfig = JSON.parse(fs.readFileSync(args[2], 'utf8'));
      runRoot = path.dirname(args[2]);
      return {
        ...(spawnErrorAt === 'compile' ? { error: Object.assign(new Error('synthetic ENOENT'), { code: 'ENOENT' }) } : {}),
        status: compileStatus,
        stdout: compileStatus === 0 ? 'synthetic compile success\n' : 'synthetic compile failure\n',
        stderr: '',
      };
    }
    assert.ok(args[0].endsWith(`${path.sep}mocha.js`), `unexpected executable: ${args[0]}`);
    return {
      ...(spawnErrorAt === 'mocha' ? { error: Object.assign(new Error('synthetic spawn EACCES'), { code: 'EACCES' }) } : {}),
      status: mochaStatus,
      stdout: mochaStatus === 0 ? 'synthetic Mocha success\n' : 'synthetic Mocha failure\n',
      stderr: '',
    };
  };
  return { calls, spawnSyncImpl, get compilerConfig() { return compilerConfig; }, get runRoot() { return runRoot; } };
}

function verifyCompilerConfig(config, fixture) {
  assert.equal(config.extends, path.join(fixture.projectRoot, 'tsconfig.test.json'));
  assert.equal(path.basename(config.compilerOptions.outDir), 'build');
  assert.ok(config.compilerOptions.outDir.startsWith(fixture.suiteReportsRoot));
  assert.equal(config.include.length, 18, 'helper plus 17 targeted suites should compile together');
  assert.ok(config.include.every((file) => path.isAbsolute(file)));
  assert.ok(config.include.some((file) => file.endsWith(`${path.sep}capturedFileWrite.test.ts`)));
  assert.ok(!config.include.some((file) => file.endsWith(`${path.sep}extensionCompare.test.ts`)));
}

function verifyMochaArgs(call, buildRoot) {
  const args = call.args;
  assert.deepEqual(args.slice(1, 5), ['--ui', 'tdd', '--reporter', 'dot']);
  const requireIndex = args.indexOf('--require');
  assert.ok(requireIndex > 0);
  const helperPath = args[requireIndex + 1];
  assert.equal(helperPath, path.join(buildRoot, 'test', 'helpers', 'vscodeStubRegister.js'));
  const suites = args.slice(requireIndex + 2);
  assert.equal(suites.length, 17);
  assert.ok(suites.every((file) => path.relative(buildRoot, file).startsWith(`test${path.sep}suite${path.sep}compareMerge${path.sep}`)));
}

function verifyRunRootWasRemoved(fake) {
  assert.ok(fake.runRoot);
  assert.ok(path.basename(fake.runRoot).startsWith('.tmp-compare-merge-run-'));
  assert.equal(fs.existsSync(fake.runRoot), false, 'the runner must remove its own build tree');
}

function runSuccessScenario() {
  const fixture = createFixture();
  fs.mkdirSync(path.join(fixture.suiteReportsRoot, 'unowned-results', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(fixture.suiteReportsRoot, 'unowned-results', 'nested', 'keep.txt'), 'keep');
  const fake = fakeProcess();
  const output = createOutputSink();
  try {
    assert.equal(runTargetedCompareMergeTests({
      projectRoot: fixture.projectRoot,
      spawnSyncImpl: fake.spawnSyncImpl,
      outputSink: output.sink,
    }), 0);
    assert.equal(fake.calls.length, 2);
    verifyCompilerConfig(fake.compilerConfig, fixture);
    verifyMochaArgs(fake.calls[1], fake.compilerConfig.compilerOptions.outDir);
    verifyRunRootWasRemoved(fake);
    assert.equal(fs.readFileSync(path.join(fixture.suiteReportsRoot, 'unowned-results', 'nested', 'keep.txt'), 'utf8'), 'keep', 'cleanup must preserve unrelated sibling files and directories');
    const log = fs.readFileSync(path.join(fixture.suiteReportsRoot, 'compare-merge-targeted.log'), 'utf8');
    assert.match(log, /synthetic Mocha success/u);
    assert.match(log, /Owned build directory removed/u);
  } finally {
    fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
}

function runSpawnFailureScenario(stage, expectedCalls, diagnostic) {
  const fixture = createFixture();
  const fake = fakeProcess({ spawnErrorAt: stage });
  const output = createOutputSink();
  try {
    assert.equal(runTargetedCompareMergeTests({
      projectRoot: fixture.projectRoot,
      spawnSyncImpl: fake.spawnSyncImpl,
      outputSink: output.sink,
    }), 1);
    assert.equal(fake.calls.length, expectedCalls);
    verifyRunRootWasRemoved(fake);
    assert.match(output.output.stderr, new RegExp(diagnostic, 'u'));
    const log = fs.readFileSync(path.join(fixture.suiteReportsRoot, 'compare-merge-targeted.log'), 'utf8');
    assert.match(log, new RegExp(diagnostic, 'u'));
    assert.match(log, /Owned build directory removed/u);
  } finally {
    fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
}

function runCompileFailureScenario() {
  const fixture = createFixture();
  const fake = fakeProcess({ compileStatus: 9 });
  try {
    assert.equal(runTargetedCompareMergeTests({
      projectRoot: fixture.projectRoot,
      spawnSyncImpl: fake.spawnSyncImpl,
      outputSink: createOutputSink().sink,
    }), 9);
    assert.equal(fake.calls.length, 1, 'Mocha must not run after a failed compile');
    verifyRunRootWasRemoved(fake);
    const log = fs.readFileSync(path.join(fixture.suiteReportsRoot, 'compare-merge-targeted.log'), 'utf8');
    assert.match(log, /synthetic compile failure/u);
    assert.match(log, /Exit code: 9/u);
  } finally {
    fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
}

function runMochaFailureScenario() {
  const fixture = createFixture();
  const fake = fakeProcess({ mochaStatus: 7 });
  try {
    assert.equal(runTargetedCompareMergeTests({
      projectRoot: fixture.projectRoot,
      spawnSyncImpl: fake.spawnSyncImpl,
      outputSink: createOutputSink().sink,
    }), 7);
    assert.equal(fake.calls.length, 2);
    verifyRunRootWasRemoved(fake);
    const log = fs.readFileSync(path.join(fixture.suiteReportsRoot, 'compare-merge-targeted.log'), 'utf8');
    assert.match(log, /synthetic Mocha failure/u);
    assert.match(log, /Exit code: 7/u);
  } finally {
    fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
}

function runCombinedFailureScenario() {
  const fixture = createFixture();
  const fake = fakeProcess({ mochaStatus: 7 });
  let failedRunRoot;
  try {
    assert.throws(() => runTargetedCompareMergeTests({
      projectRoot: fixture.projectRoot,
      spawnSyncImpl: fake.spawnSyncImpl,
      outputSink: createOutputSink().sink,
      cleanupImpl: (runRoot) => {
        failedRunRoot = runRoot;
        throw new Error('synthetic cleanup failure');
      },
    }), (error) => {
      assert.match(error.message, /Targeted Mocha suites failed with exit code 7/u);
      assert.match(error.message, /synthetic cleanup failure/u);
      assert.equal(error.primaryError.exitCode, 7);
      assert.equal(error.secondaryErrors.length, 1);
      return true;
    });
    assert.ok(failedRunRoot && fs.existsSync(failedRunRoot));
  } finally {
    fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
}

runSuccessScenario();
runCompileFailureScenario();
runMochaFailureScenario();
runSpawnFailureScenario('compile', 1, 'TypeScript compile could not start: synthetic ENOENT');
runSpawnFailureScenario('mocha', 2, 'Targeted Mocha suites could not start: synthetic spawn EACCES');
runCombinedFailureScenario();
process.stdout.write('Compare & Merge targeted runner lifecycle scenarios passed.\n');
