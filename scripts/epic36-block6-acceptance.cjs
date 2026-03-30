#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const reportsDir = path.join(repoRoot, 'suite-reports');
const coreReportPath = path.join(reportsDir, 'epic36-block6-core.json');
const acceptanceReportPath = path.join(reportsDir, 'epic36-block6-acceptance.md');
const formatSamplesDir = path.join(repoRoot, 'FormatSamples');
const preferredControlForms = [
  'form_preview_block3b/Form.xml',
  'empty_conf/Catalogs/табатаба/Forms/MyForm.xml',
];

const mandatorySuites = [
  'suite/formModelCommands.test.js',
  'suite/formEditorMessageHandling.test.js',
  'suite/formModelUtils.test.js',
  'suite/formWebviewPagesPreview.test.js',
  'suite/formWebviewBlock3b.test.js',
  'suite/formXmlWriter.test.js',
  'suite/formLifecycle.integration.test.js',
  'suite/formDragBugCondition.test.js',
  'suite/formDragPreservation.test.js',
  'suite/formTreeRootDragBugCondition.test.js',
  'suite/formTreeRootDragPreservation.test.js',
];

const deferredVsCodeSuites = ['suite/formWebviewBlock4c.test.js', 'suite/formWebviewBlock5d.test.js'];

const suiteGroups = [
  {
    label: 'Tree',
    suites: ['suite/formModelCommands.test.js', 'suite/formEditorMessageHandling.test.js'],
  },
  {
    label: 'Layout meta',
    suites: ['suite/formModelUtils.test.js'],
  },
  {
    label: 'Preview',
    suites: [
      'suite/formWebviewPagesPreview.test.js',
      'suite/formWebviewBlock3b.test.js',
    ],
  },
  {
    label: 'Save',
    suites: ['suite/formXmlWriter.test.js', 'suite/formLifecycle.integration.test.js'],
  },
  {
    label: 'D&D',
    suites: [
      'suite/formDragBugCondition.test.js',
      'suite/formDragPreservation.test.js',
      'suite/formTreeRootDragBugCondition.test.js',
      'suite/formTreeRootDragPreservation.test.js',
    ],
  },
];

function normalizeSuitePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function discoverControlForms(rootDir) {
  const result = [];
  if (!fs.existsSync(rootDir)) {
    return result;
  }

  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.toLowerCase().endsWith('.xml')) {
        continue;
      }
      const rel = path.relative(rootDir, fullPath).replace(/\\/g, '/');
      if (/\/forms\//i.test(`/${rel}`) || /(^|\/)form\.xml$/i.test(rel)) {
        result.push(rel);
      }
    }
  }

  result.sort((a, b) => a.localeCompare(b, 'en'));

  const preferred = preferredControlForms.filter((entry) => result.includes(entry));
  const rest = result.filter((entry) => !preferred.includes(entry));
  return preferred.concat(rest.slice(0, 18));
}

function runCoreTests() {
  const npmCmd = 'npm';
  const env = {
    ...process.env,
    MANDATORY_SUITES_CORE: mandatorySuites.join(','),
    SUITE_REPORT_PATH_CORE: coreReportPath,
  };
  const run = spawnSync(npmCmd, ['run', 'test:ci'], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (run.error) {
    console.error(`Failed to start test:ci: ${run.error.message}`);
    return 1;
  }
  return run.status ?? 1;
}

function readCoreReport(reportPath) {
  if (!fs.existsSync(reportPath)) {
    return null;
  }
  const raw = fs.readFileSync(reportPath, 'utf8');
  return JSON.parse(raw);
}

function groupStatus(group, executedSet, missingSet, hasFailures) {
  const missing = group.suites.filter((suite) => missingSet.has(suite));
  const notExecuted = group.suites.filter((suite) => !executedSet.has(suite));
  if (hasFailures) {
    return { status: 'FAIL', reason: 'one or more tests failed' };
  }
  if (missing.length > 0) {
    return { status: 'FAIL', reason: `missing mandatory suites: ${missing.join(', ')}` };
  }
  if (notExecuted.length > 0) {
    return { status: 'WARN', reason: `not executed: ${notExecuted.join(', ')}` };
  }
  return { status: 'PASS', reason: `all ${group.suites.length} suite(s) executed` };
}

function writeAcceptanceReport(report, controlForms) {
  const executedSuites = new Set((report?.executedSuites || []).map(normalizeSuitePath));
  const discoveredSuites = new Set((report?.discoveredSuites || []).map(normalizeSuitePath));
  const missingMandatory = new Set((report?.missingMandatorySuites || []).map(normalizeSuitePath));
  const hasFailures = (report?.testStats?.failures || 0) > 0;

  const lines = [];
  lines.push('# Epic 36 / Block 6 acceptance report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Automated regression gate');
  lines.push('');
  for (const group of suiteGroups) {
    const status = groupStatus(group, executedSuites, missingMandatory, hasFailures);
    lines.push(`- [${status.status}] ${group.label}: ${status.reason}`);
  }
  lines.push('');
  lines.push('## Core run stats');
  lines.push('');
  if (report?.testStats) {
    lines.push(`- passes: ${report.testStats.passes}`);
    lines.push(`- failures: ${report.testStats.failures}`);
    lines.push(`- pending: ${report.testStats.pending}`);
    lines.push(`- total: ${report.testStats.total}`);
  } else {
    lines.push('- report data unavailable');
  }
  lines.push('');
  lines.push('## Mandatory suites');
  lines.push('');
  for (const suite of mandatorySuites) {
    const ok = executedSuites.has(suite) && !missingMandatory.has(suite);
    lines.push(`- [${ok ? 'x' : ' '}] ${suite}`);
  }
  lines.push('');
  lines.push('## Manual control forms checklist');
  lines.push('');
  lines.push('- [ ] Pages/Page: one active tab, switch works, non-active page content hidden.');
  lines.push('- [ ] PagesRepresentation: TabsOnTop/TabsOnBottom rendered in expected tab strip position.');
  lines.push('- [ ] Preview parity: group orientation/align/spacing visibly matches spec examples.');
  lines.push('- [ ] Save regression: re-opened XML keeps structure/properties without corruption.');
  lines.push('- [ ] D&D regression: no lost nodes, order preserved after drag/drop operations.');
  lines.push('');
  lines.push('### Control forms discovered in `FormatSamples`');
  lines.push('');
  if (controlForms.length === 0) {
    lines.push('- [ ] no control forms discovered under FormatSamples');
  } else {
    for (const relPath of controlForms) {
      lines.push(`- [ ] ${relPath} — verify tree, preview, save, D&D`);
    }
  }
  lines.push('');
  lines.push('## Deferred to Test phase');
  lines.push('');
  lines.push('- VSCode integration suites are tracked but not enforced by core test:ci on Windows CI job.');
  for (const suite of deferredVsCodeSuites) {
    const inDiscovered = discoveredSuites.has(suite);
    const inExecuted = executedSuites.has(suite);
    lines.push(`- [${inExecuted ? 'x' : ' '}] ${suite} (discovered by core: ${inDiscovered ? 'yes' : 'no'})`);
  }
  lines.push('');

  fs.writeFileSync(acceptanceReportPath, `${lines.join('\n')}\n`, 'utf8');
}

function main() {
  ensureDir(reportsDir);
  const skipTests = process.argv.includes('--skip-tests');

  let exitCode = 0;
  if (!skipTests) {
    exitCode = runCoreTests();
  }

  const report = readCoreReport(coreReportPath);
  const controlForms = discoverControlForms(formatSamplesDir);
  writeAcceptanceReport(report, controlForms);

  if (!report && exitCode === 0) {
    console.error(`Core suite report was not found at: ${coreReportPath}`);
    process.exit(1);
  }
  process.exit(exitCode);
}

main();
