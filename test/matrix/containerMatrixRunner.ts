import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createElement, createForm, deleteElement } from '../../src/services/elementOperations';
import type { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { TreeNode } from '../../src/models/treeNode';
import { MetadataParser } from '../../src/parsers/metadataParser';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import {
  buildDesignerMatrixContext,
  copyEmptyConfFixtureToTemp,
  dfsPreorderNodes,
  getRepoRootFromCompiledTestFile,
} from '../helpers/matrixTreeWalker';
import { runIbcmdConfigCheck, runIbcmdOnWorkDir } from './ibcmdAdapter';
import { isMatrixTarget, isNestedMatrixTargetUnderMatrixObject } from './matrixTargetPredicate';

export { isMatrixTarget, isNestedMatrixTargetUnderMatrixObject };

/**
 * One recorded matrix operation: create (attempt 1 or 2) or delete (attempt 1) for a target.
 * Per target the runner performs create×2 then delete×1; this is separate from the optional `ibcmd` gate.
 */
export interface ContainerMatrixStep {
  targetId: string;
  containerId?: string;
  path?: string;
  operation: 'create' | 'delete';
  attempt: number;
  success: boolean;
  message: string;
  stack?: string;
}

/** Aggregates success/failure counts for matrix steps only (not ibcmd). */
export interface ContainerMatrixSummary {
  passed: number;
  failed: number;
  skipped: number;
}

export interface ContainerMatrixIbcmdBlock {
  status: 'executed' | 'skipped' | 'failed';
  exitCode: number | null;
  logSnippet: string;
}

/**
 * Full JSON report (§6.2). `stepSummary` counts only create/delete matrix steps (create×2 + delete×1 per target;
 * при полном обходе добавляется второй проход по вложенным целям под `Matrix_*`).
 * `ibcmd` / `ibcmdCheck` are optional separate validation gates; their outcome is not folded into `stepSummary`.
 */
export interface ContainerMatrixReport {
  runId: string;
  timestamp: string;
  fixturePath: string;
  workDir: string;
  configFormat: ConfigFormat;
  steps: ContainerMatrixStep[];
  /** Passed/failed/skipped counts for matrix steps only; ibcmd does not affect these fields. */
  stepSummary: ContainerMatrixSummary;
  ibcmd: ContainerMatrixIbcmdBlock;
  /** `ibcmd infobase config check` after successful import (skipped when import skipped/failed or `IBMATRIX_SKIP_CONFIG_CHECK=1`). */
  ibcmdCheck: ContainerMatrixIbcmdBlock;
}

/** Короткий стабильный отпечаток цели — длинный targetId давал имена > 80 символов (лимит 1С), обрезка в XML ломала поиск при delete. */
function matrixTargetSignature(targetId: string): string {
  return createHash('sha256').update(targetId, 'utf8').digest('hex').slice(0, 12);
}

let matrixNameCounter = 0;

const MAX_MATRIX_ELEMENT_NAME = 80;

/**
 * ADR-004: префикс Matrix_ + сигнатура цели + уникальный суффикс; длина ≤ 80 (elementNameValidator).
 */
export function generateMatrixName(targetId: string, attempt: number): string {
  matrixNameCounter += 1;
  const sig = matrixTargetSignature(targetId);
  const uniq = `${Date.now().toString(36)}_${matrixNameCounter.toString(36)}`;
  let name = `Matrix_${sig}_a${attempt}_${uniq}`;
  if (name.length > MAX_MATRIX_ELEMENT_NAME) {
    name = name.slice(0, MAX_MATRIX_ELEMENT_NAME);
  }
  return name;
}

/** Compare metadata names with NFC so Cyrillic fixture names match tree/XML consistently. */
function matrixNameKey(s: string): string {
  return s.normalize('NFC');
}

function nodeMatchesMatrixVictim(c: TreeNode, target: TreeNode, name2: string): boolean {
  const k = matrixNameKey(name2);
  if (matrixNameKey(c.name) === k) {
    return true;
  }
  if (c.id === `${target.id}.${name2}` || c.id.endsWith(`.${name2}`)) {
    return true;
  }
  const idN = matrixNameKey(c.id);
  return idN.endsWith(`.${k}`);
}

/**
 * Pick node to delete after create×2. Attributes from Designer ChildObjects sit under an
 * `Attributes` folder node, not as direct children of the object (Role, CommonModule, …).
 */
function pickVictimNodeFromList(children: TreeNode[], target: TreeNode, name2: string): TreeNode | undefined {
  const direct = children.find((c) => nodeMatchesMatrixVictim(c, target, name2));
  if (direct) {
    return direct;
  }
  for (const c of children) {
    if (c.id === 'Attributes' && c.children?.length) {
      const hit = c.children.find((a) => nodeMatchesMatrixVictim(a, target, name2));
      if (hit) {
        return hit;
      }
    }
  }
  return undefined;
}

function containerLabel(node: TreeNode): { containerId: string; path: string } {
  const parts: string[] = [];
  let n: TreeNode | undefined = node;
  while (n) {
    parts.unshift(n.name);
    n = n.parent;
  }
  return { containerId: node.id, path: parts.join(' / ') };
}

function appendStep(
  steps: ContainerMatrixStep[],
  stepSummary: ContainerMatrixSummary,
  step: ContainerMatrixStep
): void {
  steps.push(step);
  if (step.success) {
    stepSummary.passed += 1;
  } else {
    stepSummary.failed += 1;
  }
}

async function runMatrixTargetCycle(
  target: TreeNode,
  provider: MetadataTreeDataProvider,
  workDir: string,
  steps: ContainerMatrixStep[],
  stepSummary: ContainerMatrixSummary,
  verboseStack: boolean
): Promise<void> {
  const { containerId, path: pathLabel } = containerLabel(target);
  const name1 = generateMatrixName(target.id, 1);
  const name2 = generateMatrixName(target.id, 2);
  const useCreateForm = target.id === 'Forms';

  try {
    if (useCreateForm) {
      await createForm(target, name1);
    } else {
      await createElement(target, name1);
    }
    appendStep(steps, stepSummary, {
      targetId: target.id,
      containerId,
      path: pathLabel,
      operation: 'create',
      attempt: 1,
      success: true,
      message: '',
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    appendStep(steps, stepSummary, {
      targetId: target.id,
      containerId,
      path: pathLabel,
      operation: 'create',
      attempt: 1,
      success: false,
      message: err.message,
      ...(verboseStack && err.stack ? { stack: err.stack } : {}),
    });
  }

  try {
    if (useCreateForm) {
      await createForm(target, name2);
    } else {
      await createElement(target, name2);
    }
    appendStep(steps, stepSummary, {
      targetId: target.id,
      containerId,
      path: pathLabel,
      operation: 'create',
      attempt: 2,
      success: true,
      message: '',
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    appendStep(steps, stepSummary, {
      targetId: target.id,
      containerId,
      path: pathLabel,
      operation: 'create',
      attempt: 2,
      success: false,
      message: err.message,
      ...(verboseStack && err.stack ? { stack: err.stack } : {}),
    });
  }

  provider.invalidateLoadedChildren(target);
  let victim: TreeNode | undefined;
  try {
    const children = await provider.getChildren(target);
    victim = pickVictimNodeFromList(children, target, name2);
  } catch {
    victim = undefined;
  }
  if (!victim) {
    try {
      const fresh = await MetadataParser.loadElementChildren(workDir, ConfigFormat.Designer, target);
      victim = pickVictimNodeFromList(fresh, target, name2);
    } catch {
      victim = undefined;
    }
  }

  if (!victim) {
    appendStep(steps, stepSummary, {
      targetId: target.id,
      containerId,
      path: pathLabel,
      operation: 'delete',
      attempt: 1,
      success: false,
      message: `Child node not found for second create name: ${name2}`,
    });
    return;
  }

  try {
    await deleteElement(victim);
    appendStep(steps, stepSummary, {
      targetId: target.id,
      containerId,
      path: pathLabel,
      operation: 'delete',
      attempt: 1,
      success: true,
      message: '',
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    appendStep(steps, stepSummary, {
      targetId: target.id,
      containerId,
      path: pathLabel,
      operation: 'delete',
      attempt: 1,
      success: false,
      message: err.message,
      ...(verboseStack && err.stack ? { stack: err.stack } : {}),
    });
  }
}

function resolveMaxTargets(options: { matrixFull?: boolean; matrixSlice?: boolean }): number {
  const full = options.matrixFull === true || process.env.MATRIX_FULL === '1';
  if (full) {
    return Number.POSITIVE_INFINITY;
  }
  if (options.matrixSlice === false) {
    return Number.POSITIVE_INFINITY;
  }
  const raw = process.env.MATRIX_SLICE_LIMIT;
  if (raw !== undefined && raw !== '') {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return 5;
}

/** Второй проход (реквизиты/ТЧ/формы под `Matrix_*`): полный обход или явно `MATRIX_NESTED=1`. */
function shouldRunNestedMatrixPass(maxTargets: number): boolean {
  if (!Number.isFinite(maxTargets)) {
    return true;
  }
  return process.env.MATRIX_NESTED === '1';
}

function resolveReportFile(optionsReportPath?: string): string {
  const envPath = process.env.MATRIX_REPORT_PATH?.trim();
  if (optionsReportPath) {
    return path.resolve(optionsReportPath);
  }
  if (envPath) {
    return path.resolve(envPath);
  }
  const repoRoot = getRepoRootFromCompiledTestFile();
  const dir = path.join(repoRoot, 'out', 'test', 'reports');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `container-matrix-${ts}.json`);
}

export interface RunContainerMatrixOptions {
  workDir: string;
  matrixFull?: boolean;
  matrixSlice?: boolean;
  reportPath?: string;
}

export interface RunContainerMatrixResult {
  report: ContainerMatrixReport;
  reportFile: string;
}

/**
 * Runs create×2 → delete×1 per matrix target on `workDir`, writes JSON report, then optional ibcmd stub.
 */
export async function runContainerMatrix(
  options: RunContainerMatrixOptions
): Promise<RunContainerMatrixResult> {
  const workDir = path.resolve(options.workDir);
  const repoRoot = getRepoRootFromCompiledTestFile();
  const fixturePath = path.join(repoRoot, 'FormatSamples', 'empty_conf');

  const { provider } = await buildDesignerMatrixContext(workDir);

  const targets: TreeNode[] = [];
  await dfsPreorderNodes(provider, async (n) => {
    if (isMatrixTarget(n)) {
      targets.push(n);
    }
  });

  const maxTargets = resolveMaxTargets(options);
  const selected = Number.isFinite(maxTargets) ? targets.slice(0, maxTargets) : targets;

  const steps: ContainerMatrixStep[] = [];
  const stepSummary: ContainerMatrixSummary = { passed: 0, failed: 0, skipped: 0 };

  const verboseStack = process.env.MATRIX_VERBOSE === '1';

  for (const target of selected) {
    await runMatrixTargetCycle(target, provider, workDir, steps, stepSummary, verboseStack);
  }

  if (shouldRunNestedMatrixPass(maxTargets)) {
    const { provider: providerNested } = await buildDesignerMatrixContext(workDir);
    const nestedTargets: TreeNode[] = [];
    await dfsPreorderNodes(providerNested, async (n) => {
      if (isNestedMatrixTargetUnderMatrixObject(n)) {
        nestedTargets.push(n);
      }
    });
    for (const target of nestedTargets) {
      await runMatrixTargetCycle(target, providerNested, workDir, steps, stepSummary, verboseStack);
    }
  }

  const ibcmd = await runIbcmdOnWorkDir(workDir);

  const ibcmdCheck: ContainerMatrixIbcmdBlock = await (async () => {
    if (process.env.IBMATRIX_SKIP_CONFIG_CHECK === '1') {
      return {
        status: 'skipped',
        exitCode: null,
        logSnippet: 'IBMATRIX_SKIP_CONFIG_CHECK=1 (config check not run).',
      };
    }
    if (ibcmd.status === 'skipped') {
      return {
        status: 'skipped',
        exitCode: null,
        logSnippet: 'ibcmd import skipped; config check not run.',
      };
    }
    if (ibcmd.status === 'failed') {
      return {
        status: 'skipped',
        exitCode: null,
        logSnippet: 'ibcmd import failed; config check not run.',
      };
    }
    return runIbcmdConfigCheck();
  })();

  const runId = `matrix-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const report: ContainerMatrixReport = {
    runId,
    timestamp: new Date().toISOString(),
    fixturePath,
    workDir,
    configFormat: ConfigFormat.Designer,
    steps,
    stepSummary,
    ibcmd,
    ibcmdCheck,
  };

  const reportFile = resolveReportFile(options.reportPath);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf-8');

  return { report, reportFile };
}

/**
 * Convenience: copy fixture to temp and run matrix (used by future e2e suite).
 */
export async function runContainerMatrixOnFreshFixture(
  opts?: Omit<RunContainerMatrixOptions, 'workDir'>
): Promise<RunContainerMatrixResult & { workDir: string }> {
  const workDir = copyEmptyConfFixtureToTemp();
  const { report, reportFile } = await runContainerMatrix({ ...opts, workDir });
  return { report, reportFile, workDir };
}
