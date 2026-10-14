import * as assert from 'assert';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const legacyPrefixes = [
  '1cviewer-',
  '1cv-deploy-',
  '1cv-ibcmd-',
  '1cv-ib-compare-',
  'ibcmd-',
  'p7b4-test-',
  'cdt-bridge-test-',
  'form-engine-save-',
];

interface AuditRoot {
  root: string;
  tempRoot: string;
  ownerToken: string;
}

interface RunningPeer {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  ready: Promise<void>;
}

function assertDescendant(rootPath: string, candidatePath: string): void {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  assert.notStrictEqual(relativePath, '', `${candidatePath} must be below ${rootPath}`);
  assert.notStrictEqual(relativePath, '..', `${candidatePath} must be below ${rootPath}`);
  assert.ok(!relativePath.startsWith(`..${path.sep}`), `${candidatePath} escaped ${rootPath}`);
  assert.ok(!path.isAbsolute(relativePath), `${candidatePath} escaped ${rootPath}`);
}

function createAuditRoot(): AuditRoot {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c1v-cleanup-audit-'));
  const tempRoot = path.join(root, 'isolated-temp');
  const ownerToken = `audit-owner-${Date.now()}-${Math.random()}`;
  fs.mkdirSync(tempRoot);
  fs.writeFileSync(path.join(root, '.audit-owner'), ownerToken, 'utf8');
  assertDescendant(root, tempRoot);
  return { root, tempRoot, ownerToken };
}

function removeAuditRoot(audit: AuditRoot): void {
  const resolvedRoot = path.resolve(audit.root);
  const relativePath = path.relative(path.resolve(os.tmpdir()), resolvedRoot);
  assert.notStrictEqual(relativePath, '', 'refusing to remove the system temp root');
  assert.notStrictEqual(relativePath, '..', 'audit root escaped the system temp root');
  assert.ok(!relativePath.startsWith(`..${path.sep}`), 'audit root escaped the system temp root');
  assert.ok(!path.isAbsolute(relativePath), 'audit root escaped the system temp root');
  assert.strictEqual(
    fs.readFileSync(path.join(resolvedRoot, '.audit-owner'), 'utf8'),
    audit.ownerToken,
    'audit root ownership marker changed'
  );
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}

function createIsolatedEnvironment(audit: AuditRoot, extras: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  assertDescendant(audit.root, audit.tempRoot);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extras,
    TMP: audit.tempRoot,
    TEMP: audit.tempRoot,
    TMPDIR: audit.tempRoot,
  };
  for (const key of ['TMP', 'TEMP', 'TMPDIR']) {
    assert.strictEqual(path.resolve(env[key] ?? ''), path.resolve(audit.tempRoot));
    assertDescendant(audit.root, env[key] as string);
  }
  return env;
}

function createCandidateDirectory(tempRoot: string, name: string): string {
  const directoryPath = path.join(tempRoot, name);
  assertDescendant(tempRoot, directoryPath);
  fs.mkdirSync(directoryPath);
  fs.writeFileSync(path.join(directoryPath, 'owner-sentinel.txt'), `sentinel:${name}`, 'utf8');
  return directoryPath;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function startPeer(
  audit: AuditRoot,
  cwd: string,
  heartbeatPath: string,
  holdOpenFile: boolean
): RunningPeer {
  assertDescendant(audit.root, cwd);
  assertDescendant(audit.tempRoot, path.dirname(heartbeatPath));

  const source = [
    "const fs = require('fs');",
    'const heartbeatPath = process.env.CLEANUP_AUDIT_HEARTBEAT;',
    'const holdOpenFile = process.env.CLEANUP_AUDIT_HOLD_OPEN === "1";',
    'fs.writeFileSync(heartbeatPath, "started\\n");',
    'const fd = holdOpenFile ? fs.openSync(heartbeatPath, "a") : undefined;',
    'let count = 0;',
    'const tick = () => {',
    '  const line = `${Date.now()} ${++count}\\n`;',
    '  try { if (fd === undefined) fs.appendFileSync(heartbeatPath, line); else fs.writeSync(fd, line); } catch {}',
    '};',
    'tick();',
    'const timer = setInterval(tick, 20);',
    'console.log("READY");',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (data) => {',
    '  if (!data.includes("stop")) return;',
    '  clearInterval(timer);',
    '  if (fd !== undefined) fs.closeSync(fd);',
    '  console.log("STOPPED");',
    '  process.stdin.pause();',
    '});',
  ].join('\n');

  const child = spawn(process.execPath, ['-e', source], {
    cwd,
    env: createIsolatedEnvironment(audit, {
      CLEANUP_AUDIT_HEARTBEAT: heartbeatPath,
      CLEANUP_AUDIT_HOLD_OPEN: holdOpenFile ? '1' : '0',
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const peer: RunningPeer = {
    child,
    stdout: '',
    stderr: '',
    exit: new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }),
    ready: Promise.resolve(),
  };

  peer.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`peer did not start: ${peer.stderr}`)), 5000);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      peer.stdout += chunk.toString();
      if (peer.stdout.split(/\r?\n/).includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      peer.stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (peer.stdout.split(/\r?\n/).includes('READY')) return;
      clearTimeout(timer);
      reject(new Error(`peer exited before ready (${code}, ${signal}): ${peer.stderr}`));
    });
  });

  return peer;
}

async function stopPeer(peer: RunningPeer): Promise<void> {
  if (peer.child.exitCode === null && peer.child.signalCode === null) {
    peer.child.stdin?.end('stop\n');
  }
  const result = await peer.exit;
  assert.strictEqual(result.signal, null, 'owned audit peer should stop through its stdin protocol');
}

function readIfPresent(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function runBatch(batchPath: string, env: NodeJS.ProcessEnv, cwd: string) {
  const commandProcessor = env.ComSpec ?? process.env.ComSpec ?? 'cmd.exe';
  const relativeBatchPath = path.relative(cwd, batchPath).replace(/\//g, '\\');
  return spawnSync(commandProcessor, ['/d', '/c', relativeBatchPath], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
}

interface BatchFixture {
  root: string;
  testSuitePath: string;
  instrumentSmokePath: string;
}

function createBatchFixture(audit: AuditRoot, repoRoot: string): BatchFixture {
  const root = path.join(audit.root, 'batch-fixture');
  const scriptsDirectory = path.join(root, 'scripts');
  const testFixturesDirectory = path.join(root, 'test', 'fixtures');
  const outputFixturesDirectory = path.join(root, 'out', 'test', 'fixtures');
  const compilerDirectory = path.join(root, 'node_modules', 'typescript', 'bin');
  const reportsDirectory = path.join(root, 'suite-reports');
  for (const directoryPath of [
    scriptsDirectory,
    testFixturesDirectory,
    outputFixturesDirectory,
    compilerDirectory,
    reportsDirectory,
  ]) {
    assertDescendant(audit.root, directoryPath);
    fs.mkdirSync(directoryPath, { recursive: true });
  }

  for (const relativePath of [
    'test-suite.bat',
    'scripts/instrument-smoke.bat',
    'scripts/cleanup-1cviewer-temp.bat',
    'scripts/cleanup-1cviewer-temp.js',
  ]) {
    const destinationPath = path.join(root, relativePath);
    assertDescendant(audit.root, destinationPath);
    fs.copyFileSync(path.join(repoRoot, relativePath), destinationPath);
  }

  fs.writeFileSync(path.join(testFixturesDirectory, 'fixture-sentinel.txt'), 'isolated fixture', 'utf8');
  fs.writeFileSync(
    path.join(scriptsDirectory, 'copy-webviews.js'),
    '// Isolated no-op for the batch runner fixture.\n',
    'utf8'
  );

  return {
    root,
    testSuitePath: path.join(root, 'test-suite.bat'),
    instrumentSmokePath: path.join(scriptsDirectory, 'instrument-smoke.bat'),
  };
}

function createBatchRunnerShim(
  audit: AuditRoot,
  fixture: BatchFixture
): { env: NodeJS.ProcessEnv; nodeLogPath: string; npmLogPath: string } {
  const shimDirectory = path.join(audit.root, 'fake-bin');
  const nodeLogPath = path.join(audit.root, 'fake-node.log');
  const npmLogPath = path.join(audit.root, 'fake-npm.log');
  const nodeInterceptorPath = path.join(audit.root, 'node-intercept.cjs');
  const matrixReportPath = path.join(fixture.root, 'suite-reports', 'instrument-matrix.json');
  const smokeReportPath = path.join(fixture.root, 'suite-reports', 'instrument-vscode-smoke.json');
  const coreReportPath = path.join(fixture.root, 'suite-reports', 'core.json');
  assertDescendant(audit.root, shimDirectory);
  assertDescendant(audit.root, nodeLogPath);
  assertDescendant(audit.root, npmLogPath);
  assertDescendant(audit.root, nodeInterceptorPath);
  for (const reportPath of [matrixReportPath, smokeReportPath, coreReportPath]) {
    assertDescendant(audit.root, reportPath);
  }
  fs.mkdirSync(shimDirectory);
  fs.writeFileSync(
    nodeInterceptorPath,
    [
      "const fs = require('fs');",
      'const target = process.argv[1] || "";',
      `fs.appendFileSync(${JSON.stringify(nodeLogPath)}, process.argv.slice(1).join(" ") + "\\n");`,
      'if (/runCore\\.js$/i.test(target)) process.exit(37);',
      'if (/cleanup-1cviewer-temp\\.js$/i.test(target)) process.exit(0);',
      'if (/typescript[\\\\/]bin[\\\\/]tsc(?:\\.js)?$/i.test(target)) process.exit(0);',
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(shimDirectory, 'npm.cmd'),
    '@echo off\r\n>>"%CLEANUP_AUDIT_NPM_LOG%" echo %*\r\nexit /b 0\r\n',
    'utf8'
  );

  const env = createIsolatedEnvironment(audit, {
    CLEANUP_AUDIT_NODE_LOG: nodeLogPath,
    CLEANUP_AUDIT_NPM_LOG: npmLogPath,
    NODE_OPTIONS: `--require="${nodeInterceptorPath.replace(/\\/g, '/')}"`,
    PATH: `${shimDirectory};${process.env.PATH ?? ''}`,
    MATRIX_REPORT_PATH: matrixReportPath,
    SUITE_REPORT_PATH_SMOKE: smokeReportPath,
    SUITE_REPORT_PATH_CORE: coreReportPath,
    INSTRUMENT_MATRIX_WORK_DIR: '',
    MATRIX_WORK_DIR: '',
  });
  assertDescendant(audit.root, env.CLEANUP_AUDIT_NODE_LOG as string);
  assertDescendant(audit.root, env.CLEANUP_AUDIT_NPM_LOG as string);
  assertDescendant(audit.root, nodeInterceptorPath);
  assertDescendant(audit.root, shimDirectory);
  return { env, nodeLogPath, npmLogPath };
}

suite('Global TEMP cleanup retirement', () => {
  test('standalone cleanup leaves every isolated candidate and live peer untouched', async () => {
    const audit = createAuditRoot();
    const peers: RunningPeer[] = [];
    try {
      const peerCwd = path.join(audit.root, 'peer-one-cwd');
      fs.mkdirSync(peerCwd);
      assertDescendant(audit.root, peerCwd);

      const directorySuffixes = [
        'live-peer',
        'finished-run',
        'owned-looking-run',
        'history',
        'unowned-resource',
        'unknown-owner',
        'stale-resource',
        'old-successful-run',
      ];
      const directoryNames = legacyPrefixes.map(
        (prefix, index) => `${prefix}${directorySuffixes[index]}`
      );
      const candidateDirectories = directoryNames.map((name) =>
        createCandidateDirectory(audit.tempRoot, name)
      );
      const yamlPath = path.join(audit.tempRoot, '1cviewer-ibcmd-old-run.yaml');
      const yamlContents = 'owner: unknown\nkeep: true\n';
      assertDescendant(audit.tempRoot, yamlPath);
      fs.writeFileSync(yamlPath, yamlContents, 'utf8');

      const livePeerDirectory = path.join(audit.tempRoot, '1cviewer-live-peer');
      const cwdLockDirectory = path.join(audit.tempRoot, '1cv-ibcmd-owned-looking-run');
      const peerOneHeartbeat = path.join(livePeerDirectory, 'heartbeat.log');
      const peerTwoHeartbeat = path.join(cwdLockDirectory, 'open-heartbeat.log');
      const peerOne = startPeer(audit, peerCwd, peerOneHeartbeat, false);
      peers.push(peerOne);
      const peerTwo = startPeer(audit, cwdLockDirectory, peerTwoHeartbeat, true);
      peers.push(peerTwo);
      await Promise.all(peers.map((peer) => peer.ready));
      await delay(100);

      const heartbeatBefore = [
        readIfPresent(peerOneHeartbeat),
        readIfPresent(peerTwoHeartbeat),
      ];
      const scriptPath = path.resolve(process.cwd(), 'scripts/cleanup-1cviewer-temp.js');
      const cleanup = spawnSync(process.execPath, [scriptPath, '--audit-root', audit.root], {
        cwd: process.cwd(),
        env: createIsolatedEnvironment(audit),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
      });
      await delay(100);

      const missingPaths = [
        ...candidateDirectories,
        yamlPath,
        peerOneHeartbeat,
        peerTwoHeartbeat,
      ].filter((candidatePath) => !fs.existsSync(candidatePath));
      assert.deepStrictEqual(
        missingPaths,
        [],
        `cleanup removed isolated resources: ${missingPaths.join(', ')}; exit=${cleanup.status}; stdout=${JSON.stringify(cleanup.stdout)}; stderr=${JSON.stringify(cleanup.stderr)}`
      );
      assert.strictEqual(fs.readFileSync(yamlPath, 'utf8'), yamlContents);
      assert.ok(peers.every((peer) => peer.child.exitCode === null && peer.child.signalCode === null),
        'both child runners must still be alive after standalone cleanup');
      assert.notStrictEqual(readIfPresent(peerOneHeartbeat), heartbeatBefore[0]);
      assert.notStrictEqual(readIfPresent(peerTwoHeartbeat), heartbeatBefore[1]);
      assert.strictEqual(cleanup.status, 0, `cleanup failed: ${cleanup.stderr}`);
      assert.match(cleanup.stdout, /Глобальная очистка TEMP отключена/);
      assert.doesNotMatch(cleanup.stdout, /cleanup:\s*removed/i);
    } finally {
      await Promise.all(peers.map((peer) => stopPeer(peer)));
      removeAuditRoot(audit);
    }
  });

  test('legacy cleanup is absent from automatic batch entrypoints', () => {
    const repoRoot = path.resolve(process.cwd());
    for (const relativePath of ['test-suite.bat', 'scripts/instrument-smoke.bat']) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      assert.doesNotMatch(source, /cleanup-1cviewer-temp\.(?:js|bat)/i, `${relativePath} must not run global cleanup`);
    }

    const cleanupSource = fs.readFileSync(path.join(repoRoot, 'scripts/cleanup-1cviewer-temp.js'), 'utf8');
    assert.doesNotMatch(cleanupSource, /os\.tmpdir|readdirSync|rmSync|unlinkSync|rmdirSync/);
  });

  test('standalone batch wrapper safely forwards to the compatibility no-op', () => {
    const audit = createAuditRoot();
    try {
      const repoRoot = path.resolve(process.cwd());
      const candidate = createCandidateDirectory(audit.tempRoot, '1cviewer-standalone-bat');
      const wrapper = runBatch(
        path.join(repoRoot, 'scripts/cleanup-1cviewer-temp.bat'),
        createIsolatedEnvironment(audit),
        repoRoot
      );

      assert.ifError(wrapper.error ?? undefined);
      assert.strictEqual(wrapper.status, 0, `standalone wrapper exit code changed: ${wrapper.stderr}`);
      assert.match(wrapper.stdout, /Глобальная очистка TEMP отключена/);
      assert.strictEqual(
        fs.readFileSync(path.join(candidate, 'owner-sentinel.txt'), 'utf8'),
        'sentinel:1cviewer-standalone-bat'
      );
    } finally {
      removeAuditRoot(audit);
    }
  });

  test('batch test runners keep their existing failure exit contracts with fake runners', () => {
    if (process.platform !== 'win32') {
      return;
    }

    const audit = createAuditRoot();
    try {
      const repoRoot = path.resolve(process.cwd());
      const fixture = createBatchFixture(audit, repoRoot);
      const { env, nodeLogPath, npmLogPath } = createBatchRunnerShim(audit, fixture);
      const testSuite = runBatch(fixture.testSuitePath, env, fixture.root);
      assert.ifError(testSuite.error ?? undefined);
      assert.strictEqual(testSuite.status, 37, `test-suite failure exit code changed: ${testSuite.stdout}\n${testSuite.stderr}`);
      assert.match(fs.readFileSync(nodeLogPath, 'utf8'), /runCore\.js/i, 'fake core runner was not reached');

      fs.writeFileSync(nodeLogPath, '', 'utf8');
      fs.writeFileSync(npmLogPath, '', 'utf8');
      const instrumentSmoke = runBatch(fixture.instrumentSmokePath, env, fixture.root);
      assert.ifError(instrumentSmoke.error ?? undefined);
      assert.strictEqual(
        instrumentSmoke.status,
        1,
        `instrument-smoke failure exit code changed: ${instrumentSmoke.stdout}\n${instrumentSmoke.stderr}`
      );
      assert.match(fs.readFileSync(nodeLogPath, 'utf8'), /runCore\.js/i, 'fake core runner was not reached');
      assert.match(fs.readFileSync(npmLogPath, 'utf8'), /run compile/i, 'fake npm compile step was not reached');
      assert.match(
        fs.readFileSync(npmLogPath, 'utf8'),
        /copy:test-fixtures/i,
        'fake npm fixture copy step was not reached'
      );
    } finally {
      removeAuditRoot(audit);
    }
  });
});
