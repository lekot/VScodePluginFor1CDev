/**
 * Collects smoke test failures and writes artifacts only when at least one failure occurred.
 * One run = one folder smoke-artifacts/<timestamp>/ with failures.json and summary.md.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface FailureEntry {
  step: string;
  errorMessage: string;
  stack?: string;
  nodeId?: string;
  nodeName?: string;
  command?: string;
  timestamp: string;
}

let artifactsDir: string | null = null;
const failures: FailureEntry[] = [];

function getTimestamp(): string {
  return new Date().toISOString().replace(/:/g, '-').slice(0, 19);
}

function getArtifactsRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return path.resolve(__dirname, '../../../../');
}

export function recordFailure(entry: {
  step: string;
  error: Error | string;
  nodeId?: string;
  nodeName?: string;
  command?: string;
}): void {
  const errorMessage = entry.error instanceof Error ? entry.error.message : String(entry.error);
  const stack = entry.error instanceof Error ? entry.error.stack : undefined;
  const timestamp = new Date().toISOString();
  failures.push({
    step: entry.step,
    errorMessage,
    stack,
    nodeId: entry.nodeId,
    nodeName: entry.nodeName,
    command: entry.command,
    timestamp,
  });
  if (artifactsDir === null) {
    const root = getArtifactsRoot();
    const dirName = `smoke-artifacts/${getTimestamp()}`;
    artifactsDir = path.join(root, dirName);
  }
}

export function getArtifactsDir(): string | null {
  return artifactsDir;
}

export function hasFailures(): boolean {
  return failures.length > 0;
}

export function getFailures(): ReadonlyArray<FailureEntry> {
  return failures;
}

export async function writeArtifacts(): Promise<void> {
  if (failures.length === 0) return;
  if (artifactsDir === null) return;
  try {
    if (!fs.existsSync(artifactsDir)) {
      fs.mkdirSync(artifactsDir, { recursive: true });
    }
    const failuresPath = path.join(artifactsDir, 'failures.json');
    fs.writeFileSync(failuresPath, JSON.stringify(failures, null, 2), 'utf8');
    const summaryPath = path.join(artifactsDir, 'summary.md');
    const summary = buildSummary();
    fs.writeFileSync(summaryPath, summary, 'utf8');
  } catch (err) {
    console.error('SmokeArtifacts: failed to write artifacts', err);
  }
}

function buildSummary(): string {
  const lines: string[] = [
    '# Smoke test run summary',
    '',
    `**Date:** ${new Date().toISOString()}`,
    `**Failures:** ${failures.length}`,
    '',
    '## Failures',
    '',
  ];
  failures.forEach((f, i) => {
    lines.push(`### ${i + 1}. ${f.step}`);
    if (f.nodeId) lines.push(`- Node ID: ${f.nodeId}`);
    if (f.nodeName) lines.push(`- Node name: ${f.nodeName}`);
    if (f.command) lines.push(`- Command: ${f.command}`);
    lines.push(`- Error: ${f.errorMessage}`);
    if (f.stack) lines.push('```\n' + f.stack + '\n```');
    lines.push('');
  });
  return lines.join('\n');
}

export function reset(): void {
  artifactsDir = null;
  failures.length = 0;
}
