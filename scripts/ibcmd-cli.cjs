#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const mode = process.argv[2];
if (mode !== 'check' && mode !== 'import') {
  console.error('Usage: ibcmd-cli.cjs check|import');
  process.exit(2);
}

const ibcmd = process.env.IBCMD_PATH?.trim();
const config = process.env.IBCMD_INFOBASE_CONFIG?.trim();
if (!ibcmd || !config) {
  console.error('Set IBCMD_PATH and IBCMD_INFOBASE_CONFIG (see docs/design/e2e-container-matrix-ibcmd.md §6.5).');
  process.exit(1);
}

if (!fs.existsSync(ibcmd)) {
  console.error(`ibcmd executable not found: ${ibcmd}`);
  process.exit(1);
}

if (!fs.existsSync(config)) {
  console.error(`IBCMD_INFOBASE_CONFIG file not found: ${config}`);
  process.exit(1);
}

const args = ['infobase', 'config', mode === 'check' ? 'check' : 'import', `--config=${path.resolve(config)}`];
const user = process.env.IBCMD_USER?.trim();
const password = process.env.IBCMD_PASSWORD?.trim();
if (user) {
  args.push(`--user=${user}`);
}
if (password) {
  args.push(`--password=${password}`);
}

if (mode === 'check') {
  if (process.env.IBCMD_CONFIG_CHECK_FORCE?.trim() === '1') {
    args.push('--force');
  }
} else {
  const workDir = process.env.MATRIX_WORK_DIR?.trim();
  if (!workDir) {
    console.error('Set MATRIX_WORK_DIR to the Designer configuration root (directory containing Configuration.xml).');
    process.exit(1);
  }
  const root = path.resolve(workDir);
  const cfgXml = path.join(root, 'Configuration.xml');
  if (!fs.existsSync(cfgXml)) {
    console.error(`MATRIX_WORK_DIR has no Configuration.xml: ${root}`);
    process.exit(1);
  }
  args.push(root);
}

const reportDirRaw = process.env.IBCMD_REPORT_DIR?.trim();
const reportDir = reportDirRaw ? path.resolve(reportDirRaw) : path.resolve('.ibcmd-reports');
const reportPath = path.join(reportDir, `${mode}-last.log`);

const r = spawnSync(ibcmd, args, { encoding: 'utf8', shell: false });
const stdout = (r.stdout ?? '').toString();
const stderr = (r.stderr ?? '').toString();
const exitCode = typeof r.status === 'number' ? r.status : 1;

if (stdout) {
  process.stdout.write(stdout);
}
if (stderr) {
  process.stderr.write(stderr);
}

try {
  fs.mkdirSync(reportDir, { recursive: true });
  const stamp = new Date().toISOString();
  const body = [
    `mode=${mode}`,
    `command=${ibcmd} ${args.join(' ')}`,
    `timestamp=${stamp}`,
    `exitCode=${exitCode}`,
    '',
    '--- stdout ---',
    stdout,
    '',
    '--- stderr ---',
    stderr,
    '',
  ].join('\n');
  fs.writeFileSync(reportPath, body, 'utf8');
  process.stdout.write(`[ibcmd-cli] exitCode: ${exitCode}\n`);
  process.stdout.write(`\n[ibcmd-cli] report: ${reportPath}\n`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\n[ibcmd-cli] failed to write report: ${msg}\n`);
}

process.exit(exitCode);
