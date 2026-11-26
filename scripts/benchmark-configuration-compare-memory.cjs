#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');
const inspector = require('inspector');

const ROOT = path.resolve(__dirname, '..');
const HEAP_LIMIT_MB = 768;
const HEAP_STOP_BYTES = 512 * 1024 * 1024;
const RSS_LIMIT_BYTES = 1024 * 1024 * 1024;
const WALL_LIMIT_MS = 180_000;
const STALL_LIMIT_MS = 45_000;
const HEARTBEAT_INTERVAL_MS = 1_000;
const MEMORY_CHECK_INTERVAL_MS = 250;
const SAMPLING_INTERVAL_BYTES = 262_144;
const MAX_REPORT_BYTES = 128 * 1024;
const MAX_EVENT_LINE_BYTES = 64 * 1024;
const MAX_RECENT_HEARTBEATS = 12;
const MAX_PHASES = 20;
const MAX_TOP_STACKS = 30;

const PROFILED_FILES = [
  'src/compareMerge/metadata/metadataIndexer.js',
  'src/compareMerge/inventory/configurationFileManifest.js',
  'src/compareMerge/inventory/configurationInventory.js',
  'src/compareMerge/configurationCompareService.js',
  'src/compareMerge/compareCancellation.js',
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.worker) {
    await runWorker(options);
    return;
  }
  await runSupervisor(options);
}

function parseArgs(args) {
  const options = {
    buildRoot: path.join(ROOT, 'out'),
    stopAfter: 'manifests',
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--worker') {options.worker = true; continue;}
    const key = {
      '--build-root': 'buildRoot',
      '--report': 'reportPath',
      '--stop-after': 'stopAfter',
    }[arg];
    if (!key) {throw new Error(`Unknown memory diagnostic argument: ${arg}`);}
    const value = args[++index];
    if (!value || value.startsWith('--')) {throw new Error(`${arg} requires a value`);}
    options[key] = value;
  }
  if (!['manifests', 'hydration'].includes(options.stopAfter)) {
    throw new Error('--stop-after must be manifests or hydration');
  }
  return options;
}

async function runSupervisor(options) {
  const buildRoot = validateBuildRoot(options.buildRoot);
  const targetRoot = fs.realpathSync(path.join(ROOT, 'FormatSamples', 'uh'));
  const reportPath = resolveReportPath(options.reportPath);
  const report = {
    schema: 1,
    status: 'starting',
    startedAt: new Date().toISOString(),
    inputs: {
      buildRoot,
      nodeVersion: process.version,
      direction: 'uh-to-uh',
      targetRoot,
      sourceRoot: targetRoot,
      stopAfter: options.stopAfter,
      compiledFiles: fingerprintCompiledFiles(buildRoot),
    },
    limits: {
      maxOldSpaceMiB: HEAP_LIMIT_MB,
      diagnosticHeapStopBytes: HEAP_STOP_BYTES,
      maxRssBytes: RSS_LIMIT_BYTES,
      maxWallMs: WALL_LIMIT_MS,
      maxHeartbeatStallMs: STALL_LIMIT_MS,
      samplingIntervalBytes: SAMPLING_INTERVAL_BYTES,
      maxReportBytes: MAX_REPORT_BYTES,
    },
    preSamplingGc: null,
    trigger: null,
    phases: [],
    stages: [],
    heartbeats: { count: 0, maxRssBytes: 0, maxHeapUsedBytes: 0, recent: [] },
    heapProfile: null,
  };
  persistReport(reportPath, report);
  const childResult = await runBoundedWorker({
    buildRoot,
    targetRoot,
    reportPath,
    stopAfter: options.stopAfter,
    report,
  });
  report.finishedAt = new Date().toISOString();
  report.process = childResult;
  if (!['diagnostic-stopped', 'completed'].includes(childResult.supervisorStatus)) {
    report.status = childResult.supervisorStatus;
  }
  persistReport(reportPath, report);
  process.stdout.write(`${JSON.stringify({ reportPath, status: report.status, process: childResult })}\n`);
  if (report.status === 'worker-failed' || report.status === 'worker-output-over-limit' || report.status === 'heap-budget-exceeded' || report.status === 'rss-budget-exceeded'
    || report.status === 'wall-timeout' || report.status === 'heartbeat-stall' || report.status === 'compare-failed'
    || report.status === 'worker-exited-without-result' || report.status === 'profile-failed') {
    process.exitCode = 1;
  }
}

function validateBuildRoot(buildRoot) {
  const resolved = fs.realpathSync(path.resolve(buildRoot));
  for (const relativePath of [...PROFILED_FILES, 'test/helpers/vscodeStubRegister.js']) {
    const filePath = path.join(resolved, relativePath);
    if (!fs.statSync(filePath).isFile()) {throw new Error(`Compiled build root is incomplete: ${relativePath}`);}
  }
  return resolved;
}

function fingerprintCompiledFiles(buildRoot) {
  return PROFILED_FILES.map((relativePath) => {
    const filePath = path.join(buildRoot, relativePath);
    const stat = fs.statSync(filePath);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    return { path: relativePath.replace(/\\/gu, '/'), sha256: hash, sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
  });
}

function resolveReportPath(requestedPath) {
  const reportsRoot = path.resolve(ROOT, 'suite-reports');
  fs.mkdirSync(reportsRoot, { recursive: true });
  const workspaceRoot = fs.realpathSync(ROOT);
  const resolvedReportsRoot = fs.realpathSync(reportsRoot);
  if (!isPathWithin(workspaceRoot, resolvedReportsRoot)) {
    throw new Error(`suite-reports resolves outside the workspace: ${resolvedReportsRoot}`);
  }
  const candidate = path.resolve(requestedPath || path.join(reportsRoot, `configuration-compare-memory-${Date.now()}.json`));
  const candidateDirectory = path.dirname(candidate);
  if (!samePath(candidateDirectory, reportsRoot)) {
    throw new Error(`Report must be a direct child of suite-reports: ${candidate}`);
  }
  const canonicalDirectory = fs.realpathSync(candidateDirectory);
  if (!samePath(canonicalDirectory, resolvedReportsRoot)) {
    throw new Error(`Report directory resolves outside suite-reports: ${canonicalDirectory}`);
  }
  const safeCandidate = path.join(canonicalDirectory, path.basename(candidate));
  if (fs.existsSync(safeCandidate)) {throw new Error(`Refusing to overwrite an existing diagnostic report: ${safeCandidate}`);}
  return safeCandidate;
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

function isPathWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function runBoundedWorker(input) {
  const args = [
    `--max-old-space-size=${HEAP_LIMIT_MB}`,
    __filename,
    '--worker',
    '--build-root', input.buildRoot,
    '--stop-after', input.stopAfter,
    '--report', input.reportPath,
  ];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const startedAt = Date.now();
  let lastHeartbeatAt = startedAt;
  let pendingStdout = '';
  let stderrTail = '';
  let supervisorStatus = 'worker-failed';
  let timedOut = false;
  let rssExceeded = false;
  let outputExceeded = false;
  let lastHeartbeat;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    pendingStdout += chunk;
    if (Buffer.byteLength(pendingStdout, 'utf8') > MAX_EVENT_LINE_BYTES && !pendingStdout.includes('\n')) {
      outputExceeded = true;
      supervisorStatus = 'worker-output-over-limit';
      input.report.status = supervisorStatus;
      input.report.supervisorStopReason = 'worker-output-line-limit';
      persistReport(input.reportPath, input.report);
      child.kill();
      pendingStdout = '';
      return;
    }
    let newlineIndex;
    while ((newlineIndex = pendingStdout.indexOf('\n')) !== -1) {
      const line = pendingStdout.slice(0, newlineIndex).replace(/\r$/u, '');
      pendingStdout = pendingStdout.slice(newlineIndex + 1);
      if (!line.startsWith('MEMORY_EVENT ')) {continue;}
      if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_LINE_BYTES) {
        outputExceeded = true;
        supervisorStatus = 'worker-output-over-limit';
        input.report.status = supervisorStatus;
        persistReport(input.reportPath, input.report);
        child.kill();
        continue;
      }
      try {
        const event = JSON.parse(line.slice('MEMORY_EVENT '.length));
        handleWorkerEvent(input.report, event);
        if (event.type === 'heartbeat') {
          lastHeartbeat = event;
          lastHeartbeatAt = Date.now();
          if (event.rssBytes > RSS_LIMIT_BYTES && !rssExceeded) {
            rssExceeded = true;
            supervisorStatus = 'rss-budget-exceeded';
            input.report.status = supervisorStatus;
            persistReport(input.reportPath, input.report);
            child.kill();
          }
        }
        persistReport(input.reportPath, input.report);
      } catch (error) {
        input.report.workerEventError = truncateText(error instanceof Error ? error.message : String(error), 500);
        persistReport(input.reportPath, input.report);
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrTail = truncateText(stderrTail + chunk, 4_000, 'tail');
  });

  const wallTimer = setTimeout(() => {
    timedOut = true;
    supervisorStatus = 'wall-timeout';
    input.report.status = supervisorStatus;
    input.report.supervisorStopReason = 'wall-time-limit';
    persistReport(input.reportPath, input.report);
    child.kill();
  }, WALL_LIMIT_MS);
  const heartbeatTimer = setInterval(() => {
    if (Date.now() - lastHeartbeatAt > STALL_LIMIT_MS) {
      timedOut = true;
      supervisorStatus = 'heartbeat-stall';
      input.report.status = supervisorStatus;
      input.report.supervisorStopReason = 'heartbeat-stall-limit';
      persistReport(input.reportPath, input.report);
      child.kill();
    }
  }, 1_000);

  return new Promise((resolve) => {
    let spawnError;
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(wallTimer);
      clearInterval(heartbeatTimer);
      if (!timedOut && !rssExceeded && !outputExceeded) {
        if (isHeapOutOfMemory(stderrTail)) {
          supervisorStatus = 'heap-budget-exceeded';
        } else if (input.report.status === 'diagnostic-stopped' || input.report.status === 'completed') {
          supervisorStatus = input.report.status;
        } else if (exitCode === 0) {
          supervisorStatus = input.report.status === 'starting' || input.report.status === 'running'
            ? 'worker-exited-without-result'
            : input.report.status;
        } else {
          supervisorStatus = 'worker-failed';
        }
      }
      if (spawnError) {stderrTail = truncateText(`${stderrTail}\n${spawnError.message}`, 4_000, 'tail');}
      resolve({
        exitCode,
        signal,
        elapsedWallMs: Date.now() - startedAt,
        supervisorStatus,
        timedOut,
        rssExceeded,
        outputExceeded,
        lastHeartbeat,
        ...(stderrTail ? { stderrTail } : {}),
      });
    });
  });
}

function handleWorkerEvent(report, event) {
  if (event.type === 'status') {
    report.status = event.status;
    return;
  }
  if (event.type === 'stage-start') {
    report.stages.push(event.stage);
    return;
  }
  if (event.type === 'stage-end') {
    const stage = report.stages.find((item) => item.id === event.id);
    if (stage) {Object.assign(stage, event.stage);}
    return;
  }
  if (event.type === 'pre-sampling-gc') {
    report.preSamplingGc = event.result;
    return;
  }
  if (event.type === 'trigger') {
    report.trigger = event.trigger;
    return;
  }
  if (event.type === 'phase') {
    report.currentPhase = event.phase;
    report.phases.push({ phase: event.phase, elapsedMs: event.elapsedMs });
    if (report.phases.length > MAX_PHASES) {report.phases.shift();}
    return;
  }
  if (event.type === 'heartbeat') {
    report.heartbeats.count += 1;
    report.heartbeats.maxRssBytes = Math.max(report.heartbeats.maxRssBytes, event.rssBytes);
    report.heartbeats.maxHeapUsedBytes = Math.max(report.heartbeats.maxHeapUsedBytes, event.heapUsedBytes);
    report.heartbeats.recent.push(event);
    if (report.heartbeats.recent.length > MAX_RECENT_HEARTBEATS) {report.heartbeats.recent.shift();}
    return;
  }
  if (event.type === 'heap-profile') {
    report.heapProfile = event.profile;
    return;
  }
  if (event.type === 'profile-error') {
    report.profileError = event.error;
    return;
  }
  if (event.type === 'worker-result') {
    report.status = event.status;
    report.worker = event.result;
  }
}

function persistReport(reportPath, report) {
  const serialized = serializeBoundedReport(report);
  const temporaryPath = `${reportPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, serialized, 'utf8');
    fs.renameSync(temporaryPath, reportPath);
  } finally {
    if (fs.existsSync(temporaryPath)) {fs.unlinkSync(temporaryPath);}
  }
}

function serializeBoundedReport(report) {
  let serialized = JSON.stringify(report, null, 2) + '\n';
  while (Buffer.byteLength(serialized, 'utf8') > MAX_REPORT_BYTES) {
    if (report.heartbeats?.recent?.length > 2) {
      report.heartbeats.recent.shift();
    } else if (report.heapProfile?.topStacks?.length > 8) {
      report.heapProfile.topStacks.pop();
    } else if (report.phases?.length > 4) {
      report.phases.shift();
    } else {
      report.heapProfile = report.heapProfile ? { ...report.heapProfile, topStacks: [] } : null;
      report.reportCompacted = true;
      serialized = JSON.stringify(report, null, 2) + '\n';
      if (Buffer.byteLength(serialized, 'utf8') > MAX_REPORT_BYTES) {
        throw new Error(`Diagnostic report exceeds ${MAX_REPORT_BYTES} bytes after compaction`);
      }
      return serialized;
    }
    report.reportCompacted = true;
    serialized = JSON.stringify(report, null, 2) + '\n';
  }
  return serialized;
}

async function runWorker(options) {
  const buildRoot = validateBuildRoot(options.buildRoot);
  const targetRoot = fs.realpathSync(path.join(ROOT, 'FormatSamples', 'uh'));
  const started = performance.now();
  const cancellation = { isCancellationRequested: false };
  const manifestSides = new WeakMap();
  const restoreWrappers = [];
  const stageCounts = { manifestCompleted: 0, hydrationCompleted: 0, manifestCall: 0 };
  let trigger;
  let cancellationPromise;
  let profileCapturePromise;
  let session;
  let samplingStarted = false;
  let workspace;
  let currentPhase = 'detecting';
  let stageId = 0;
  let heartbeatTimer;
  let memoryCheckTimer;
  let workerStatus = 'starting';
  let comparisonSettled = false;

  const emit = (event) => process.stdout.write(`MEMORY_EVENT ${JSON.stringify(event)}\n`);
  const captureHeapProfileOnce = () => {
    if (profileCapturePromise) {return profileCapturePromise;}
    if (!samplingStarted || !session) {return Promise.resolve(false);}
    samplingStarted = false;
    profileCapturePromise = postInspector(session, 'HeapProfiler.stopSampling').then((result) => {
      emit({ type: 'heap-profile', profile: summarizeHeapProfile(result.profile) });
      return true;
    }).catch((error) => {
      workerStatus = 'profile-failed';
      emit({ type: 'profile-error', error: truncateText(error instanceof Error ? error.message : String(error), 500) });
      return false;
    });
    return profileCapturePromise;
  };
  const requestCancellation = (reason) => {
    if (cancellationPromise) {return cancellationPromise;}
    trigger = { reason, elapsedMs: Math.round(performance.now() - started), heapUsedBytes: process.memoryUsage().heapUsed };
    emit({ type: 'trigger', trigger });
    cancellationPromise = (async () => {
      await captureHeapProfileOnce();
      cancellation.isCancellationRequested = true;
      if (!comparisonSettled && workerStatus !== 'profile-failed') {workerStatus = 'diagnostic-stopped';}
      emit({ type: 'status', status: workerStatus });
    })();
    return cancellationPromise;
  };

  try {
    require(path.join(buildRoot, 'test', 'helpers', 'vscodeStubRegister.js'));
    installStageWrappers({ buildRoot, targetRoot, manifestSides, stageCounts, restoreWrappers, emit, requestCancellation, stopAfter: options.stopAfter, nextStageId: () => ++stageId, started });
    const { isConfigurationCompareCancelled } = require(path.join(buildRoot, 'src', 'compareMerge', 'compareCancellation.js'));
    const { buildConfigurationCompare } = require(path.join(buildRoot, 'src', 'compareMerge', 'configurationCompareService.js'));
    session = new inspector.Session();
    session.connect();
    await postInspector(session, 'HeapProfiler.enable');
    const gcResult = await collectBeforeSampling(session);
    emit({ type: 'pre-sampling-gc', result: gcResult });
    await postInspector(session, 'HeapProfiler.startSampling', { samplingInterval: SAMPLING_INTERVAL_BYTES });
    samplingStarted = true;
    workerStatus = 'running';
    emit({ type: 'status', status: 'running' });

    const emitHeartbeat = () => {
      const memory = memorySnapshot();
      emit({
        type: 'heartbeat',
        elapsedMs: Math.round(performance.now() - started),
        phase: currentPhase,
        rssBytes: memory.rssBytes,
        heapUsedBytes: memory.heapUsedBytes,
        heapTotalBytes: memory.heapTotalBytes,
        externalBytes: memory.externalBytes,
      });
    };
    emitHeartbeat();
    heartbeatTimer = setInterval(emitHeartbeat, HEARTBEAT_INTERVAL_MS);
    memoryCheckTimer = setInterval(() => {
      if (!trigger && process.memoryUsage().heapUsed >= HEAP_STOP_BYTES) {
        void requestCancellation('heap-used-threshold');
      }
    }, MEMORY_CHECK_INTERVAL_MS);

    let lastPhase;
    try {
      const result = await buildConfigurationCompare({
        leftRootPath: targetRoot,
        rightRootPath: targetRoot,
        backupRootPath: path.join(os.tmpdir(), 'configuration-compare-memory-unused-backups'),
        createdAt: new Date('2026-11-23T00:00:00.000Z'),
        cancellation,
        onProgress: (progress) => {
          currentPhase = progress.phase;
          if (progress.phase !== lastPhase) {
            lastPhase = progress.phase;
            emit({ type: 'phase', phase: progress.phase, elapsedMs: Math.round(performance.now() - started) });
          }
        },
      });
      workspace = result.workspace;
      comparisonSettled = true;
      workerStatus = trigger ? 'compare-failed' : 'completed';
      emit({
        type: 'worker-result',
        status: workerStatus,
        result: {
          elapsedMs: Math.round(performance.now() - started),
          mergeableNodeCount: workspace.listMergeableNodeIds().length,
          ...(trigger ? { error: 'Comparison completed before the diagnostic cancellation was observed' } : {}),
          trigger,
          stopAfter: options.stopAfter,
          stageCounts,
        },
      });
    } catch (error) {
      comparisonSettled = true;
      const expectedCancellation = Boolean(trigger) && isConfigurationCompareCancelled(error);
      workerStatus = expectedCancellation
        ? workerStatus === 'profile-failed' ? 'profile-failed' : 'diagnostic-stopped'
        : 'compare-failed';
      emit({
        type: 'worker-result',
        status: workerStatus,
        result: {
          elapsedMs: Math.round(performance.now() - started),
          ...(expectedCancellation ? {} : { error: truncateText(error instanceof Error ? `${error.name}: ${error.message}` : String(error), 1_000) }),
          trigger,
          stopAfter: options.stopAfter,
          stageCounts,
        },
      });
    }
  } catch (error) {
    workerStatus = 'worker-failed';
    emit({
      type: 'worker-result',
      status: workerStatus,
      result: {
        elapsedMs: Math.round(performance.now() - started),
        error: truncateText(error instanceof Error ? `${error.name}: ${error.message}` : String(error), 1_000),
        trigger,
        stopAfter: options.stopAfter,
        stageCounts,
      },
    });
  } finally {
    clearInterval(heartbeatTimer);
    clearInterval(memoryCheckTimer);
    if (cancellationPromise) {await cancellationPromise;}
    if (samplingStarted && session) {await captureHeapProfileOnce();}
    for (const restore of restoreWrappers.reverse()) {restore();}
    if (session) {session.disconnect();}
    workspace?.dispose();
  }
  emit({ type: 'status', status: workerStatus });
}

function installStageWrappers(input) {
  const instrumented = [
    {
      relativePath: 'src/compareMerge/metadata/metadataIndexer.js',
      exportName: 'indexMetadataFolder',
      stageName: 'metadata',
      sideForArgs: (args) => args[0]?.side === 'right' ? 'right/source' : 'left/target',
      counts: (result) => ({ identityCount: Array.isArray(result) ? result.length : null }),
      completed: () => {},
    },
    {
      relativePath: 'src/compareMerge/inventory/configurationFileManifest.js',
      exportName: 'buildConfigurationFileManifest',
      stageName: 'manifest',
      sideForArgs: () => ++input.stageCounts.manifestCall === 1 ? 'left/target' : 'right/source',
      counts: (result) => ({
        objectCount: result.objects.length,
        entryCount: result.entries.length,
        directoryCount: result.directoryPathsByRelativePath.size,
      }),
      completed: async (result, side) => {
        input.manifestSides.set(result, side);
        input.stageCounts.manifestCompleted += 1;
        if (input.stopAfter === 'manifests' && input.stageCounts.manifestCompleted === 2) {
          await input.requestCancellation('both-manifests-complete');
        }
      },
    },
    {
      relativePath: 'src/compareMerge/inventory/configurationInventory.js',
      exportName: 'hydrateConfigurationInventoryFromManifest',
      stageName: 'inventory-hydration',
      sideForArgs: (args) => input.manifestSides.get(args[0]?.manifest) ?? 'unknown',
      counts: inventoryCounts,
      completed: async () => {
        input.stageCounts.hydrationCompleted += 1;
        if (input.stopAfter === 'hydration' && input.stageCounts.hydrationCompleted === 2) {
          await input.requestCancellation('both-inventory-hydrations-complete');
        }
      },
    },
  ];

  for (const target of instrumented) {
    const modulePath = path.join(input.buildRoot, target.relativePath);
    const exports = require(modulePath);
    const original = exports[target.exportName];
    if (typeof original !== 'function') {throw new Error(`Missing export ${target.exportName} in ${target.relativePath}`);}
    const wrapper = async function (...args) {
      const id = input.nextStageId();
      const side = target.sideForArgs(args);
      const before = memorySnapshot();
      input.emit({
        type: 'stage-start',
        stage: { id, name: target.stageName, side, startedElapsedMs: Math.round(performance.now() - input.started), before },
      });
      const finish = async (result, error) => {
        const after = memorySnapshot();
        const stage = {
          finishedElapsedMs: Math.round(performance.now() - input.started),
          after,
          deltaHeapUsedBytes: after.heapUsedBytes - before.heapUsedBytes,
          status: error ? 'failed' : 'completed',
          ...(error ? { error: truncateText(error instanceof Error ? `${error.name}: ${error.message}` : String(error), 500) } : {}),
          ...(!error ? { resultCounts: target.counts(result) } : {}),
        };
        input.emit({ type: 'stage-end', id, stage });
        if (!error) {await target.completed(result, side);}
      };
      let value;
      try {
        value = original.apply(this, args);
      } catch (error) {
        await finish(undefined, error);
        throw error;
      }
      return Promise.resolve(value).then(async (result) => {await finish(result); return result;}, async (error) => {await finish(undefined, error); throw error;});
    };
    exports[target.exportName] = wrapper;
    input.restoreWrappers.push(() => {exports[target.exportName] = original;});
  }
}

function inventoryCounts(inventory) {
  let artifactCount = 0;
  for (const artifacts of inventory.artifactsByObjectId.values()) {artifactCount += artifacts.length;}
  return {
    objectCount: inventory.objects.length,
    artifactOwnerCount: inventory.artifactsByObjectId.size,
    descriptorCount: inventory.objectsByDescriptorPath.size,
    artifactCount,
  };
}

async function collectBeforeSampling(session) {
  const before = memorySnapshot();
  const started = performance.now();
  try {
    await postInspector(session, 'HeapProfiler.collectGarbage');
    const after = memorySnapshot();
    return { status: 'completed', elapsedMs: Math.round(performance.now() - started), before, after };
  } catch (error) {
    return {
      status: 'failed',
      elapsedMs: Math.round(performance.now() - started),
      before,
      after: memorySnapshot(),
      error: truncateText(error instanceof Error ? error.message : String(error), 500),
    };
  }
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  };
}

function postInspector(session, method, params) {
  return new Promise((resolve, reject) => {
    const callback = (error, result) => error ? reject(error) : resolve(result ?? {});
    if (params === undefined) {session.post(method, callback);}
    else {session.post(method, params, callback);}
  });
}

function summarizeHeapProfile(profile) {
  const topStacks = [];
  const frames = [];
  let visitedNodeCount = 0;
  let sampledSelfBytes = 0;
  const visit = (node) => {
    visitedNodeCount += 1;
    const callFrame = node.callFrame ?? {};
    frames.push(formatCallFrame(callFrame));
    sampledSelfBytes += node.selfSize ?? 0;
    if (node.selfSize > 0 && (topStacks.length < MAX_TOP_STACKS || node.selfSize > topStacks[topStacks.length - 1].sampledSelfBytes)) {
      const stack = frames.length <= 24 ? frames.join(' <- ') : frames.slice(-24).join(' <- ');
      topStacks.push({ sampledSelfBytes: node.selfSize, stack: truncateText(stack, 720) });
      topStacks.sort((left, right) => right.sampledSelfBytes - left.sampledSelfBytes);
      if (topStacks.length > MAX_TOP_STACKS) {topStacks.pop();}
    }
    for (const child of node.children ?? []) {visit(child);}
    frames.pop();
  };
  visit(profile.head);
  return {
    samplingIntervalBytes: SAMPLING_INTERVAL_BYTES,
    sampledSelfBytes,
    topStacks,
    visitedNodeCount,
    interpretation: 'V8 sampling self-size estimate; not dominator or exact retained size',
  };
}

function formatCallFrame(frame) {
  const name = truncateText(frame.functionName || '(anonymous)', 100);
  const source = frame.url ? path.basename(frame.url.replace(/^file:\/\//u, '')) : 'native';
  const line = Number.isInteger(frame.lineNumber) ? `:${frame.lineNumber + 1}` : '';
  return `${name}@${source}${line}`;
}

function truncateText(value, maximum, direction = 'head') {
  const text = String(value ?? '');
  if (text.length <= maximum) {return text;}
  return direction === 'tail' ? text.slice(-maximum) : text.slice(0, maximum);
}

function isHeapOutOfMemory(stderr) {
  return /(?:allocation failed[^\r\n]*heap out of memory|javascript heap out of memory)/iu.test(stderr);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
