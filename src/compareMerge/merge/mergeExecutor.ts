import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { parseBslRoutines } from '../../bsl/routineRangeProvider';
import { validateBslRoutineLogicalMergePlan } from '../bsl/bslRoutineMergeExecutorGuard';
import { hashText, scanBslRoutineLogicalOutline, splitSourceLines } from '../bsl/bslRoutineLogicalScanner';
import type {
  BslRoutineLogicalAnchor,
  BslRoutineLogicalMergePlan,
  BslRoutineLogicalSnapshot,
} from '../bsl/bslRoutineMergePlanTypes';
import type { CompareMessage } from '../domain/compareContracts';
import type { CompareSession } from '../domain/compareSession';
import {
  materializeTrustedPreflight,
  materializeExecutableMergePreview,
  type BackupPlan,
  type MergeOperation,
  type MergePreview,
  type PreflightResult,
} from './mergePlanner';

export interface MergeExecutorInput {
  session: CompareSession;
  preflight: PreflightResult;
  fileSystem?: MergeExecutorFileSystem;
}

export interface MergeExecutorFileSystem {
  mkdir(directoryPath: string, options: { recursive: true }): Promise<void>;
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  writeFile(filePath: string, content: string, encoding: 'utf8'): Promise<void>;
}

export interface MergeExecutionOperationResult {
  operationId: string;
  kind: MergeOperation['kind'];
  targetUri?: string;
  backupPath?: string;
  code?: string;
  message?: string;
}

export interface MergeExecutionResult {
  previewId: string;
  approvedPreviewId: string;
  applied: MergeExecutionOperationResult[];
  skipped: MergeExecutionOperationResult[];
  failed: MergeExecutionOperationResult[];
  backupPaths: string[];
  diagnostics: CompareMessage[];
}

interface ResolvedLogicalOperation {
  operation: MergeOperation;
  targetPath: string;
  backupPath: string;
  currentSource: string;
  nextSource: string;
}

const nodeFileSystem: MergeExecutorFileSystem = {
  async mkdir(directoryPath, options) {
    await fs.mkdir(directoryPath, options);
  },
  readFile(filePath, encoding) {
    return fs.readFile(filePath, encoding);
  },
  writeFile(filePath, content, encoding) {
    return fs.writeFile(filePath, content, encoding);
  },
};

export async function executeBslMergePreview(
  input: MergeExecutorInput
): Promise<MergeExecutionResult> {
  const result: MergeExecutionResult = {
    previewId: input.preflight.previewId,
    approvedPreviewId: input.preflight.approvedPreviewId,
    applied: [],
    skipped: [],
    failed: [],
    backupPaths: [],
    diagnostics: input.preflight.diagnostics.map(cloneCompareMessage),
  };

  if (!input.preflight.ok || input.preflight.approvedPreviewId !== input.preflight.previewId) {
    result.failed.push({
      operationId: input.preflight.previewId,
      kind: 'bslLogicalRoutineMerge',
      code: 'MERGE_PREFLIGHT_REQUIRED',
      message: 'Merge executor requires an approved successful preflight result.',
    });
    return result;
  }

  if (!input.session.canExecutePreview(input.preflight.approvedPreviewId)) {
    result.failed.push({
      operationId: input.preflight.approvedPreviewId,
      kind: 'bslLogicalRoutineMerge',
      code: 'MERGE_PREVIEW_NOT_EXECUTABLE',
      message: 'Approved preview is no longer executable in the compare session.',
    });
    return result;
  }

  const trustedDiagnostics: CompareMessage[] = [];
  const trustedPreview = materializeExecutableMergePreview(
    input.session.requireExecutablePreview(input.preflight.approvedPreviewId) as MergePreview,
    trustedDiagnostics
  );
  result.diagnostics.push(...trustedDiagnostics.map(cloneCompareMessage));
  if (!trustedPreview) {
    result.failed.push({
      operationId: input.preflight.approvedPreviewId,
      kind: 'bslLogicalRoutineMerge',
      code: 'MERGE_PREVIEW_NOT_EXECUTABLE',
      message: 'Approved preview payload is not executable in the compare session.',
    });
    return result;
  }

  const trustedPreflight = materializeTrustedPreflight(
    input.session,
    input.preflight.approvedPreviewId
  );
  if (!trustedPreflight) {
    result.failed.push({
      operationId: input.preflight.approvedPreviewId,
      kind: 'bslLogicalRoutineMerge',
      code: 'MERGE_PREFLIGHT_REQUIRED',
      message: 'Approved preview preflight materialization is not available for execution.',
    });
    return result;
  }

  const trustedOperations = trustedPreview.operations;
  const operationFailures = validateExecutableOperations(trustedOperations);
  if (operationFailures.length > 0) {
    result.failed.push(...operationFailures);
    return result;
  }

  const fileSystem = input.fileSystem ?? nodeFileSystem;
  const resolvedOperations: ResolvedLogicalOperation[] = [];

  for (const operation of trustedOperations) {
    const resolved = await resolveLogicalOperation(operation, trustedPreflight.backupPlan, fileSystem);
    if ('failure' in resolved) {
      result.failed.push(resolved.failure);
      continue;
    }

    resolvedOperations.push(resolved.resolved);
  }

  if (result.failed.length > 0) {
    return result;
  }

  for (const resolved of resolvedOperations) {
    try {
      await fileSystem.mkdir(path.dirname(resolved.backupPath), { recursive: true });
      await fileSystem.writeFile(resolved.backupPath, resolved.currentSource, 'utf8');
      await fileSystem.writeFile(resolved.targetPath, resolved.nextSource, 'utf8');
    } catch (error) {
      result.failed.push(
        failure(
          resolved.operation,
          'MERGE_WRITE_FAILED',
          `Failed to write merge operation: ${error instanceof Error ? error.message : String(error)}`,
          resolved.backupPath
        )
      );
      return result;
    }

    const operation = resolved.operation;
    result.applied.push({
      operationId: operation.operationId,
      kind: operation.kind,
      targetUri: operation.targetUri,
      backupPath: resolved.backupPath,
    });
    result.backupPaths.push(resolved.backupPath);
  }

  if (result.failed.length === 0 && result.skipped.length === 0) {
    input.session.markPreviewExecuted(input.preflight.approvedPreviewId);
  }

  return result;
}

async function resolveLogicalOperation(
  operation: MergeOperation,
  backupPlan: BackupPlan,
  fileSystem: MergeExecutorFileSystem
): Promise<{ resolved: ResolvedLogicalOperation } | { failure: MergeExecutionOperationResult }> {
  if (!operation.targetUri || !operation.expectedOldHash || !operation.logicalRoutine) {
    return {
      failure: failure(operation, 'MERGE_TARGET_GUARD_MISSING', 'Logical merge operation is incomplete.'),
    };
  }

  const backup = backupPlan.items.find((item) => item.operationId === operation.operationId);
  const backupPath = backup ? uriToPath(backup.backupUri) : undefined;
  if (
    !backupPath ||
    backup?.targetUri !== operation.targetUri ||
    backup.expectedOldHash !== operation.expectedOldHash
  ) {
    return {
      failure: failure(operation, 'MERGE_BACKUP_PLAN_INCOMPLETE', 'Backup plan is missing for operation.'),
    };
  }

  const targetPath = uriToPath(operation.targetUri);
  if (!targetPath) {
    return {
      failure: failure(operation, 'MERGE_TARGET_GUARD_MISSING', 'Target uri is not a file uri.'),
    };
  }

  let currentSource: string;
  try {
    currentSource = await fileSystem.readFile(targetPath, 'utf8');
  } catch (error) {
    return {
      failure: failure(
        operation,
        'MERGE_TARGET_READ_FAILED',
        `Failed to read target file: ${error instanceof Error ? error.message : String(error)}`
      ),
    };
  }
  if (hashText(currentSource) !== operation.expectedOldHash) {
    return {
      failure: failure(operation, 'MERGE_STALE_TARGET_HASH', 'Target file hash changed before execution.'),
    };
  }

  const current = currentSnapshotFor(operation, currentSource);
  if (!current) {
    return {
      failure: failure(operation, 'MERGE_LOGICAL_GUARD_BLOCKED', 'Current target routine cannot be parsed.'),
    };
  }

  const guardResult = validateBslRoutineLogicalMergePlan(operation.logicalRoutine.plan, {
    moduleId: operation.logicalRoutine.moduleId,
    current,
  });
  if (!guardResult.ok) {
    return {
      failure: failure(
        operation,
        'MERGE_LOGICAL_GUARD_BLOCKED',
        guardResult.diagnostics[0]?.message ?? 'Logical guard blocked merge execution.'
      ),
    };
  }

  const nextSource = applyLogicalInsertBlocks(current, operation.logicalRoutine.plan);
  if (!nextSource) {
    return {
      failure: failure(operation, 'MERGE_LOGICAL_GUARD_BLOCKED', 'Logical insert anchor cannot be resolved.'),
    };
  }

  return {
    resolved: {
      operation,
      targetPath,
      backupPath,
      currentSource,
      nextSource,
    },
  };
}

function validateExecutableOperations(
  operations: readonly MergeOperation[]
): MergeExecutionOperationResult[] {
  const failures: MergeExecutionOperationResult[] = [];

  for (const operation of operations) {
    if (operation.kind !== 'bslLogicalRoutineMerge') {
      failures.push(
        failure(
          operation,
          'MERGE_UNSUPPORTED_EXECUTOR_OPERATION',
          'Executor only applies logical BSL routine merge operations.'
        )
      );
    }
  }

  if (failures.length > 0) {
    return failures;
  }

  const operationsByTarget = new Map<string, MergeOperation[]>();
  for (const operation of operations) {
    const targetKey = targetKeyFor(operation);
    if (!targetKey) {
      continue;
    }

    const targetOperations = operationsByTarget.get(targetKey) ?? [];
    targetOperations.push(operation);
    operationsByTarget.set(targetKey, targetOperations);
  }

  for (const targetOperations of operationsByTarget.values()) {
    if (targetOperations.length <= 1) {
      continue;
    }

    failures.push(
      ...targetOperations.map((operation) =>
        failure(
          operation,
          'MERGE_MULTIPLE_OPERATIONS_SAME_TARGET',
          'Executor MVP blocks multiple logical operations targeting the same file.'
        )
      )
    );
  }

  return failures;
}

function targetKeyFor(operation: MergeOperation): string | undefined {
  if (!operation.targetUri) {
    return undefined;
  }

  const targetPath = uriToPath(operation.targetUri);
  if (targetPath) {
    return normalizeDuplicateTargetKey(targetPath);
  }

  return process.platform === 'win32' && path.isAbsolute(operation.targetUri)
    ? normalizeDuplicateTargetKey(operation.targetUri)
    : operation.targetUri;
}

function normalizeDuplicateTargetKey(targetPath: string): string {
  const normalized = path.normalize(targetPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function currentSnapshotFor(
  operation: MergeOperation,
  source: string
): BslRoutineLogicalSnapshot | undefined {
  const parsed = parseBslRoutines(source);
  if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return undefined;
  }

  const expectedRoutine = operation.logicalRoutine?.plan.routine;
  const routine = parsed.routines.find(
    (item) =>
      item.normalizedName === expectedRoutine?.normalizedName &&
      item.kind === expectedRoutine.kind &&
      item.exported === expectedRoutine.exported
  );
  return routine
    ? {
        source,
        routine,
      }
    : undefined;
}

function applyLogicalInsertBlocks(
  current: BslRoutineLogicalSnapshot,
  plan: BslRoutineLogicalMergePlan
): string | undefined {
  const scan = scanBslRoutineLogicalOutline(current);
  const eol = scan.eol;
  const insertions: { offset: number; text: string }[] = [];

  for (const operation of plan.operations) {
    if (operation.kind !== 'insertBlock') {
      return undefined;
    }

    const afterLine = anchorEndLine(scan, operation.startAnchor);
    if (afterLine === undefined) {
      return undefined;
    }

    const offset = offsetAfterLine(current.source, afterLine);
    if (offset === undefined) {
      return undefined;
    }

    insertions.push({
      offset,
      text: ensureTrailingEol(normalizeEol(operation.sourceText, eol), eol),
    });
  }

  let nextSource = current.source;
  insertions.sort((left, right) => right.offset - left.offset);
  for (const insertion of insertions) {
    nextSource =
      nextSource.slice(0, insertion.offset) + insertion.text + nextSource.slice(insertion.offset);
  }

  return nextSource;
}

function anchorEndLine(
  scanResult: ReturnType<typeof scanBslRoutineLogicalOutline>,
  anchor: BslRoutineLogicalAnchor
): number | undefined {
  if (anchor.kind === 'sentinel') {
    const section = scanResult.outline.sections[anchor.sectionId];
    return anchor.sentinel === 'section-start' ? section?.startLine - 1 : section?.endLine;
  }

  return scanResult.outline.nodesByPath[anchor.path]?.range.endLine;
}

function normalizeEol(text: string, eol: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, eol);
}

function ensureTrailingEol(text: string, eol: string): string {
  return text.endsWith(eol) ? text : `${text}${eol}`;
}

function offsetAfterLine(source: string, lineNumber: number): number | undefined {
  if (lineNumber === 0) {
    return 0;
  }

  const lines = splitSourceLines(source);
  if (lineNumber < 0 || lineNumber > lines.length) {
    return undefined;
  }

  return lines
    .slice(0, lineNumber)
    .reduce((offset, line) => offset + line.text.length + line.eol.length, 0);
}

function uriToPath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function failure(
  operation: MergeOperation,
  code: string,
  message: string,
  backupPath?: string
): MergeExecutionOperationResult {
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    targetUri: operation.targetUri,
    backupPath,
    code,
    message,
  };
}

function cloneCompareMessage(message: CompareMessage): CompareMessage {
  return {
    ...message,
    range: message.range ? { ...message.range } : undefined,
  };
}
