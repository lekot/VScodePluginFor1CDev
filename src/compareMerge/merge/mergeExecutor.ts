import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { parseBslRoutines } from '../../bsl/routineRangeProvider';
import type { BslRoutineInfo, BslTextRange } from '../../bsl/bslRoutineTypes';
import { validateBslRoutineLogicalMergePlan } from '../bsl/bslRoutineMergeExecutorGuard';
import {
  hashText,
  scanBslRoutineLogicalOutline,
  splitSourceLines,
} from '../bsl/bslRoutineLogicalScanner';
import type {
  BslRoutineLogicalAnchor,
  BslRoutineLogicalMergePlan,
  BslRoutineLogicalSnapshot,
} from '../bsl/bslRoutineMergePlanTypes';
import type { CompareMessage } from '../domain/compareContracts';
import type { CompareSession } from '../domain/compareSession';
import { applyXmlPatch as applyDomXmlPatch } from '../xml/xmlPatch';
import {
  materializeTrustedPreflight,
  materializeExecutableMergePreview,
  MISSING_TARGET_HASH,
  type BackupPlan,
  type MergeOperation,
  type MergePreview,
  type PreflightResult,
} from './mergePlanner';
import { writeAtomicWithBackup, type AtomicWriteFileSystem } from './atomicFileWriter';

export interface MergeExecutorInput {
  session: CompareSession;
  preflight: PreflightResult;
  fileSystem?: MergeExecutorFileSystem;
}

export type MergeExecutorFileSystem = AtomicWriteFileSystem;

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

type ResolvedOperation =
  | ResolvedTextWriteOperation
  | ResolvedFileCopyOperation
  | ResolvedFileDeleteOperation
  | ResolvedFolderOperation;

type ResolvedExecutionUnit = ResolvedOperation | ResolvedXmlTextWriteGroup;

interface ResolvedTextWriteOperation {
  type: 'textWrite';
  operation: MergeOperation;
  targetPath: string;
  backupPath: string;
  rootUri?: string;
  currentSource: string;
  nextSource: string;
}

interface ResolvedXmlTextWriteGroup {
  type: 'xmlTextWriteGroup';
  operations: ResolvedTextWriteOperation[];
  targetPath: string;
  backupPath: string;
  rootUri?: string;
  currentSource: string;
  nextSource: string;
}

interface ResolvedFileDeleteOperation {
  type: 'fileDelete';
  operation: MergeOperation;
  targetPath: string;
  backupPath: string;
  expectedOldHash: string;
}

interface ResolvedFileCopyOperation {
  type: 'fileCopy';
  operation: MergeOperation;
  sourcePath: string;
  sourceRootUri: string;
  targetPath: string;
  backupPath: string;
  expectedOldHash: string;
  sourceHash: string;
}

interface ResolvedFolderOperation {
  type: 'folderCopy' | 'folderDelete';
  operation: MergeOperation;
  sourcePath?: string;
  sourceRootUri?: string;
  targetPath: string;
  backupPath: string;
  expectedOldHash: string;
  sourceHash?: string;
}

const nodeFileSystem: MergeExecutorFileSystem = {
  async mkdir(directoryPath, options) {
    await fs.mkdir(directoryPath, options);
  },
  realpath(filePath) {
    return fs.realpath(filePath);
  },
  readFile(filePath, encoding) {
    return fs.readFile(filePath, encoding);
  },
  open(filePath, flags) {
    return fs.open(filePath, flags);
  },
  rename(oldPath, newPath) {
    return fs.rename(oldPath, newPath);
  },
  copyFile(sourcePath, targetPath) {
    return fs.copyFile(sourcePath, targetPath);
  },
  async rm(filePath, options) {
    await fs.rm(filePath, options);
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
  const rootUri = targetRootUriFor(input.session, trustedPreview.targetSourceId);
  if (!rootUri) {
    result.failed.push(
      failureForPreview(
        input.preflight.approvedPreviewId,
        'MERGE_TARGET_ROOT_MISSING',
        'Left configuration root is not available for merge execution.'
      )
    );
    return result;
  }

  const resolvedOperations: ResolvedOperation[] = [];

  for (const operation of trustedOperations) {
    const sourceRootUri = sourceRootUriFor(input.session, operation.sourceId, operation.snapshotId);
    const resolved = await resolveOperation(
      operation,
      trustedPreflight.backupPlan,
      fileSystem,
      rootUri,
      sourceRootUri
    );
    if ('failure' in resolved) {
      result.failed.push(resolved.failure);
      continue;
    }

    resolvedOperations.push(resolved.resolved);
  }

  if (result.failed.length > 0) {
    return result;
  }

  const executionUnits = buildExecutionUnits(resolvedOperations);
  const appliedOperations: ResolvedExecutionUnit[] = [];
  for (const resolved of executionUnits) {
    const applyResult = await applyResolvedOperation(resolved, fileSystem, rootUri);
    result.diagnostics.push(...applyResult.diagnostics.map(cloneCompareMessage));
    if (!applyResult.ok) {
      const failedOperation = firstOperationOf(resolved);
      result.failed.push(
        failure(
          failedOperation,
          applyResult.code,
          applyResult.message,
          applyResult.backupPath ?? resolved.backupPath
        )
      );
      const rollbackResult = await rollbackAppliedOperations(appliedOperations, fileSystem);
      result.failed.push(...rollbackResult.failed);
      result.diagnostics.push(...rollbackResult.diagnostics);
      return result;
    }

    for (const operation of operationsOf(resolved)) {
      result.applied.push({
        operationId: operation.operationId,
        kind: operation.kind,
        targetUri: operation.targetUri,
        backupPath: resolved.backupPath,
      });
    }
    result.backupPaths.push(resolved.backupPath);
    appliedOperations.push(resolved);
  }

  if (result.failed.length === 0 && result.skipped.length === 0) {
    input.session.markPreviewExecuted(input.preflight.approvedPreviewId);
  }

  return result;
}

async function resolveOperation(
  operation: MergeOperation,
  backupPlan: BackupPlan,
  fileSystem: MergeExecutorFileSystem,
  rootUri: string,
  sourceRootUri: string | undefined
): Promise<{ resolved: ResolvedOperation } | { failure: MergeExecutionOperationResult }> {
  if (operation.kind === 'bslLogicalRoutineMerge') {
    return resolveLogicalOperation(operation, backupPlan, fileSystem, rootUri);
  }
  if (operation.kind === 'bslRoutineInsert' || operation.kind === 'bslRoutineDelete') {
    return resolveBslRoutineOperation(operation, backupPlan, fileSystem, rootUri);
  }
  if (operation.kind === 'xmlNodeReplace' || operation.kind === 'xmlNodeInsert' || operation.kind === 'xmlNodeDelete') {
    return resolveXmlOperation(operation, backupPlan, fileSystem, rootUri);
  }
  if (operation.kind === 'fileCopy') {
    return resolveFileCopyOperation(operation, backupPlan, fileSystem, rootUri, sourceRootUri);
  }
  if (operation.kind === 'fileDelete') {
    return resolveFileDeleteOperation(operation, backupPlan, fileSystem, rootUri);
  }
  if (operation.kind === 'folderCopy' || operation.kind === 'folderDelete') {
    return resolveFolderOperation(operation, backupPlan, rootUri, sourceRootUri);
  }

  return {
    failure: failure(
      operation,
      'MERGE_UNSUPPORTED_EXECUTOR_OPERATION',
      `Executor cannot apply ${operation.kind} operations yet.`
    ),
  };
}

async function resolveLogicalOperation(
  operation: MergeOperation,
  backupPlan: BackupPlan,
  fileSystem: MergeExecutorFileSystem,
  rootUri: string
): Promise<{ resolved: ResolvedTextWriteOperation } | { failure: MergeExecutionOperationResult }> {
  if (!operation.targetUri || !operation.expectedOldHash || !operation.logicalRoutine) {
    return {
      failure: failure(
        operation,
        'MERGE_TARGET_GUARD_MISSING',
        'Logical merge operation is incomplete.'
      ),
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
      failure: failure(
        operation,
        'MERGE_BACKUP_PLAN_INCOMPLETE',
        'Backup plan is missing for operation.'
      ),
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
      failure: failure(
        operation,
        'MERGE_STALE_TARGET_HASH',
        'Target file hash changed before execution.'
      ),
    };
  }

  const current = currentSnapshotFor(operation, currentSource);
  if (!current) {
    return {
      failure: failure(
        operation,
        'MERGE_LOGICAL_GUARD_BLOCKED',
        'Current target routine cannot be parsed.'
      ),
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
      failure: failure(
        operation,
        'MERGE_LOGICAL_GUARD_BLOCKED',
        'Logical insert anchor cannot be resolved.'
      ),
    };
  }

  return {
    resolved: {
      type: 'textWrite',
      operation,
      targetPath,
      backupPath,
      rootUri,
      currentSource,
      nextSource,
    },
  };
}

async function resolveXmlOperation(
  operation: MergeOperation,
  backupPlan: BackupPlan,
  fileSystem: MergeExecutorFileSystem,
  rootUri: string
): Promise<{ resolved: ResolvedTextWriteOperation } | { failure: MergeExecutionOperationResult }> {
  if (!operation.targetUri || !operation.expectedOldHash || !operation.newHash || !operation.xmlPatch) {
    return {
      failure: failure(operation, 'MERGE_TARGET_GUARD_MISSING', 'XML merge operation is incomplete.'),
    };
  }

  const backup = backupItemFor(operation, backupPlan);
  if (!backup) {
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
      failure: failure(operation, 'MERGE_TARGET_READ_FAILED', `Failed to read target file: ${errorMessage(error)}`),
    };
  }
  if (hashText(currentSource) !== operation.expectedOldHash) {
    return {
      failure: failure(operation, 'MERGE_STALE_TARGET_HASH', 'Target XML file hash changed before execution.'),
    };
  }

  let nextSource: string;
  try {
    nextSource = applyDomXmlPatch(currentSource, operation.xmlPatch);
  } catch (error) {
    return {
      failure: failure(
        operation,
        'MERGE_XML_PATCH_FAILED',
        `XML patch target cannot be resolved: ${errorMessage(error)}`
      ),
    };
  }

  return {
    resolved: {
      type: 'textWrite',
      operation,
      targetPath,
      backupPath: backup.backupPath,
      rootUri,
      currentSource,
      nextSource,
    },
  };
}

async function resolveBslRoutineOperation(
  operation: MergeOperation,
  backupPlan: BackupPlan,
  fileSystem: MergeExecutorFileSystem,
  rootUri: string
): Promise<{ resolved: ResolvedTextWriteOperation } | { failure: MergeExecutionOperationResult }> {
  const payload = operation.bslRoutine;
  if (!operation.targetUri || !operation.expectedOldHash || !operation.newHash || !payload) {
    return {
      failure: failure(operation, 'MERGE_TARGET_GUARD_MISSING', 'BSL routine operation is incomplete.'),
    };
  }
  if (
    payload.targetPath !== operation.targetUri ||
    payload.expectedOldHash !== operation.expectedOldHash ||
    payload.newHash !== operation.newHash ||
    payload.kind !== bslPayloadKindForOperation(operation.kind)
  ) {
    return {
      failure: failure(
        operation,
        'MERGE_BSL_ROUTINE_GUARD_MISMATCH',
        'BSL routine payload does not match merge operation guards.'
      ),
    };
  }

  const backup = backupItemFor(operation, backupPlan);
  if (!backup) {
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
      failure: failure(operation, 'MERGE_TARGET_READ_FAILED', `Failed to read target file: ${errorMessage(error)}`),
    };
  }
  if (hashText(currentSource) !== operation.expectedOldHash) {
    return {
      failure: failure(operation, 'MERGE_STALE_TARGET_HASH', 'Target BSL file hash changed before execution.'),
    };
  }

  const nextSource =
    operation.kind === 'bslRoutineInsert'
      ? applyBslRoutineInsert(currentSource, operation)
      : applyBslRoutineDelete(currentSource, operation);
  if (!nextSource) {
    return {
      failure: failure(
        operation,
        'MERGE_BSL_ROUTINE_GUARD_BLOCKED',
        'BSL routine guard blocked merge execution.'
      ),
    };
  }
  if (hashText(nextSource) !== operation.newHash) {
    return {
      failure: failure(
        operation,
        'MERGE_POST_WRITE_HASH_MISMATCH',
        'BSL routine operation result does not match merge preview hash.'
      ),
    };
  }

  return {
    resolved: {
      type: 'textWrite',
      operation,
      targetPath,
      backupPath: backup.backupPath,
      rootUri,
      currentSource,
      nextSource,
    },
  };
}

async function resolveFileCopyOperation(
  operation: MergeOperation,
  backupPlan: BackupPlan,
  fileSystem: MergeExecutorFileSystem,
  rootUri: string,
  sourceRootUri: string | undefined
): Promise<{ resolved: ResolvedFileCopyOperation } | { failure: MergeExecutionOperationResult }> {
  const payload = operation.fileOperation;
  if (
    !payload?.sourcePath ||
    !payload.sourceHash ||
    !operation.targetUri ||
    !operation.expectedOldHash ||
    !operation.newHash
  ) {
    return {
      failure: failure(operation, 'MERGE_TARGET_GUARD_MISSING', 'File copy operation is incomplete.'),
    };
  }

  const backup = backupItemFor(operation, backupPlan);
  if (!backup) {
    return {
      failure: failure(operation, 'MERGE_BACKUP_PLAN_INCOMPLETE', 'Backup plan is missing for operation.'),
    };
  }

  const sourcePath = uriToPath(payload.sourcePath) ?? payload.sourcePath;
  const targetPath = uriToPath(operation.targetUri);
  if (!targetPath) {
    return {
      failure: failure(operation, 'MERGE_TARGET_GUARD_MISSING', 'Target uri is not a file uri.'),
    };
  }

  const boundaryFailure = await ensureTargetInsideRootAllowMissing(rootUri, targetPath);
  if (boundaryFailure) {
    return { failure: failure(operation, boundaryFailure.code, boundaryFailure.message) };
  }
  const sourceBoundaryFailure = await ensureSourceInsideRoot(sourceRootUri, sourcePath);
  if (sourceBoundaryFailure) {
    return { failure: failure(operation, sourceBoundaryFailure.code, sourceBoundaryFailure.message) };
  }

  let sourceHash: string;
  try {
    sourceHash = hashBuffer(await readBinaryFile(sourcePath, fileSystem));
  } catch (error) {
    return {
      failure: failure(operation, 'MERGE_TARGET_READ_FAILED', `Failed to read source file: ${errorMessage(error)}`),
    };
  }
  if (sourceHash !== payload.sourceHash || sourceHash !== operation.newHash) {
    return {
      failure: failure(operation, 'MERGE_SOURCE_HASH_MISMATCH', 'Source file hash does not match merge preview.'),
    };
  }

  const currentHash = await hashFileOrMissing(targetPath, fileSystem);
  if (currentHash !== operation.expectedOldHash) {
    return {
      failure: failure(operation, 'MERGE_STALE_TARGET_HASH', 'Target file hash changed before execution.'),
    };
  }

  return {
    resolved: {
      type: 'fileCopy',
      operation,
      sourcePath,
      sourceRootUri: sourceRootUri!,
      targetPath,
      backupPath: backup.backupPath,
      expectedOldHash: operation.expectedOldHash,
      sourceHash,
    },
  };
}

async function resolveFileDeleteOperation(
  operation: MergeOperation,
  backupPlan: BackupPlan,
  fileSystem: MergeExecutorFileSystem,
  rootUri: string
): Promise<{ resolved: ResolvedFileDeleteOperation } | { failure: MergeExecutionOperationResult }> {
  if (!operation.targetUri || !operation.expectedOldHash) {
    return {
      failure: failure(operation, 'MERGE_TARGET_GUARD_MISSING', 'File delete operation is incomplete.'),
    };
  }

  const backup = backupItemFor(operation, backupPlan);
  const targetPath = uriToPath(operation.targetUri);
  if (!backup || !targetPath) {
    return {
      failure: failure(operation, 'MERGE_BACKUP_PLAN_INCOMPLETE', 'Backup plan or target uri is missing for operation.'),
    };
  }

  const boundaryFailure = await ensureTargetInsideRootAllowMissing(rootUri, targetPath);
  if (boundaryFailure) {
    return { failure: failure(operation, boundaryFailure.code, boundaryFailure.message) };
  }

  let currentHash: string;
  try {
    currentHash = hashBuffer(await readBinaryFile(targetPath, fileSystem));
  } catch (error) {
    return {
      failure: failure(operation, 'MERGE_TARGET_READ_FAILED', `Failed to read target file: ${errorMessage(error)}`),
    };
  }
  if (currentHash !== operation.expectedOldHash) {
    return {
      failure: failure(operation, 'MERGE_STALE_TARGET_HASH', 'Target file hash changed before execution.'),
    };
  }

  return {
    resolved: {
      type: 'fileDelete',
      operation,
      targetPath,
      backupPath: backup.backupPath,
      expectedOldHash: operation.expectedOldHash,
    },
  };
}

async function resolveFolderOperation(
  operation: MergeOperation,
  backupPlan: BackupPlan,
  rootUri: string,
  sourceRootUri: string | undefined
): Promise<{ resolved: ResolvedFolderOperation } | { failure: MergeExecutionOperationResult }> {
  const payload = operation.fileOperation;
  if (!payload || !operation.targetUri || !operation.expectedOldHash) {
    return {
      failure: failure(operation, 'MERGE_TARGET_GUARD_MISSING', 'Folder operation is incomplete.'),
    };
  }

  const backup = backupItemFor(operation, backupPlan);
  const targetPath = uriToPath(operation.targetUri);
  const sourcePath = payload.sourcePath ? uriToPath(payload.sourcePath) ?? payload.sourcePath : undefined;
  if (!backup || !targetPath) {
    return {
      failure: failure(operation, 'MERGE_BACKUP_PLAN_INCOMPLETE', 'Backup plan or target uri is missing for operation.'),
    };
  }

  const boundaryFailure = await ensureTargetInsideRootAllowMissing(rootUri, targetPath);
  if (boundaryFailure) {
    return { failure: failure(operation, boundaryFailure.code, boundaryFailure.message) };
  }

  const currentHash = await hashDirectoryOrMissing(targetPath);
  if (currentHash !== operation.expectedOldHash) {
    return {
      failure: failure(operation, 'MERGE_STALE_TARGET_HASH', 'Target folder hash changed before execution.'),
    };
  }
  if (operation.kind === 'folderCopy') {
    if (!sourcePath || !payload.sourceHash) {
      return {
        failure: failure(operation, 'MERGE_FILE_OPERATION_SOURCE_MISSING', 'Folder copy source is missing.'),
      };
    }
    const sourceBoundaryFailure = await ensureSourceInsideRoot(sourceRootUri, sourcePath);
    if (sourceBoundaryFailure) {
      return { failure: failure(operation, sourceBoundaryFailure.code, sourceBoundaryFailure.message) };
    }
    const sourceHash = await hashDirectory(sourcePath);
    if (sourceHash !== payload.sourceHash || (operation.newHash && sourceHash !== operation.newHash)) {
      return {
        failure: failure(operation, 'MERGE_SOURCE_HASH_MISMATCH', 'Source folder hash does not match merge preview.'),
      };
    }
  }

  return {
    resolved: {
      type: operation.kind === 'folderCopy' ? 'folderCopy' : 'folderDelete',
      operation,
      sourcePath,
      sourceRootUri,
      targetPath,
      backupPath: backup.backupPath,
      expectedOldHash: operation.expectedOldHash,
      sourceHash: operation.kind === 'folderCopy' ? payload.sourceHash : undefined,
    },
  };
}

async function applyResolvedOperation(
  resolved: ResolvedExecutionUnit,
  fileSystem: MergeExecutorFileSystem,
  rootUri: string
): Promise<{ ok: true; backupPath: string; diagnostics: [] } | { ok: false; code: string; message: string; backupPath?: string; diagnostics: CompareMessage[] }> {
  if (resolved.type === 'textWrite' || resolved.type === 'xmlTextWriteGroup') {
    const operation = firstOperationOf(resolved);
    const nextContentResult =
      resolved.type === 'xmlTextWriteGroup'
        ? applyXmlTextWriteGroup(resolved)
        : { ok: true as const, source: resolved.nextSource };
    if (!nextContentResult.ok) {
      return {
        ok: false,
        code: nextContentResult.code,
        message: nextContentResult.message,
        backupPath: resolved.backupPath,
        diagnostics: [executeDiagnostic(operation, nextContentResult.code, nextContentResult.message)],
      };
    }
    const writeResult = await writeAtomicWithBackup({
      rootUri: resolved.rootUri,
      targetUri: operation.targetUri ?? '',
      backupPath: resolved.backupPath,
      expectedOldHash: operation.expectedOldHash ?? '',
      nextContent: nextContentResult.source,
      newHash: hashText(nextContentResult.source),
      sourceId: operation.sourceId,
      nodeId: operation.nodeId,
      fileSystem,
    });
    if (!writeResult.ok) {
      return writeResult;
    }

    return { ok: true, backupPath: writeResult.backupPath, diagnostics: [] };
  }

  if (resolved.type === 'fileCopy') {
    return applyFileCopy(resolved, fileSystem, rootUri);
  }

  if (resolved.type === 'fileDelete') {
    return applyFileDelete(resolved, fileSystem, rootUri);
  }

  return applyFolderOperation(resolved, rootUri);
}

async function rollbackAppliedOperations(
  appliedOperations: readonly ResolvedExecutionUnit[],
  fileSystem: MergeExecutorFileSystem
): Promise<{ failed: MergeExecutionOperationResult[]; diagnostics: CompareMessage[] }> {
  const failed: MergeExecutionOperationResult[] = [];
  const diagnostics: CompareMessage[] = [];

  for (const resolved of [...appliedOperations].reverse()) {
    const rollback = await rollbackResolvedOperation(resolved, fileSystem);
    if (!rollback.ok) {
      const operation = firstOperationOf(resolved);
      failed.push(
        failure(
          operation,
          rollback.code,
          rollback.message,
          resolved.backupPath
        )
      );
      diagnostics.push(executeDiagnostic(operation, rollback.code, rollback.message));
    }
  }

  return { failed, diagnostics };
}

async function rollbackResolvedOperation(
  resolved: ResolvedExecutionUnit,
  fileSystem: MergeExecutorFileSystem
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  try {
    if (resolved.type === 'xmlTextWriteGroup') {
      await fileSystem.mkdir(path.dirname(resolved.targetPath), { recursive: true });
      await fileSystem.copyFile(resolved.backupPath, resolved.targetPath);
      return { ok: true };
    }

    if (resolved.type === 'folderCopy' || resolved.type === 'folderDelete') {
      await rollbackFolderOperation(resolved);
      return { ok: true };
    }

    if (isMissingTargetRollback(resolved)) {
      await fileSystem.rm(resolved.targetPath, { force: true });
      return { ok: true };
    }

    await fileSystem.mkdir(path.dirname(resolved.targetPath), { recursive: true });
    await fileSystem.copyFile(resolved.backupPath, resolved.targetPath);
    return { ok: true };
  } catch (error) {
    const operation = firstOperationOf(resolved);
    return {
      ok: false,
      code: 'MERGE_ROLLBACK_FAILED',
      message: `Rollback failed for ${operation.kind} operation ${operation.operationId}: ${errorMessage(error)}`,
    };
  }
}

async function rollbackFolderOperation(resolved: ResolvedFolderOperation): Promise<void> {
  if (resolved.expectedOldHash === MISSING_TARGET_HASH) {
    await fs.rm(resolved.targetPath, { recursive: true, force: true });
    return;
  }

  await fs.rm(resolved.targetPath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(resolved.targetPath), { recursive: true });
  await fs.cp(resolved.backupPath, resolved.targetPath, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
}

function isMissingTargetRollback(resolved: ResolvedOperation): boolean {
  return (
    (resolved.type === 'fileCopy' || resolved.type === 'folderCopy') &&
    resolved.expectedOldHash === MISSING_TARGET_HASH
  );
}

function buildExecutionUnits(
  resolvedOperations: readonly ResolvedOperation[]
): ResolvedExecutionUnit[] {
  const units: ResolvedExecutionUnit[] = [];
  const groupedIndexes = new Set<number>();

  for (let index = 0; index < resolvedOperations.length; index += 1) {
    if (groupedIndexes.has(index)) {
      continue;
    }

    const resolved = resolvedOperations[index]!;
    if (!isXmlTextWrite(resolved)) {
      units.push(resolved);
      continue;
    }

    const group = [resolved];
    for (let nextIndex = index + 1; nextIndex < resolvedOperations.length; nextIndex += 1) {
      const next = resolvedOperations[nextIndex]!;
      if (isXmlTextWrite(next) && next.targetPath === resolved.targetPath) {
        group.push(next);
        groupedIndexes.add(nextIndex);
      }
    }

    units.push(group.length === 1 ? resolved : buildXmlTextWriteGroup(group));
  }

  return units;
}

function buildXmlTextWriteGroup(
  operations: readonly ResolvedTextWriteOperation[]
): ResolvedXmlTextWriteGroup {
  const [first] = operations;
  return {
    type: 'xmlTextWriteGroup',
    operations: [...operations],
    targetPath: first.targetPath,
    backupPath: first.backupPath,
    rootUri: first.rootUri,
    currentSource: first.currentSource,
    nextSource: first.currentSource,
  };
}

function applyXmlTextWriteGroup(
  group: ResolvedXmlTextWriteGroup
): { ok: true; source: string } | { ok: false; code: string; message: string } {
  let nextSource = group.currentSource;
  for (const resolved of group.operations) {
    if (!resolved.operation.xmlPatch) {
      return {
        ok: false,
        code: 'MERGE_XML_PATCH_FAILED',
        message: `XML merge operation ${resolved.operation.operationId} is missing patch payload.`,
      };
    }
    try {
      nextSource = applyDomXmlPatch(nextSource, {
        ...resolved.operation.xmlPatch,
        expectedOldHash: hashText(nextSource),
      });
    } catch (error) {
      return {
        ok: false,
        code: 'MERGE_XML_PATCH_FAILED',
        message: `XML patch target cannot be resolved: ${errorMessage(error)}`,
      };
    }
  }

  return { ok: true, source: nextSource };
}

function isXmlTextWrite(resolved: ResolvedOperation): resolved is ResolvedTextWriteOperation {
  return resolved.type === 'textWrite' && isXmlOperationKind(resolved.operation.kind);
}

function isXmlOperationKind(kind: MergeOperation['kind']): boolean {
  return kind === 'xmlNodeReplace' || kind === 'xmlNodeInsert' || kind === 'xmlNodeDelete';
}

function firstOperationOf(resolved: ResolvedExecutionUnit): MergeOperation {
  return resolved.type === 'xmlTextWriteGroup'
    ? resolved.operations[0]!.operation
    : resolved.operation;
}

function operationsOf(resolved: ResolvedExecutionUnit): MergeOperation[] {
  return resolved.type === 'xmlTextWriteGroup'
    ? resolved.operations.map((operation) => operation.operation)
    : [resolved.operation];
}

function validateExecutableOperations(
  operations: readonly MergeOperation[]
): MergeExecutionOperationResult[] {
  const failures = operations
    .filter((operation) => !isExecutorSupportedOperation(operation.kind))
    .map((operation) =>
      failure(
        operation,
        'MERGE_UNSUPPORTED_EXECUTOR_OPERATION',
        `Executor cannot apply ${operation.kind} operations yet.`
      )
    );
  const logicalOperations = operations.filter((operation) => operation.kind === 'bslLogicalRoutineMerge');
  if (logicalOperations.length > 1) {
    const logicalTargetCount = new Set(logicalOperations.map(targetKeyForOperation)).size;
    const code =
      logicalTargetCount > 1 ? 'MERGE_MULTIPLE_TARGET_FILES' : 'MERGE_MULTIPLE_EXECUTABLE_OPERATIONS';
    const message =
      logicalTargetCount > 1
        ? 'Executor applies only one target file per approved merge preview.'
        : 'Executor applies exactly one logical BSL routine operation per approved merge preview.';
    failures.push(
      ...logicalOperations.map((operation) =>
        failure(
          operation,
          code,
          message
        )
      )
    );
  }
  const bslTextWritesByTarget = new Map<string, MergeOperation[]>();
  for (const operation of operations.filter(isBslTextWriteOperation)) {
    const targetKey = targetKeyForOperation(operation);
    const targetOperations = bslTextWritesByTarget.get(targetKey) ?? [];
    targetOperations.push(operation);
    bslTextWritesByTarget.set(targetKey, targetOperations);
  }
  for (const targetOperations of bslTextWritesByTarget.values()) {
    if (
      targetOperations.length > 1 &&
      targetOperations.some((operation) => operation.kind !== 'bslLogicalRoutineMerge')
    ) {
      failures.push(
        ...targetOperations.map((operation) =>
          failure(
            operation,
            'MERGE_MULTIPLE_BSL_TEXT_OPERATIONS',
            'Executor applies only one BSL text write per target file in an approved merge preview.'
          )
        )
      );
    }
  }

  return failures;
}

function targetKeyForOperation(operation: MergeOperation): string {
  if (!operation.targetUri) {
    return operation.operationId;
  }

  return normalizeBoundaryPath(uriToPath(operation.targetUri) ?? operation.targetUri);
}

function isExecutorSupportedOperation(kind: MergeOperation['kind']): boolean {
  return (
    kind === 'bslLogicalRoutineMerge' ||
    kind === 'bslRoutineInsert' ||
    kind === 'bslRoutineDelete' ||
    kind === 'xmlNodeReplace' ||
    kind === 'xmlNodeInsert' ||
    kind === 'xmlNodeDelete' ||
    kind === 'fileCopy' ||
    kind === 'fileDelete' ||
    kind === 'folderCopy' ||
    kind === 'folderDelete'
  );
}

function isBslTextWriteOperation(operation: MergeOperation): boolean {
  return (
    operation.kind === 'bslLogicalRoutineMerge' ||
    operation.kind === 'bslRoutineInsert' ||
    operation.kind === 'bslRoutineDelete'
  );
}

function backupItemFor(
  operation: MergeOperation,
  backupPlan: BackupPlan
): { backupPath: string } | undefined {
  const backup = backupPlan.items.find((item) => item.operationId === operation.operationId);
  const backupPath = backup ? uriToPath(backup.backupUri) : undefined;
  if (
    !backup ||
    !backupPath ||
    backup.targetUri !== operation.targetUri ||
    backup.expectedOldHash !== operation.expectedOldHash
  ) {
    return undefined;
  }

  return { backupPath };
}

async function applyFileDelete(
  resolved: ResolvedFileDeleteOperation,
  fileSystem: MergeExecutorFileSystem,
  rootUri: string
): Promise<{ ok: true; backupPath: string; diagnostics: [] } | { ok: false; code: string; message: string; backupPath?: string; diagnostics: CompareMessage[] }> {
  const boundaryFailure = await ensureTargetInsideRoot(rootUri, resolved.targetPath);
  if (boundaryFailure) {
    return {
      ok: false,
      ...boundaryFailure,
      diagnostics: [executeDiagnostic(resolved.operation, boundaryFailure.code, boundaryFailure.message)],
    };
  }

  try {
    const current = await readBinaryFile(resolved.targetPath, fileSystem);
    if (hashBuffer(current) !== resolved.expectedOldHash) {
      return {
        ok: false,
        code: 'MERGE_STALE_TARGET_HASH',
        message: 'Target file hash changed immediately before deletion.',
        diagnostics: [
          executeDiagnostic(
            resolved.operation,
            'MERGE_STALE_TARGET_HASH',
            'Target file hash changed immediately before deletion.'
          ),
        ],
      };
    }
    await fileSystem.mkdir(path.dirname(resolved.backupPath), { recursive: true });
    await fileSystem.copyFile(resolved.targetPath, resolved.backupPath);
    await fileSystem.rm(resolved.targetPath, { force: true });
    return { ok: true, backupPath: resolved.backupPath, diagnostics: [] };
  } catch (error) {
    return {
      ok: false,
      code: 'MERGE_FILE_DELETE_FAILED',
      message: `File delete failed: ${errorMessage(error)}`,
      backupPath: resolved.backupPath,
      diagnostics: [
        executeDiagnostic(
          resolved.operation,
          'MERGE_FILE_DELETE_FAILED',
          `File delete failed: ${errorMessage(error)}`
        ),
      ],
    };
  }
}

async function applyFileCopy(
  resolved: ResolvedFileCopyOperation,
  fileSystem: MergeExecutorFileSystem,
  rootUri: string
): Promise<{ ok: true; backupPath: string; diagnostics: [] } | { ok: false; code: string; message: string; backupPath?: string; diagnostics: CompareMessage[] }> {
  const boundaryFailure = await ensureTargetInsideRootAllowMissing(rootUri, resolved.targetPath);
  if (boundaryFailure) {
    return {
      ok: false,
      ...boundaryFailure,
      diagnostics: [executeDiagnostic(resolved.operation, boundaryFailure.code, boundaryFailure.message)],
    };
  }
  const sourceBoundaryFailure = await ensureSourceInsideRoot(resolved.sourceRootUri, resolved.sourcePath);
  if (sourceBoundaryFailure) {
    return {
      ok: false,
      ...sourceBoundaryFailure,
      diagnostics: [executeDiagnostic(resolved.operation, sourceBoundaryFailure.code, sourceBoundaryFailure.message)],
    };
  }

  let targetMutationStarted = false;
  try {
    const sourceHash = hashBuffer(await readBinaryFile(resolved.sourcePath, fileSystem));
    if (sourceHash !== resolved.sourceHash || sourceHash !== resolved.operation.newHash) {
      return {
        ok: false,
        code: 'MERGE_SOURCE_HASH_MISMATCH',
        message: 'Source file hash changed immediately before copy.',
        diagnostics: [
          executeDiagnostic(
            resolved.operation,
            'MERGE_SOURCE_HASH_MISMATCH',
            'Source file hash changed immediately before copy.'
          ),
        ],
      };
    }

    const currentHash = await hashFileOrMissing(resolved.targetPath, fileSystem);
    if (currentHash !== resolved.expectedOldHash) {
      return {
        ok: false,
        code: 'MERGE_STALE_TARGET_HASH',
        message: 'Target file hash changed immediately before copy.',
        diagnostics: [
          executeDiagnostic(
            resolved.operation,
            'MERGE_STALE_TARGET_HASH',
            'Target file hash changed immediately before copy.'
          ),
        ],
      };
    }

    await fileSystem.mkdir(path.dirname(resolved.targetPath), { recursive: true });
    if (resolved.expectedOldHash !== MISSING_TARGET_HASH) {
      await fileSystem.mkdir(path.dirname(resolved.backupPath), { recursive: true });
      await fileSystem.copyFile(resolved.targetPath, resolved.backupPath);
    }
    targetMutationStarted = true;
    await fileSystem.copyFile(resolved.sourcePath, resolved.targetPath);
    return { ok: true, backupPath: resolved.backupPath, diagnostics: [] };
  } catch (error) {
    const diagnostics = [
      executeDiagnostic(
        resolved.operation,
        'MERGE_FILE_COPY_FAILED',
        `File copy failed: ${errorMessage(error)}`
      ),
    ];
    if (targetMutationStarted) {
      const restoreFailure = await restoreFileCopyAfterFailure(resolved, fileSystem);
      if (restoreFailure) {
        diagnostics.push(executeDiagnostic(resolved.operation, restoreFailure.code, restoreFailure.message));
      }
    }
    return {
      ok: false,
      code: 'MERGE_FILE_COPY_FAILED',
      message: `File copy failed: ${errorMessage(error)}`,
      backupPath: resolved.backupPath,
      diagnostics,
    };
  }
}

async function applyFolderOperation(
  resolved: ResolvedFolderOperation,
  rootUri: string
): Promise<{ ok: true; backupPath: string; diagnostics: [] } | { ok: false; code: string; message: string; backupPath?: string; diagnostics: CompareMessage[] }> {
  const boundaryFailure = await ensureTargetInsideRootAllowMissing(rootUri, resolved.targetPath);
  if (boundaryFailure) {
    return {
      ok: false,
      ...boundaryFailure,
      diagnostics: [executeDiagnostic(resolved.operation, boundaryFailure.code, boundaryFailure.message)],
    };
  }

  let targetMutationStarted = false;
  try {
    const currentHash = await hashDirectoryOrMissing(resolved.targetPath);
    if (currentHash !== resolved.expectedOldHash) {
      return {
        ok: false,
        code: 'MERGE_STALE_TARGET_HASH',
        message: 'Target folder hash changed immediately before folder operation.',
        diagnostics: [
          executeDiagnostic(
            resolved.operation,
            'MERGE_STALE_TARGET_HASH',
            'Target folder hash changed immediately before folder operation.'
          ),
        ],
      };
    }
    if (resolved.expectedOldHash !== MISSING_TARGET_HASH) {
      await fs.mkdir(path.dirname(resolved.backupPath), { recursive: true });
      await fs.cp(resolved.targetPath, resolved.backupPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      targetMutationStarted = true;
      await fs.rm(resolved.targetPath, { recursive: true, force: true });
    }
    if (resolved.type === 'folderCopy' && resolved.sourcePath) {
      const sourceBoundaryFailure = await ensureSourceInsideRoot(resolved.sourceRootUri, resolved.sourcePath);
      if (sourceBoundaryFailure) {
        const diagnostics = [
          executeDiagnostic(resolved.operation, sourceBoundaryFailure.code, sourceBoundaryFailure.message),
        ];
        if (targetMutationStarted) {
          const restoreFailure = await restoreFolderOperationAfterFailure(resolved);
          if (restoreFailure) {
            diagnostics.push(executeDiagnostic(resolved.operation, restoreFailure.code, restoreFailure.message));
          }
        }
        return {
          ok: false,
          ...sourceBoundaryFailure,
          backupPath: resolved.backupPath,
          diagnostics,
        };
      }
      const sourceHash = await hashDirectory(resolved.sourcePath);
      if (
        sourceHash !== resolved.sourceHash ||
        (resolved.operation.newHash && sourceHash !== resolved.operation.newHash)
      ) {
        const diagnostics = [
          executeDiagnostic(
            resolved.operation,
            'MERGE_SOURCE_HASH_MISMATCH',
            'Source folder changed immediately before copy.'
          ),
        ];
        if (targetMutationStarted) {
          const restoreFailure = await restoreFolderOperationAfterFailure(resolved);
          if (restoreFailure) {
            diagnostics.push(executeDiagnostic(resolved.operation, restoreFailure.code, restoreFailure.message));
          }
        }
        return {
          ok: false,
          code: 'MERGE_SOURCE_HASH_MISMATCH',
          message: 'Source folder changed immediately before copy.',
          backupPath: resolved.backupPath,
          diagnostics,
        };
      }
      await fs.mkdir(path.dirname(resolved.targetPath), { recursive: true });
      targetMutationStarted = true;
      await fs.cp(resolved.sourcePath, resolved.targetPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }

    return { ok: true, backupPath: resolved.backupPath, diagnostics: [] };
  } catch (error) {
    const diagnostics = [
      executeDiagnostic(
        resolved.operation,
        'MERGE_FOLDER_OPERATION_FAILED',
        `Folder operation failed: ${errorMessage(error)}`
      ),
    ];
    if (targetMutationStarted) {
      const restoreFailure = await restoreFolderOperationAfterFailure(resolved);
      if (restoreFailure) {
        diagnostics.push(executeDiagnostic(resolved.operation, restoreFailure.code, restoreFailure.message));
      }
    }
    return {
      ok: false,
      code: 'MERGE_FOLDER_OPERATION_FAILED',
      message: `Folder operation failed: ${errorMessage(error)}`,
      backupPath: resolved.backupPath,
      diagnostics,
    };
  }
}

async function restoreFileCopyAfterFailure(
  resolved: ResolvedFileCopyOperation,
  fileSystem: MergeExecutorFileSystem
): Promise<{ code: string; message: string } | undefined> {
  try {
    if (resolved.expectedOldHash === MISSING_TARGET_HASH) {
      await fileSystem.rm(resolved.targetPath, { force: true });
      return undefined;
    }

    await fileSystem.mkdir(path.dirname(resolved.targetPath), { recursive: true });
    await fileSystem.copyFile(resolved.backupPath, resolved.targetPath);
    return undefined;
  } catch (error) {
    return {
      code: 'MERGE_ROLLBACK_FAILED',
      message: `Failed to restore file target after copy failure: ${errorMessage(error)}`,
    };
  }
}

async function restoreFolderOperationAfterFailure(
  resolved: ResolvedFolderOperation
): Promise<{ code: string; message: string } | undefined> {
  try {
    await fs.rm(resolved.targetPath, { recursive: true, force: true });
    if (resolved.expectedOldHash !== MISSING_TARGET_HASH) {
      await fs.mkdir(path.dirname(resolved.targetPath), { recursive: true });
      await fs.cp(resolved.backupPath, resolved.targetPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }
    return undefined;
  } catch (error) {
    return {
      code: 'MERGE_ROLLBACK_FAILED',
      message: `Failed to restore folder target after operation failure: ${errorMessage(error)}`,
    };
  }
}

async function ensureTargetInsideRoot(
  rootUri: string,
  targetPath: string
): Promise<{ code: string; message: string } | undefined> {
  const rootPath = uriToPath(rootUri);
  if (!rootPath) {
    return {
      code: 'MERGE_TARGET_ROOT_MISSING',
      message: 'Left configuration root uri is not a file uri.',
    };
  }

  try {
    const canonicalRoot = await fs.realpath(rootPath);
    const canonicalTarget = await fs.realpath(targetPath);
    if (!isPathInsideRoot(canonicalRoot, canonicalTarget)) {
      return {
        code: 'MERGE_TARGET_OUTSIDE_ROOT',
        message: 'Merge target path is outside the left configuration root.',
      };
    }
  } catch (error) {
    return {
      code: 'MERGE_TARGET_READ_FAILED',
      message: `Failed to canonicalize merge target path: ${errorMessage(error)}`,
    };
  }

  return undefined;
}

async function ensureSourceInsideRoot(
  rootUri: string | undefined,
  sourcePath: string
): Promise<{ code: string; message: string } | undefined> {
  if (!rootUri) {
    return {
      code: 'MERGE_SOURCE_ROOT_MISSING',
      message: 'Right source root uri is not available for copy operation.',
    };
  }

  const rootPath = uriToPath(rootUri);
  if (!rootPath) {
    return {
      code: 'MERGE_SOURCE_ROOT_MISSING',
      message: 'Right source root uri is not a file uri.',
    };
  }

  try {
    const canonicalRoot = await fs.realpath(rootPath);
    const canonicalSource = await fs.realpath(sourcePath);
    if (!isPathInsideRoot(canonicalRoot, canonicalSource)) {
      return {
        code: 'MERGE_SOURCE_OUTSIDE_ROOT',
        message: 'Merge source path is outside the right source root.',
      };
    }
  } catch (error) {
    return {
      code: 'MERGE_SOURCE_READ_FAILED',
      message: `Failed to canonicalize merge source path: ${errorMessage(error)}`,
    };
  }

  return undefined;
}

async function ensureTargetInsideRootAllowMissing(
  rootUri: string,
  targetPath: string
): Promise<{ code: string; message: string } | undefined> {
  const rootPath = uriToPath(rootUri);
  if (!rootPath) {
    return {
      code: 'MERGE_TARGET_ROOT_MISSING',
      message: 'Left configuration root uri is not a file uri.',
    };
  }

  try {
    const canonicalRoot = await fs.realpath(rootPath);
    const canonicalTarget = await realpathIfExists(targetPath);
    const targetForCheck = canonicalTarget ?? await canonicalizeMissingPath(targetPath);
    if (!isPathInsideRoot(canonicalRoot, targetForCheck)) {
      return {
        code: 'MERGE_TARGET_OUTSIDE_ROOT',
        message: 'Merge target path is outside the left configuration root.',
      };
    }
  } catch (error) {
    return {
      code: 'MERGE_TARGET_READ_FAILED',
      message: `Failed to canonicalize merge target path: ${errorMessage(error)}`,
    };
  }

  return undefined;
}

async function realpathIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.realpath(filePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function canonicalizeMissingPath(filePath: string): Promise<string> {
  const absolutePath = path.resolve(filePath);
  const parsed = path.parse(absolutePath);
  let current = absolutePath;
  const missingParts: string[] = [];

  while (current !== parsed.root) {
    try {
      const canonicalExisting = await fs.realpath(current);
      return path.join(canonicalExisting, ...missingParts.reverse());
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
      missingParts.push(path.basename(current));
      current = path.dirname(current);
    }
  }

  return absolutePath;
}

async function hashDirectory(directoryPath: string): Promise<string> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      parts.push(`dir:${entry.name}:${await hashDirectory(entryPath)}`);
    } else if (entry.isFile()) {
      parts.push(`file:${entry.name}:${hashBuffer(await fs.readFile(entryPath))}`);
    }
  }

  return hashText(parts.join('\n'));
}

async function hashDirectoryOrMissing(directoryPath: string): Promise<string> {
  try {
    return await hashDirectory(directoryPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return MISSING_TARGET_HASH;
    }
    throw error;
  }
}

async function hashFileOrMissing(
  filePath: string,
  fileSystem: MergeExecutorFileSystem
): Promise<string> {
  try {
    return hashBuffer(await readBinaryFile(filePath, fileSystem));
  } catch (error) {
    if (isNotFoundError(error)) {
      return MISSING_TARGET_HASH;
    }
    throw error;
  }
}

async function readBinaryFile(
  filePath: string,
  fileSystem: MergeExecutorFileSystem
): Promise<Buffer> {
  const content = await (fileSystem.readFile as unknown as (path: string) => Promise<Buffer | string>)(
    filePath
  );
  return Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
}

function hashBuffer(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

function applyBslRoutineInsert(source: string, operation: MergeOperation): string | undefined {
  const payload = operation.bslRoutine;
  if (!payload || payload.kind !== 'insertRoutine' || !payload.sourceRange) {
    return undefined;
  }

  const current = parseBslRoutines(source);
  const incoming = parseBslRoutines(payload.sourceText);
  if (hasParseErrors(current) || hasParseErrors(incoming)) {
    return undefined;
  }
  if (current.routines.some((routine) => sameRoutineIdentity(routine, payload.routine))) {
    return undefined;
  }

  const incomingRoutine = incoming.routines.find((routine) =>
    sameRoutineIdentity(routine, payload.routine)
  );
  if (!incomingRoutine || incoming.routines.length !== 1) {
    return undefined;
  }

  const eol = detectEol(source) ?? detectEol(payload.sourceText) ?? '\n';
  const currentText = trimTrailingLineBreaks(source);
  const routineText = normalizeEol(trimTrailingLineBreaks(payload.sourceText), eol);
  return currentText.length === 0 ? routineText : `${currentText}${eol}${routineText}`;
}

function applyBslRoutineDelete(source: string, operation: MergeOperation): string | undefined {
  const payload = operation.bslRoutine;
  if (!payload || payload.kind !== 'deleteRoutine' || !payload.targetRange) {
    return undefined;
  }

  const current = parseBslRoutines(source);
  const removal = parseBslRoutines(payload.sourceText);
  if (hasParseErrors(current) || hasParseErrors(removal)) {
    return undefined;
  }

  const routine = current.routines.find((item) => sameRoutineIdentity(item, payload.routine));
  const removedRoutine = removal.routines.find((item) => sameRoutineIdentity(item, payload.routine));
  if (
    !routine ||
    !removedRoutine ||
    removal.routines.length !== 1 ||
    !sameRange(routine.range, payload.targetRange)
  ) {
    return undefined;
  }

  const range = offsetRangeFor(source, routine.range);
  if (!range) {
    return undefined;
  }

  const expectedRemoval = normalizeEol(trimTrailingLineBreaks(payload.sourceText), '\n');
  const actualRemoval = normalizeEol(trimTrailingLineBreaks(source.slice(range.start, range.end)), '\n');
  if (actualRemoval !== expectedRemoval) {
    return undefined;
  }

  const adjustedStart = range.end === source.length ? removePrecedingEolStart(source, range.start) : range.start;
  return source.slice(0, adjustedStart) + source.slice(range.end);
}

function bslPayloadKindForOperation(
  kind: MergeOperation['kind']
): NonNullable<MergeOperation['bslRoutine']>['kind'] | undefined {
  if (kind === 'bslRoutineInsert') {
    return 'insertRoutine';
  }
  if (kind === 'bslRoutineDelete') {
    return 'deleteRoutine';
  }

  return undefined;
}

function sameRoutineIdentity(
  routine: BslRoutineInfo,
  expected: NonNullable<MergeOperation['bslRoutine']>['routine']
): boolean {
  return (
    routine.normalizedName === expected.normalizedName &&
    routine.kind === expected.kind &&
    routine.exported === expected.exported
  );
}

function hasParseErrors(result: ReturnType<typeof parseBslRoutines>): boolean {
  return result.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

function sameRange(left: BslTextRange, right: BslTextRange): boolean {
  return (
    left.startLine === right.startLine &&
    left.startColumn === right.startColumn &&
    left.endLine === right.endLine &&
    left.endColumn === right.endColumn
  );
}

function offsetRangeFor(
  source: string,
  range: BslTextRange
): { start: number; end: number } | undefined {
  const start = offsetForPosition(source, range.startLine, range.startColumn);
  const end = offsetForPosition(source, range.endLine, range.endColumn);
  return start === undefined || end === undefined || end < start ? undefined : { start, end };
}

function offsetForPosition(
  source: string,
  lineNumber: number,
  columnNumber: number
): number | undefined {
  if (lineNumber < 1 || columnNumber < 1) {
    return undefined;
  }

  const lines = splitSourceLines(source);
  const line = lines[lineNumber - 1];
  if (!line || columnNumber > line.text.length + 1) {
    return undefined;
  }

  const lineStart = lines
    .slice(0, lineNumber - 1)
    .reduce((offset, item) => offset + item.text.length + item.eol.length, 0);
  return lineStart + columnNumber - 1;
}

function removePrecedingEolStart(source: string, start: number): number {
  if (start >= 2 && source.slice(start - 2, start) === '\r\n') {
    return start - 2;
  }
  if (start >= 1 && (source[start - 1] === '\n' || source[start - 1] === '\r')) {
    return start - 1;
  }

  return start;
}

function detectEol(source: string): string | undefined {
  const crlf = source.indexOf('\r\n');
  if (crlf >= 0) {
    return '\r\n';
  }
  const lf = source.indexOf('\n');
  if (lf >= 0) {
    return '\n';
  }
  const cr = source.indexOf('\r');
  return cr >= 0 ? '\r' : undefined;
}

function trimTrailingLineBreaks(source: string): string {
  return source.replace(/(?:\r\n|\r|\n)+$/g, '');
}

function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
  const root = normalizeBoundaryPath(rootPath);
  const target = normalizeBoundaryPath(targetPath);
  return (
    target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
  );
}

function normalizeBoundaryPath(filePath: string): string {
  const normalized = path.normalize(filePath);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function executeDiagnostic(
  operation: MergeOperation,
  code: string,
  message: string
): CompareMessage {
  return {
    severity: 'error',
    code,
    phase: 'execute',
    sourceId: operation.sourceId,
    nodeId: operation.nodeId,
    path: operation.targetUri,
    blocking: true,
    suggestedAction: message,
  };
}

function failureForPreview(
  previewId: string,
  code: string,
  message: string
): MergeExecutionOperationResult {
  return {
    operationId: previewId,
    kind: 'bslLogicalRoutineMerge',
    code,
    message,
  };
}

function targetRootUriFor(session: CompareSession, targetSourceId: string): string | undefined {
  return session.state.sources.find((source) => source.sourceId === targetSourceId)?.rootUri;
}

function sourceRootUriFor(
  session: CompareSession,
  sourceId: string,
  snapshotId: string
): string | undefined {
  const state = session.state;
  return (
    state.snapshots.find((snapshot) => snapshot.snapshotId === snapshotId)?.snapshotRoot ??
    state.sources.find((source) => source.sourceId === sourceId)?.rootUri
  );
}

function cloneCompareMessage(message: CompareMessage): CompareMessage {
  return {
    ...message,
    range: message.range ? { ...message.range } : undefined,
  };
}
