#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');
const inspector = require('inspector');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_HEAD = 'd639ef1d77aeca2ea67cd5f427aed228898bcf59';
const BASELINE_PREFIX = '.tmp-merger-baseline-';
const BASELINE_OWNER = 'manifest_engine_code';
const DUPLICATE_PATH = path.join(os.tmpdir(), '1cviewer-d639-baseline-manifest');
const MAX_HEAP_MB = 768;
const MAX_RSS_BYTES = 1024 * 1024 * 1024;
const MAX_WALL_MS = 180_000;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.registerDuplicate) {
    registerOwnedDuplicate(options.registerDuplicate);
    process.stdout.write(JSON.stringify({ status: 'registered', path: options.registerDuplicate }) + '\n');
    return;
  }
  if (options.cleanupDuplicate) {
    cleanupOwnedDuplicate(options.cleanupDuplicate);
    process.stdout.write(JSON.stringify({ status: 'cleaned', path: options.cleanupDuplicate }) + '\n');
    return;
  }
  if (options.cleanupBaseline) {
    cleanupOwnedBaseline(options.cleanupBaseline);
    process.stdout.write(JSON.stringify({ status: 'cleaned', path: options.cleanupBaseline }) + '\n');
    return;
  }
  if (options.worker) {
    await runWorker(options);
    return;
  }
  await runBenchmark(options);
}

async function runBenchmark(options) {
  const baselineRoot = options.baselineRoot && validateBaselineRoot(options.baselineRoot);
  const currentRoot = options.currentRoot && validateBuildRoot(options.currentRoot);
  if (!options.currentOnly && !baselineRoot) {throw new Error('--baseline-root is required unless --current-only is set');}
  if (!options.baselineOnly && !currentRoot) {throw new Error('--current-root is required unless --baseline-only is set');}
  if (options.baselineOnly && options.currentOnly) {throw new Error('--baseline-only and --current-only cannot be combined');}
  const directions = options.direction ? [options.direction] : ['empty-to-uh', 'uh-to-empty'];
  const results = [];
  const startedAt = new Date().toISOString();
  let shouldCleanupBaseline = Boolean(baselineRoot) && !options.currentOnly && !options.keepBaseline && !options.baselineOnly;
  try {
    for (const direction of directions) {
      const pair = rootsForDirection(direction);
      if (!options.currentOnly) {
        results.push(await runBoundedChild({
          buildRoot: baselineRoot,
          buildLabel: 'd639ef1d',
          direction,
          cpuSample: options.cpuSample,
          diagnosticOnly: options.diagnosticOnly,
          ...pair,
        }));
      }
      if (!options.baselineOnly) {
        results.push(await runBoundedChild({
          buildRoot: currentRoot,
          buildLabel: 'current',
          direction,
          cpuSample: options.cpuSample,
          diagnosticOnly: options.diagnosticOnly,
          ...pair,
        }));
      }
    }
  } finally {
    if (shouldCleanupBaseline && baselineRoot) {
      cleanupOwnedBaseline(baselineRoot);
      shouldCleanupBaseline = false;
    }
  }

  const report = {
    schema: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    inputs: {
      baselineHead: options.currentOnly ? null : BASELINE_HEAD,
      emptyConfiguration: path.join(ROOT, 'FormatSamples', 'empty_conf'),
      fullConfiguration: path.join(ROOT, 'FormatSamples', 'uh'),
      maxHeapMiB: MAX_HEAP_MB,
      maxRssBytes: MAX_RSS_BYTES,
      maxWallMs: MAX_WALL_MS,
    },
    baselineCleanup: options.currentOnly ? 'not-used' : shouldCleanupBaseline ? 'retained' : options.baselineOnly || options.keepBaseline ? 'retained-by-option' : 'removed-after-comparison',
    results,
  };
  const reportPath = options.reportPath
    ? path.resolve(options.reportPath)
    : path.join(ROOT, 'suite-reports', `configuration-compare-benchmark-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify({ reportPath, results }) + '\n');
}

async function runBoundedChild(input) {
  const args = [
    `--max-old-space-size=${MAX_HEAP_MB}`,
    __filename,
    '--worker',
    '--build-root', input.buildRoot,
    '--build-label', input.buildLabel,
    '--direction', input.direction,
    '--target-root', input.targetRoot,
    '--source-root', input.sourceRoot,
  ];
  if (input.cpuSample) {args.push('--cpu-sample');}
  if (input.diagnosticOnly) {args.push('--diagnostic-only');}
  const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let pendingStdout = '';
  let stderr = '';
  let lastHeartbeatAt = Date.now();
  let lastHeartbeat;
  const startedAt = Date.now();
  let timedOut = false;
  let rssBudgetExceeded = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, MAX_WALL_MS);
  const heartbeatTimer = setInterval(() => {
    if (Date.now() - lastHeartbeatAt > 45_000) {
      timedOut = true;
      child.kill();
    }
  }, 1000);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    pendingStdout += chunk;
    let newlineIndex;
    while ((newlineIndex = pendingStdout.indexOf('\n')) !== -1) {
      const line = pendingStdout.slice(0, newlineIndex).replace(/\r$/u, '');
      pendingStdout = pendingStdout.slice(newlineIndex + 1);
      if (!line.startsWith('BENCH_HEARTBEAT ')) {continue;}
      lastHeartbeatAt = Date.now();
      try {
        lastHeartbeat = JSON.parse(line.slice('BENCH_HEARTBEAT '.length));
      } catch {
        continue;
      }
      if (lastHeartbeat.rss > MAX_RSS_BYTES && !rssBudgetExceeded) {
        rssBudgetExceeded = true;
        child.kill();
      }
    }
  });
  child.stderr.on('data', (chunk) => {stderr += chunk;});
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(killTimer);
  clearInterval(heartbeatTimer);
  const resultLine = stdout.split(/\r?\n/u).findLast((line) => line.startsWith('BENCH_RESULT '));
  const result = resultLine ? JSON.parse(resultLine.slice('BENCH_RESULT '.length)) : undefined;
  return {
    build: input.buildLabel,
    direction: input.direction,
    exitCode,
    elapsedWallMs: Date.now() - startedAt,
    status: rssBudgetExceeded ? 'rss-budget-exceeded' : timedOut ? 'budget-timeout' : result?.status ?? (isHeapOutOfMemory(stderr) ? 'heap-budget-exceeded' : exitCode === 0 ? 'completed' : 'child-failed'),
    ...(result ? { metrics: result } : {}),
    ...(lastHeartbeat ? { lastHeartbeat } : {}),
    ...(stderr.trim() ? { stderr: stderr.trim().slice(-4000) } : {}),
  };
}

async function runWorker(options) {
  const metrics = {
    status: 'running',
    build: options.buildLabel,
    direction: options.direction,
    targetRoot: options.targetRoot,
    sourceRoot: options.sourceRoot,
    startedAt: new Date().toISOString(),
    readFileCalls: 0,
    fileHandleOpens: 0,
    fileReadOperations: 0,
    bytesRead: 0,
    directoryReadCalls: 0,
    directoryEntriesEnumerated: 0,
    uniqueFilePathsRead: 0,
    filesReadByExtension: {},
    bytesReadByExtension: {},
    phases: [],
    currentPhase: 'detecting',
    projectionCount: 0,
    firstProjectionMs: null,
    maxRssBytes: 0,
    maxHeapUsedBytes: 0,
  };
  const cancellation = { isCancellationRequested: false };
  let workspace;
  const uniquePaths = new Set();
  const started = performance.now();
  let budgetFailure = false;
  let cpuProfilerStarting = false;
  const monitor = setInterval(() => {
    const memory = process.memoryUsage();
    metrics.maxRssBytes = Math.max(metrics.maxRssBytes, memory.rss);
    metrics.maxHeapUsedBytes = Math.max(metrics.maxHeapUsedBytes, memory.heapUsed);
    process.stdout.write(`BENCH_HEARTBEAT ${JSON.stringify({
      rss: memory.rss,
      heapUsedBytes: memory.heapUsed,
      elapsedMs: Math.round(performance.now() - started),
      phase: metrics.currentPhase,
      projectionCount: metrics.projectionCount,
      firstProjectionMs: metrics.firstProjectionMs,
      readFileCalls: metrics.readFileCalls,
      fileHandleOpens: metrics.fileHandleOpens,
      fileReadOperations: metrics.fileReadOperations,
      bytesRead: metrics.bytesRead,
      directoryReadCalls: metrics.directoryReadCalls,
      directoryEntriesEnumerated: metrics.directoryEntriesEnumerated,
      uniqueFilePathsRead: uniquePaths.size,
      filesReadByExtension: metrics.filesReadByExtension,
      bytesReadByExtension: metrics.bytesReadByExtension,
    })}\n`);
    if (memory.rss > MAX_RSS_BYTES) {
      budgetFailure = true;
      cancellation.isCancellationRequested = true;
    }
    if (options.cpuSample && metrics.currentPhase === 'bsl' && !cpuProfilerStarting && !metrics.cpuSample) {
      cpuProfilerStarting = true;
      startBoundedCpuSample({ metrics, cancellation, diagnosticOnly: options.diagnosticOnly })
        .catch((error) => {metrics.cpuSampleError = error instanceof Error ? error.message : String(error);});
    }
  }, 1000);

  try {
    require(path.join(options.buildRoot, 'test', 'helpers', 'vscodeStubRegister.js'));
    instrumentFileReads(metrics, uniquePaths);
    const { buildConfigurationCompare } = require(path.join(options.buildRoot, 'src', 'compareMerge', 'configurationCompareService.js'));
    let lastPhase;
    const result = await buildConfigurationCompare({
      leftRootPath: options.targetRoot,
      rightRootPath: options.sourceRoot,
      backupRootPath: path.join(os.tmpdir(), 'configuration-compare-benchmark-unused-backups'),
      createdAt: new Date('2026-11-23T00:00:00.000Z'),
      cancellation,
      onProgress: (progress) => {
        const elapsedMs = Math.round(performance.now() - started);
        metrics.currentPhase = progress.phase;
        if (progress.phase !== lastPhase) {
          metrics.phases.push({ phase: progress.phase, elapsedMs });
          lastPhase = progress.phase;
        }
        if (progress.projection) {
          metrics.projectionCount += 1;
          if (metrics.firstProjectionMs === null) {metrics.firstProjectionMs = elapsedMs;}
        }
      },
    });
    workspace = result.workspace;
    metrics.status = budgetFailure ? 'rss-budget-exceeded' : 'completed';
    metrics.elapsedMs = Math.round(performance.now() - started);
    metrics.mergeableNodeCount = workspace.listMergeableNodeIds().length;
    metrics.firstProjectionMs ??= metrics.elapsedMs;
    return;
  } catch (error) {
    const diagnosticSampleComplete = options.diagnosticOnly && Boolean(metrics.cpuSample);
    metrics.status = budgetFailure ? 'rss-budget-exceeded' : diagnosticSampleComplete ? 'diagnostic-sample-complete' : 'compare-failed';
    if (!diagnosticSampleComplete) {metrics.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);}
    metrics.elapsedMs = Math.round(performance.now() - started);
  } finally {
    clearInterval(monitor);
    workspace?.dispose();
    metrics.finishedAt = new Date().toISOString();
    metrics.uniqueFilePathsRead = uniquePaths.size;
    process.stdout.write(`BENCH_RESULT ${JSON.stringify(metrics)}\n`);
    if (metrics.status === 'rss-budget-exceeded') {process.exitCode = 86;}
  }
}

async function startBoundedCpuSample(input) {
  const session = new inspector.Session();
  session.connect();
  await postInspector(session, 'Profiler.enable');
  await postInspector(session, 'Profiler.start');
  input.metrics.cpuSampleStartedAt = new Date().toISOString();
  const started = performance.now();
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const result = await postInspector(session, 'Profiler.stop');
  session.disconnect();
  input.metrics.cpuSample = summarizeCpuProfile(result.profile, performance.now() - started);
  if (input.diagnosticOnly) {input.cancellation.isCancellationRequested = true;}
}

function postInspector(session, method) {
  return new Promise((resolve, reject) => {
    session.post(method, (error, result) => error ? reject(error) : resolve(result ?? {}));
  });
}

function summarizeCpuProfile(profile, durationMs) {
  const functionNames = new Map(profile.nodes.map((node) => [node.id, {
    functionName: node.callFrame.functionName || '(anonymous)',
    url: node.callFrame.url || '',
    lineNumber: node.callFrame.lineNumber,
  }]));
  const selfTimeByNode = new Map();
  for (let index = 0; index < profile.samples.length; index += 1) {
    const nodeId = profile.samples[index];
    selfTimeByNode.set(nodeId, (selfTimeByNode.get(nodeId) ?? 0) + (profile.timeDeltas[index] ?? 0));
  }
  return {
    durationMs: Math.round(durationMs),
    topFrames: [...selfTimeByNode]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 20)
      .map(([nodeId, selfMicros]) => ({
        ...functionNames.get(nodeId),
        selfMs: Math.round(selfMicros / 100) / 10,
      })),
  };
}

function isHeapOutOfMemory(stderr) {
  return /(?:allocation failed[^\r\n]*heap out of memory|javascript heap out of memory)/iu.test(stderr);
}

function instrumentFileReads(metrics, uniquePaths) {
  const promises = fs.promises;
  const originalReadFile = promises.readFile.bind(promises);
  const originalOpen = promises.open.bind(promises);
  const originalReaddir = promises.readdir.bind(promises);
  promises.readFile = async (...args) => {
    metrics.readFileCalls += 1;
    recordPath(metrics, uniquePaths, args[0]);
    const result = await originalReadFile(...args);
    recordBytes(metrics, args[0], Buffer.isBuffer(result) ? result.byteLength : Buffer.byteLength(result));
    return result;
  };
  promises.open = async (...args) => {
    metrics.fileHandleOpens += 1;
    const filePath = args[0];
    recordPath(metrics, uniquePaths, filePath);
    const handle = await originalOpen(...args);
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'read') {
          return async (...readArgs) => {
            metrics.fileReadOperations += 1;
            const result = await target.read(...readArgs);
            if (result && typeof result.bytesRead === 'number') {recordBytes(metrics, filePath, result.bytesRead);}
            return result;
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  promises.readdir = async (...args) => {
    metrics.directoryReadCalls += 1;
    const result = await originalReaddir(...args);
    if (Array.isArray(result)) {metrics.directoryEntriesEnumerated += result.length;}
    return result;
  };
}

function recordPath(metrics, uniquePaths, value) {
  const filePath = typeof value === 'string' ? value : value?.toString?.();
  if (!filePath) {return;}
  uniquePaths.add(path.resolve(filePath));
  const extension = path.extname(filePath).toLowerCase() || '<none>';
  metrics.filesReadByExtension[extension] = (metrics.filesReadByExtension[extension] ?? 0) + 1;
}

function recordBytes(metrics, filePath, bytes) {
  metrics.bytesRead += bytes;
  const value = typeof filePath === 'string' ? filePath : filePath?.toString?.();
  const extension = path.extname(value ?? '').toLowerCase() || '<none>';
  metrics.bytesReadByExtension[extension] = (metrics.bytesReadByExtension[extension] ?? 0) + bytes;
}

function rootsForDirection(direction) {
  const empty = path.join(ROOT, 'FormatSamples', 'empty_conf');
  const full = path.join(ROOT, 'FormatSamples', 'uh');
  if (direction === 'empty-to-uh') {return { targetRoot: empty, sourceRoot: full };}
  if (direction === 'uh-to-empty') {return { targetRoot: full, sourceRoot: empty };}
  if (direction === 'uh-to-uh') {return { targetRoot: full, sourceRoot: full };}
  throw new Error(`Unknown direction: ${direction}`);
}

function validateBuildRoot(buildRoot) {
  const resolved = fs.realpathSync(path.resolve(buildRoot));
  for (const child of ['src/compareMerge/configurationCompareService.js', 'test/helpers/vscodeStubRegister.js']) {
    if (!fs.existsSync(path.join(resolved, child))) {throw new Error(`Build root is incomplete: ${child}`);}
  }
  return resolved;
}

function validateBaselineRoot(baselineRoot) {
  const resolved = validateBuildRoot(baselineRoot);
  const reportsRoot = fs.realpathSync(path.join(ROOT, 'suite-reports'));
  if (path.dirname(resolved) !== reportsRoot || !path.basename(resolved).startsWith(BASELINE_PREFIX)) {
    throw new Error(`Baseline root is outside the owned suite-reports prefix: ${resolved}`);
  }
  const owner = readOwner(resolved);
  if (owner.head !== BASELINE_HEAD || owner.purpose !== 'read-only compare benchmark baseline' || owner.cleanupOwner !== BASELINE_OWNER) {
    throw new Error(`Baseline owner marker did not match the expected d639 owner: ${resolved}`);
  }
  return resolved;
}

function cleanupOwnedBaseline(baselineRoot) {
  const validated = validateBaselineRoot(baselineRoot);
  const reportsRoot = fs.realpathSync(path.join(ROOT, 'suite-reports'));
  if (path.dirname(validated) !== reportsRoot || !path.basename(validated).startsWith(BASELINE_PREFIX)) {
    throw new Error(`Refusing to remove a path outside the baseline prefix: ${validated}`);
  }
  fs.rmSync(validated, { recursive: true, force: false });
}

function registerOwnedDuplicate(candidate) {
  const resolved = fs.realpathSync(path.resolve(candidate));
  const expected = path.join(fs.realpathSync.native(os.tmpdir()), path.basename(DUPLICATE_PATH));
  if (!samePath(resolved, expected) || !fs.existsSync(path.join(resolved, 'src', 'compareMerge', 'configurationCompareService.js'))
    || !fs.existsSync(path.join(resolved, 'test', 'helpers', 'vscodeStubRegister.js'))) {
    throw new Error(`Refusing to register an unrecognized duplicate baseline: ${resolved}`);
  }
  const owner = { head: BASELINE_HEAD, purpose: 'temporary duplicate baseline copy', cleanupOwner: BASELINE_OWNER };
  fs.writeFileSync(path.join(resolved, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
}

function cleanupOwnedDuplicate(candidate) {
  const resolved = fs.realpathSync(path.resolve(candidate));
  const expected = path.join(fs.realpathSync.native(os.tmpdir()), path.basename(DUPLICATE_PATH));
  if (!samePath(resolved, expected)) {throw new Error(`Refusing to remove unexpected duplicate path: ${resolved}`);}
  const owner = readOwner(resolved);
  if (owner.head !== BASELINE_HEAD || owner.purpose !== 'temporary duplicate baseline copy' || owner.cleanupOwner !== BASELINE_OWNER) {
    throw new Error(`Duplicate baseline owner marker did not match: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: false });
}

function readOwner(rootPath) {
  return JSON.parse(fs.readFileSync(path.join(rootPath, 'owner.json'), 'utf8'));
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--baseline-only') {options.baselineOnly = true; continue;}
    if (arg === '--current-only') {options.currentOnly = true; continue;}
    if (arg === '--cpu-sample') {options.cpuSample = true; continue;}
    if (arg === '--diagnostic-only') {options.diagnosticOnly = true; continue;}
    if (arg === '--keep-baseline') {options.keepBaseline = true; continue;}
    if (arg === '--worker') {options.worker = true; continue;}
    if (arg === '--register-duplicate') {options.registerDuplicate = args[++index]; continue;}
    if (arg === '--cleanup-duplicate') {options.cleanupDuplicate = args[++index]; continue;}
    if (arg === '--cleanup-baseline') {
      options.cleanupBaseline = args[++index];
      if (!options.cleanupBaseline) {throw new Error('--cleanup-baseline requires a path');}
      continue;
    }
    const key = {
      '--baseline-root': 'baselineRoot',
      '--current-root': 'currentRoot',
      '--direction': 'direction',
      '--report': 'reportPath',
      '--build-root': 'buildRoot',
      '--build-label': 'buildLabel',
      '--target-root': 'targetRoot',
      '--source-root': 'sourceRoot',
    }[arg];
    if (!key) {throw new Error(`Unknown benchmark argument: ${arg}`);}
    options[key] = args[++index];
  }
  return options;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
