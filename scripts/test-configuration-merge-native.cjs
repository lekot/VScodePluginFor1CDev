#!/usr/bin/env node
'use strict';

const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const SUITE_REPORTS = path.join(REPOSITORY_ROOT, 'suite-reports');
const TEMP_PREFIX = '.tmp-native-merger-';
const OWNERSHIP_MARKER = '.1cviewer-native-merge-owned.json';
const IBCMD_PATH = process.env.IBCMD_PATH?.trim()
  || 'C:\\Program Files\\1cv8\\8.3.27.1859\\bin\\ibcmd.exe';
const NATIVE_BASELINE = path.join(
  REPOSITORY_ROOT,
  'test',
  'fixtures',
  'compareMerge',
  'extensions',
  'native-2.20',
  'base'
);
const REPORT_PATH = path.join(SUITE_REPORTS, 'configuration-merge-native-last.json');
const COMMAND_TIMEOUT_MS = 8 * 60 * 1000;
const MAX_LOG_CHARS = 3000;

async function main() {
  const run = {
    startedAt: new Date().toISOString(),
    status: 'running',
    stage: 'native-infobase-probe',
    commands: [],
    cleanup: 'pending',
  };
  let failure;
  let workspace;

  try {
    workspace = createOwnedWorkspace();
    validateOwnedWorkspace(workspace);
    run.sourceFixtureSha256Before = hashDirectory(NATIVE_BASELINE);
    await runNativeAcceptance(workspace, run);
    run.stage = 'complete';
    run.status = 'passed';
  } catch (error) {
    failure = error;
    run.status = 'failed';
    run.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (run.sourceFixtureSha256Before) {
      try {
        run.sourceFixtureSha256After = hashDirectory(NATIVE_BASELINE);
        if (run.sourceFixtureSha256After !== run.sourceFixtureSha256Before) {
          throw new Error('The native acceptance run modified the checked-in baseline fixture.');
        }
      } catch (error) {
        failure ??= error;
        run.status = 'failed';
        run.fixtureIntegrityError = error instanceof Error ? error.message : String(error);
      }
    }
    try {
      if (workspace) {
        cleanupOwnedWorkspace(workspace);
      }
      run.cleanup = 'removed';
    } catch (error) {
      run.cleanup = 'failed';
      run.cleanupError = error instanceof Error ? error.message : String(error);
      failure ??= error;
      run.status = 'failed';
    }

    run.finishedAt = new Date().toISOString();
    writeRunReport(run);
  }

  process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  if (failure) {
    process.exitCode = 1;
  }
}

async function runNativeAcceptance(workspace, run) {
  requireFile(IBCMD_PATH, 'ibcmd 8.3.27');
  requireFile(path.join(NATIVE_BASELINE, 'Configuration.xml'), 'Hierarchical Designer configuration');
  requireFile(path.join(NATIVE_BASELINE, 'ConfigDumpInfo.xml'), 'Designer configuration dump info');
  const version = runIbcmdCommand(run, 'Read ibcmd version', ['--version']);
  if (!version.log.stdout.includes('8.3.27.')) {
    throw new Error(`Expected ibcmd 8.3.27, got: ${version.log.stdout.trim() || '(empty version)'}`);
  }

  const databasePath = path.join(workspace.workspace, 'db');
  const dataPath = path.join(workspace.workspace, 'data');
  fs.mkdirSync(databasePath, { recursive: true });
  fs.mkdirSync(dataPath, { recursive: true });

  runIbcmdCommand(run, 'Create a file infobase from the hierarchical Designer dump', [
    'infobase',
    'create',
    `--db-path=${databasePath}`,
    `--data=${dataPath}`,
    '--create-database',
    `--import=${NATIVE_BASELINE}`,
  ]);

  runIbcmdCommand(run, 'Check native baseline configuration before merge', [
    'infobase',
    'config',
    'check',
    `--db-path=${databasePath}`,
    `--data=${dataPath}`,
  ]);

  const exportedBaseline = path.join(workspace.workspace, 'baseline-export');
  fs.mkdirSync(exportedBaseline);
  runIbcmdCommand(run, 'Export a native baseline configuration', [
    'infobase',
    'config',
    'export',
    `--db-path=${databasePath}`,
    `--data=${dataPath}`,
    exportedBaseline,
  ]);
  requireFile(path.join(exportedBaseline, 'Configuration.xml'), 'Exported baseline configuration');
  requireFile(path.join(exportedBaseline, 'ConfigDumpInfo.xml'), 'Exported baseline dump info');

  const forksRoot = path.join(workspace.workspace, 'forks');
  const targetRoot = path.join(forksRoot, 'target');
  const incomingRoot = path.join(forksRoot, 'incoming');
  fs.mkdirSync(forksRoot);
  fs.cpSync(exportedBaseline, targetRoot, { recursive: true, errorOnExist: true });
  fs.cpSync(exportedBaseline, incomingRoot, { recursive: true, errorOnExist: true });
  const targetAttribute = appendIndependentAttribute(targetRoot, 'MergeTargetOnly');
  const incomingAttribute = appendIndependentAttribute(incomingRoot, 'MergeIncomingOnly');
  run.forkAttributes = {
    target: targetAttribute,
    incoming: incomingAttribute,
  };

  const buildRoot = compileNativeMergeRuntime(workspace, run);
  await mergeIncomingAttributeThroughWorkspace({
    buildRoot,
    targetRoot,
    incomingRoot,
    backupRoot: path.join(workspace.workspace, 'backups'),
    incomingAttribute,
    run,
  });
  assertForkAttributes(targetRoot, targetAttribute, incomingAttribute);

  runIbcmdCommand(run, 'Import merged configuration into the owned file infobase', [
    'infobase',
    'config',
    'import',
    `--db-path=${databasePath}`,
    `--data=${dataPath}`,
    targetRoot,
  ]);
  runIbcmdCommand(run, 'Check merged configuration in the owned file infobase', [
    'infobase',
    'config',
    'check',
    `--db-path=${databasePath}`,
    `--data=${dataPath}`,
  ]);

  const verifiedExport = path.join(workspace.workspace, 'verified-export');
  fs.mkdirSync(verifiedExport);
  runIbcmdCommand(run, 'Export the imported merged configuration for verification', [
    'infobase',
    'config',
    'export',
    `--db-path=${databasePath}`,
    `--data=${dataPath}`,
    verifiedExport,
  ]);
  assertForkAttributes(verifiedExport, targetAttribute, incomingAttribute);
}

function runIbcmdCommand(run, description, args) {
  const result = runCommand(IBCMD_PATH, args);
  run.commands.push({ description, ...result.log });
  assertSuccessfulCommand(result, description);
  return result;
}

function compileNativeMergeRuntime(workspace, run) {
  const buildRoot = path.join(workspace.workspace, 'compiled');
  fs.mkdirSync(buildRoot);
  const compiler = path.join(REPOSITORY_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const entries = [
    path.join(REPOSITORY_ROOT, 'src', 'compareMerge', 'configurationCompareService.ts'),
    path.join(REPOSITORY_ROOT, 'test', 'helpers', 'vscodeStubRegister.ts'),
    path.join(REPOSITORY_ROOT, 'test', 'suite', 'compareMerge', 'mergeMutationTestSupport.ts'),
  ];
  const args = [
    compiler,
    '--target', 'ES2020',
    '--module', 'commonjs',
    '--lib', 'ES2020',
    '--outDir', buildRoot,
    '--rootDir', REPOSITORY_ROOT,
    '--strict',
    '--esModuleInterop',
    '--skipLibCheck',
    '--types', 'node,vscode',
    '--noImplicitReturns',
    '--noFallthroughCasesInSwitch',
    '--pretty', 'false',
    ...entries,
  ];
  const result = runCommand(process.execPath, args);
  run.commands.push({ description: 'Compile a private compare runtime', ...result.log });
  assertSuccessfulCommand(result, 'Compile a private compare runtime');
  return buildRoot;
}

async function mergeIncomingAttributeThroughWorkspace(input) {
  const stubPath = path.join(input.buildRoot, 'test', 'helpers', 'vscodeStubRegister.js');
  const servicePath = path.join(input.buildRoot, 'src', 'compareMerge', 'configurationCompareService.js');
  const supportPath = path.join(
    input.buildRoot,
    'test',
    'suite',
    'compareMerge',
    'mergeMutationTestSupport.js'
  );
  require(stubPath);
  const { buildConfigurationCompare } = require(servicePath);
  const { createMergeMutationTestRuntime } = require(supportPath);
  const runtime = await createMergeMutationTestRuntime(input.targetRoot);
  let workspace;
  try {
    const result = await buildConfigurationCompare({
      leftRootPath: input.targetRoot,
      rightRootPath: input.incomingRoot,
      backupRootPath: input.backupRoot,
      mutationEngine: runtime.engine,
      configurationId: runtime.configurationId,
    });
    workspace = result.workspace;
    const candidate = findIncomingMetadataNode(workspace, input.incomingAttribute.name);
    input.run.selectedNodeId = candidate.id;
    const preview = await workspace.createPreviewForNodeIds([candidate.id]);
    assertWorkspaceSuccess(preview, 'Create merge preview');
    const approval = workspace.approvePreview(preview.preview.previewId);
    assertWorkspaceSuccess(approval, 'Approve merge preview');
    const execution = await workspace.executeApprovedPreview(preview.preview.previewId);
    assertWorkspaceSuccess(execution, 'Execute approved merge preview');
    input.run.workspaceExecution = {
      selectedNodeId: candidate.id,
      preview: preview.ok,
      approval: approval.ok,
      execution: execution.ok,
    };
  } finally {
    workspace?.dispose();
    await runtime.coordinator.dispose();
  }
}

function findIncomingMetadataNode(workspace, incomingName) {
  const mergeable = new Set(workspace.listMergeableNodeIds());
  const nodes = flattenTree(workspace.payload.root);
  const candidate = nodes.find((node) =>
    mergeable.has(node.id)
    && node.status === 'rightOnly'
    && `${node.label} ${node.id}`.includes(incomingName)
  );
  if (candidate) {
    return candidate;
  }
  const relevant = nodes
    .filter((node) => `${node.label} ${node.id}`.includes('Merge'))
    .map((node) => ({ id: node.id, label: node.label, kind: node.kind, status: node.status }));
  throw new Error(`No mergeable right-side metadata node for ${incomingName}: ${JSON.stringify(relevant)}`);
}

function flattenTree(root) {
  const result = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) {
      continue;
    }
    result.push(node);
    pending.push(...(node.children ?? []));
  }
  return result;
}

function assertWorkspaceSuccess(result, description) {
  if (!result.ok) {
    throw new Error(`${description} failed: ${JSON.stringify(result.diagnostics ?? [])}`);
  }
}

function appendIndependentAttribute(root, name) {
  const catalogFile = path.join(root, 'Catalogs', 'Справочник55.xml');
  const dumpInfoFile = path.join(root, 'ConfigDumpInfo.xml');
  const uuid = randomUUID();
  const moduleXml = fs.readFileSync(catalogFile, 'utf8');
  const donorTag = '<Attribute uuid="65109af7-9e86-4b38-b0e9-6d15c5c07567">';
  const donorStart = moduleXml.indexOf(donorTag);
  if (donorStart < 0) {
    throw new Error('The exported baseline no longer contains the expected donor Attribute.');
  }
  const donorEndTag = '</Attribute>';
  const donorEnd = moduleXml.indexOf(donorEndTag, donorStart) + donorEndTag.length;
  if (donorEnd < donorEndTag.length) {
    throw new Error('The exported baseline donor Attribute is not closed.');
  }
  const lineStart = moduleXml.lastIndexOf('\n', donorStart) + 1;
  const indent = moduleXml.slice(lineStart, donorStart);
  const donor = moduleXml.slice(donorStart, donorEnd);
  const clone = donor
    .replace('uuid="65109af7-9e86-4b38-b0e9-6d15c5c07567"', `uuid="${uuid}"`)
    .replace('<Name>IbcmdCheck</Name>', `<Name>${name}</Name>`)
    .replace('<v8:content>IbcmdCheck</v8:content>', `<v8:content>${name}</v8:content>`);
  if (clone === donor || !clone.includes(`<Name>${name}</Name>`)) {
    throw new Error(`Could not clone the donor Attribute as ${name}.`);
  }
  const newline = moduleXml.includes('\r\n') ? '\r\n' : '\n';
  fs.writeFileSync(catalogFile, `${moduleXml.slice(0, donorEnd)}${newline}${indent}${clone}${moduleXml.slice(donorEnd)}`, 'utf8');

  const dumpInfo = fs.readFileSync(dumpInfoFile, 'utf8');
  const donorEntry = '<Metadata name="Catalog.Справочник55.Attribute.IbcmdCheck" id="65109af7-9e86-4b38-b0e9-6d15c5c07567"/>';
  const newEntry = `<Metadata name="Catalog.Справочник55.Attribute.${name}" id="${uuid}"/>`;
  if (!dumpInfo.includes(donorEntry)) {
    throw new Error('The exported baseline dump info no longer contains the expected donor Attribute entry.');
  }
  fs.writeFileSync(dumpInfoFile, dumpInfo.replace(donorEntry, `${donorEntry}${newline}\t\t\t${newEntry}`), 'utf8');
  return { name, uuid };
}

function assertForkAttributes(targetRoot, targetAttribute, incomingAttribute) {
  const descriptor = fs.readFileSync(path.join(targetRoot, 'Catalogs', 'Справочник55.xml'), 'utf8');
  for (const attribute of [targetAttribute, incomingAttribute]) {
    if (!descriptor.includes(`uuid="${attribute.uuid}"`)
      || !descriptor.includes(`<Name>${attribute.name}</Name>`)) {
      throw new Error(`Merged target is missing independent Attribute ${attribute.name}.`);
    }
  }
}

function hashDirectory(root) {
  const hash = require('crypto').createHash('sha256');
  appendDirectoryHash(hash, root, '');
  return hash.digest('hex');
}

function appendDirectoryHash(hash, root, relative) {
  const directory = relative ? path.join(root, relative) : root;
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const childPath = path.join(root, childRelative);
    if (entry.isSymbolicLink()) {
      throw new Error(`The checked-in native baseline contains a symbolic link: ${childRelative}`);
    }
    if (entry.isDirectory()) {
      appendDirectoryHash(hash, root, childRelative);
      continue;
    }
    if (entry.isFile()) {
      hash.update(childRelative.replace(/\\/gu, '/')).update('\0').update(fs.readFileSync(childPath)).update('\0');
    }
  }
}

function createOwnedWorkspace() {
  fs.mkdirSync(SUITE_REPORTS, { recursive: true });
  const reportsRealPath = fs.realpathSync(SUITE_REPORTS);
  const workspace = fs.mkdtempSync(path.join(reportsRealPath, TEMP_PREFIX));
  const marker = {
    schema: 1,
    purpose: 'configuration-merge-native-acceptance',
    nonce: randomUUID(),
  };
  fs.writeFileSync(path.join(workspace, OWNERSHIP_MARKER), `${JSON.stringify(marker)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return { workspace, reportsRealPath, marker };
}

function validateOwnedWorkspace(owned) {
  const workspaceStat = fs.lstatSync(owned.workspace);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new Error('Native acceptance workspace is not a real owned directory.');
  }
  const workspaceRealPath = fs.realpathSync(owned.workspace);
  if (
    path.dirname(workspaceRealPath) !== owned.reportsRealPath
    || !path.basename(workspaceRealPath).startsWith(TEMP_PREFIX)
  ) {
    throw new Error('Native acceptance workspace escaped its owned suite-reports directory.');
  }

  const markerPath = path.join(workspaceRealPath, OWNERSHIP_MARKER);
  const markerStat = fs.lstatSync(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new Error('Native acceptance ownership marker is not a regular file.');
  }
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (
    marker.schema !== owned.marker.schema
    || marker.purpose !== owned.marker.purpose
    || marker.nonce !== owned.marker.nonce
  ) {
    throw new Error('Native acceptance ownership marker does not match this run.');
  }
}

function cleanupOwnedWorkspace(owned) {
  validateOwnedWorkspace(owned);
  fs.rmSync(owned.workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    windowsHide: true,
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    status: result.status,
    error: result.error?.message,
    log: {
      command,
      args,
      status: result.status,
      signal: result.signal,
      timedOut: result.error?.code === 'ETIMEDOUT',
      error: result.error?.message,
      stdout: truncateLog(decodeOutput(result.stdout)),
      stderr: truncateLog(decodeOutput(result.stderr)),
    },
  };
}

function decodeOutput(value) {
  if (!Buffer.isBuffer(value)) {
    return String(value ?? '');
  }
  const utf8 = value.toString('utf8');
  return utf8.includes('\uFFFD') ? new TextDecoder('cp866').decode(value) : utf8;
}

function assertSuccessfulCommand(result, description) {
  if (result.status !== 0 || result.error) {
    throw new Error(
      `${description} failed (status=${result.status ?? 'unknown'}${result.error ? `, ${result.error}` : ''}).`
    );
  }
}

function requireFile(filePath, description) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${description} not found: ${filePath}`);
  }
}

function truncateLog(value) {
  const text = String(value);
  return text.length > MAX_LOG_CHARS ? `${text.slice(0, MAX_LOG_CHARS)}…[truncated]` : text;
}

function writeRunReport(run) {
  fs.mkdirSync(SUITE_REPORTS, { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
