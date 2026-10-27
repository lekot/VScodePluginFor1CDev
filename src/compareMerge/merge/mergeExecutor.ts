import * as fs from 'fs/promises';
import { fileURLToPath, pathToFileURL } from 'url';

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
import {
  ConfigurationMutationEngine,
  getConfigurationMutationEngine,
  type MutationReceipt,
} from '../../services/configurationSession/ConfigurationMutationEngine';
import type { ConfigurationId } from '../../services/configurationSession/types';
import { MutationPlanError } from '../../services/configurationSession/mutationPlan';
import {
  MutationReceiptError,
  projectMutationFailure,
  type MutationFailureProjection,
  type NonCommittedMutationReceipt,
} from '../../services/configurationSession/mutationReceiptError';
import { isPathInside, isSamePath } from '../../services/configurationSession/pathBoundary';
import { exportMergeBackupArtifacts, MergeBackupArtifactExportError } from './mergeBackupArtifacts';
import { buildMergeMutationPlan, type PreparedMergeAction } from './mergeMutationPlan';
import { captureMergePath, mergeSnapshotHash, type MergePathSnapshot, type MergeSnapshotDirectory } from './mergeSnapshot';
import {
  ensureSourceInsideRoot,
  ensureTargetInsideRootAllowMissing,
  resolveCapturedFileCopyOperation,
  resolveCapturedFileWriteOperation,
  resolveMergePathBoundary,
  verifyCapturedFileWriteWitnesses,
} from './capturedFileWrite';
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

export interface MergeExecutorInput {
  session: CompareSession;
  preflight: PreflightResult;
  mutationEngine?: ConfigurationMutationEngine;
  configurationId?: ConfigurationId;
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
  receipt?: MutationReceipt<unknown>;
  mutationFailure?: MutationFailureProjection;
}

type ResolvedOperation =
  | ResolvedTextWriteOperation
  | ResolvedFileCopyOperation
  | ResolvedFileWriteOperation
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
  before: MergePathSnapshot;
}

interface ResolvedXmlTextWriteGroup {
  type: 'xmlTextWriteGroup';
  operations: ResolvedTextWriteOperation[];
  targetPath: string;
  backupPath: string;
  rootUri?: string;
  currentSource: string;
  nextSource: string;
  before: MergePathSnapshot;
}

interface ResolvedFileDeleteOperation {
  type: 'fileDelete';
  operation: MergeOperation;
  targetPath: string;
  backupPath: string;
  expectedOldHash: string;
  before: MergePathSnapshot;
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
  sourceContentBase64: string;
  before: MergePathSnapshot;
}

interface ResolvedFileWriteOperation {
  type: 'fileWrite';
  operation: MergeOperation;
  targetPath: string;
  backupPath: string;
  before: MergePathSnapshot;
  contentBase64: string;
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
  sourceSnapshot?: MergeSnapshotDirectory;
  before: MergePathSnapshot;
}

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
    trustedDiagnostics,
    input.session,
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

  const rootPath = uriToPath(rootUri);
  if (!rootPath) {
    result.failed.push(
      failureForPreview(
        input.preflight.approvedPreviewId,
        'MERGE_TARGET_ROOT_MISSING',
        'Left configuration root is not a local filesystem path.'
      )
    );
    return result;
  }
  let capturedCanonicalRoot: string;
  try {
    capturedCanonicalRoot = await fs.realpath(rootPath);
  } catch (error) {
    result.failed.push(failureForPreview(
      input.preflight.approvedPreviewId,
      'MERGE_TARGET_ROOT_MISSING',
      `Left configuration root cannot be canonicalized: ${errorMessage(error)}`
    ));
    return result;
  }

  const resolvedOperations: ResolvedOperation[] = [];
  const canonicalRootUri = pathToFileURL(capturedCanonicalRoot).toString();
  const initialWitnessCheck = await verifyCapturedFileWriteWitnesses(
    trustedOperations,
    input.session,
    trustedPreview.targetSourceId,
  );
  if (initialWitnessCheck.failures.length > 0) {
    result.failed.push(...initialWitnessCheck.failures.map((item) =>
      failure(item.operation, item.code, item.message)
    ));
    return result;
  }

  for (const operation of trustedOperations) {
    const sourceRootUri = sourceRootUriFor(input.session, operation.sourceId, operation.snapshotId);
    const resolved = await resolveOperation(
      operation,
      trustedPreflight.backupPlan,
      canonicalRootUri,
      capturedCanonicalRoot,
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
  const actions: PreparedMergeAction[] = [];
  for (const unit of executionUnits) {
    const action = await prepareMutationAction(unit);
    if ('failure' in action) {
      result.failed.push(action.failure);
      return result;
    }
    actions.push(action.action);
  }

  const overlapFailures = validateTargetOverlaps(actions);
  if (overlapFailures.length > 0) {
    result.failed.push(...overlapFailures);
    return result;
  }

  const rightRootUri = input.session.state.sources.find((source) => source.side === 'right')?.rootUri;
  const rightRootPath = rightRootUri ? uriToPath(rightRootUri) : undefined;
  if (!rightRootPath) {
    result.failed.push(failureForPreview(
      input.preflight.approvedPreviewId,
      'MERGE_SOURCE_ROOT_MISSING',
      'Right configuration root is not available for backup boundary checks.'
    ));
    return result;
  }

  let exportedBackups: readonly { operationId: string; backupPath: string }[] = [];
  const engine = input.mutationEngine ?? getConfigurationMutationEngine();
  const receipt = await engine.executePlan(
    capturedCanonicalRoot,
    {
      kind: 'configuration-compare-merge',
      resourcePath: rootPath,
      expectedConfigurationId: input.configurationId,
    },
    async (snapshot) => {
      const resolvedRoot = await fs.realpath(snapshot.rootPath);
      if (!isSamePath(capturedCanonicalRoot, resolvedRoot)) {
        throw new MutationPlanError(
          'PLAN_CONFLICT',
          'Merge target root changed after the compare snapshot was captured.'
        );
      }
      if (
        input.configurationId !== undefined &&
        snapshot.configurationId !== input.configurationId
      ) {
        throw new MutationPlanError(
          'PLAN_CONFLICT',
          'Merge target configuration identity changed after the compare snapshot was captured.'
        );
      }

      const witnessCheck = await verifyCapturedFileWriteWitnesses(
        trustedOperations,
        input.session,
        trustedPreview.targetSourceId,
      );
      if (witnessCheck.failures.length > 0) {
        throw new MutationPlanError(
          'PLAN_CONFLICT',
          witnessCheck.failures.map((item) => item.message).join(' '),
        );
      }

      const snapshotsByOperationId = new Map<string, MergePathSnapshot>();
      for (const action of actions) {
        for (const operation of action.operations) {
          snapshotsByOperationId.set(operation.operationId, action.before);
        }
      }
      try {
        exportedBackups = await exportMergeBackupArtifacts({
          backupPlan: trustedPreflight.backupPlan,
          leftRootPath: capturedCanonicalRoot,
          rightRootPath,
          snapshotsByOperationId,
        });
      } catch (error) {
        if (error instanceof MergeBackupArtifactExportError) {
          exportedBackups = error.createdArtifacts;
        }
        throw error;
      }
      const backupPathsByOperationId = new Map(
        exportedBackups.map((artifact) => [artifact.operationId, artifact.backupPath])
      );
      const actionsWithBackups = actions.map((action) => ({
        ...action,
        backupPaths: action.operations
          .map((operation) => backupPathsByOperationId.get(operation.operationId))
          .filter((backupPath): backupPath is string => backupPath !== undefined),
      }));
      return buildMergeMutationPlan(capturedCanonicalRoot, actionsWithBackups, witnessCheck.targetAssertions);
    },
    {
      buildUnderLease: trustedOperations.some((operation) => operation.kind === 'fileWrite'),
    }
  );

  result.receipt = receipt;
  result.backupPaths = exportedBackups.map((artifact) => artifact.backupPath);
  if (receipt.status !== 'committed') {
    const projectedFailure = projectMutationFailure(
      new MutationReceiptError(receipt as NonCommittedMutationReceipt)
    );
    if (projectedFailure) {
      result.mutationFailure = projectedFailure;
    }
    result.failed.push(...actions.flatMap((action) => action.operations.map((operation) =>
      failure(
        operation,
        projectedFailure?.code ?? receipt.code ?? receipt.status.toUpperCase(),
        projectedFailure?.message ?? receipt.message ?? 'Merge plan could not be applied.',
        exportedBackups.find((backup) => backup.operationId === operation.operationId)?.backupPath
      )
    )));
    if (receipt.status === 'recoveryRequired' || receipt.status === 'inDoubt') {
      result.diagnostics.push({
        severity: 'error',
        code: receipt.code ?? 'MERGE_RECOVERY_REQUIRED',
        phase: 'execute',
        sourceId: trustedPreview.targetSourceId,
        blocking: true,
        suggestedAction: projectedFailure?.message ?? 'Проверьте состояние конфигурации и журнал перед повторным запуском.',
      });
    }
    return result;
  }

  result.applied = [...(receipt.result?.applied ?? [])];
  result.backupPaths = [...(receipt.result?.backupPaths ?? result.backupPaths)];
  try {
    input.session.markPreviewExecuted(input.preflight.approvedPreviewId);
  } catch (error) {
    result.diagnostics.push({
      severity: 'warning',
      code: 'MERGE_PREVIEW_BOOKKEEPING_FAILED',
      phase: 'execute',
      sourceId: trustedPreview.targetSourceId,
      blocking: false,
      suggestedAction: `Изменения сохранены, но состояние preview не обновлено: ${errorMessage(error)}`,
    });
  }

  return result;
}

async function prepareMutationAction(
  resolved: ResolvedExecutionUnit,
): Promise<{ action: PreparedMergeAction } | { failure: MergeExecutionOperationResult }> {
  if (resolved.type === 'xmlTextWriteGroup') {
    const next = applyXmlTextWriteGroup(resolved);
    if (!next.ok) {
      return {
        failure: failure(firstOperationOf(resolved), next.code, next.message, resolved.backupPath),
      };
    }
    return {
      action: {
        targetPath: resolved.targetPath,
        targetUri: firstOperationOf(resolved).targetUri!,
        operations: operationsOf(resolved),
        before: resolved.before,
        kind: 'writeFile',
        contentBase64: Buffer.from(next.source, 'utf8').toString('base64'),
        backupPaths: [],
      },
    };
  }
  if (resolved.type === 'textWrite') {
    return {
      action: {
        targetPath: resolved.targetPath,
        targetUri: resolved.operation.targetUri!,
        operations: [resolved.operation],
        before: resolved.before,
        kind: 'writeFile',
        contentBase64: Buffer.from(resolved.nextSource, 'utf8').toString('base64'),
        backupPaths: [],
      },
    };
  }
  if (resolved.type === 'fileCopy') {
    return {
      action: {
        targetPath: resolved.targetPath,
        targetUri: resolved.operation.targetUri!,
        operations: [resolved.operation],
        before: resolved.before,
        kind: 'writeFile',
        contentBase64: resolved.sourceContentBase64,
        backupPaths: [],
      },
    };
  }
  if (resolved.type === 'fileWrite') {
    return {
      action: {
        targetPath: resolved.targetPath,
        targetUri: resolved.operation.targetUri!,
        operations: [resolved.operation],
        before: resolved.before,
        kind: 'writeFile',
        contentBase64: resolved.contentBase64,
        backupPaths: [],
      },
    };
  }
  if (resolved.type === 'fileDelete') {
    return {
      action: {
        targetPath: resolved.targetPath,
        targetUri: resolved.operation.targetUri!,
        operations: [resolved.operation],
        before: resolved.before,
        kind: 'deleteFile',
        backupPaths: [],
      },
    };
  }
  if (resolved.operation.kind === 'folderDelete') {
    return {
      action: {
        targetPath: resolved.targetPath,
        targetUri: resolved.operation.targetUri!,
        operations: [resolved.operation],
        before: resolved.before,
        kind: 'deleteDirectory',
        backupPaths: [],
      },
    };
  }
  if (!resolved.sourceSnapshot) {
    return {
      failure: failure(resolved.operation, 'MERGE_SOURCE_SNAPSHOT_MISSING', 'Folder source snapshot is missing.'),
    };
  }
  return {
    action: {
      targetPath: resolved.targetPath,
      targetUri: resolved.operation.targetUri!,
      operations: [resolved.operation],
      before: resolved.before,
      kind: 'replaceDirectory',
      directory: resolved.sourceSnapshot,
      backupPaths: [],
    },
  };
}

function validateTargetOverlaps(actions: readonly PreparedMergeAction[]): MergeExecutionOperationResult[] {
  const failures: MergeExecutionOperationResult[] = [];
  for (let leftIndex = 0; leftIndex < actions.length; leftIndex += 1) {
    const left = actions[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < actions.length; rightIndex += 1) {
      const right = actions[rightIndex]!;
      if (
        isSamePath(left.targetPath, right.targetPath) ||
        isPathInside(left.targetPath, right.targetPath) ||
        isPathInside(right.targetPath, left.targetPath)
      ) {
        for (const operation of [...left.operations, ...right.operations]) {
          failures.push(failure(
            operation,
            'MERGE_OVERLAPPING_TARGETS',
            'Merge preview contains overlapping target paths.'
          ));
        }
      }
    }
  }
  return failures;
}

async function resolveOperation(
  operation: MergeOperation,
  backupPlan: BackupPlan,
  rootUri: string,
  canonicalRootPath: string,
  sourceRootUri: string | undefined
): Promise<{ resolved: ResolvedOperation } | { failure: MergeExecutionOperationResult }> {
  let canonicalTargetPath: string | undefined;
  if (operation.targetUri) {
    const targetPath = uriToPath(operation.targetUri);
    if (!targetPath) {
      return { failure: failure(operation, 'MERGE_TARGET_GUARD_MISSING', 'Target uri is not a local file uri.') };
    }
    const targetBoundary = await resolveMergePathBoundary(canonicalRootPath, targetPath, false);
    if ('failure' in targetBoundary) {
      return { failure: failure(operation, targetBoundary.failure.code, targetBoundary.failure.message) };
    }
    canonicalTargetPath = targetBoundary.canonicalTarget;
  }
  if (operation.kind === 'bslLogicalRoutineMerge') {
    return resolveLogicalOperation(operation, backupPlan, rootUri, canonicalTargetPath);
  }
  if (operation.kind === 'bslRoutineInsert' || operation.kind === 'bslRoutineDelete') {
    return resolveBslRoutineOperation(operation, backupPlan, rootUri, canonicalTargetPath);
  }
  if (operation.kind === 'xmlNodeReplace' || operation.kind === 'xmlNodeInsert' || operation.kind === 'xmlNodeDelete') {
    return resolveXmlOperation(operation, backupPlan, rootUri, canonicalTargetPath);
  }
  if (operation.kind === 'fileCopy') {
    return resolveFileCopyOperation(operation, backupPlan, rootUri, sourceRootUri, canonicalTargetPath);
  }
  if (operation.kind === 'fileWrite') {
    const resolution = await resolveCapturedFileWriteOperation(operation, backupPlan, rootUri, canonicalTargetPath);
    return 'failure' in resolution
      ? { failure: failure(operation, resolution.failure.code, resolution.failure.message) }
      : { resolved: { type: 'fileWrite', operation, ...resolution.resolved } };
  }
  if (operation.kind === 'fileDelete') {
    return resolveFileDeleteOperation(operation, backupPlan, rootUri, canonicalTargetPath);
  }
  if (operation.kind === 'folderCopy' || operation.kind === 'folderDelete') {
    return resolveFolderOperation(operation, backupPlan, rootUri, sourceRootUri, canonicalTargetPath);
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
  rootUri: string,
  canonicalTargetPath?: string,
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

  const targetPath = canonicalTargetPath ?? uriToPath(operation.targetUri);
  if (!targetPath) {
    return {
      failure: failure(operation, 'MERGE_TARGET_GUARD_MISSING', 'Target uri is not a file uri.'),
    };
  }

  let before: MergePathSnapshot;
  try {
    before = await captureMergePath(targetPath);
  } catch (error) {
    return {
      failure: failure(
        operation,
        'MERGE_TARGET_READ_FAILED',
        `Failed to read target file: ${error instanceof Error ? error.message : String(error)}`
      ),
    };
  }
  if (before.state === 'missing' || before.type !== 'file' || before.contentBase64 === undefined) {
    return { failure: failure(operation, 'MERGE_TARGET_READ_FAILED', 'Target file is unavailable for merge materialization.') };
  }
  const currentSource = Buffer.from(before.contentBase64, 'base64').toString('utf8');
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
      before,
    },
  };
}

async function resolveXmlOperation(
  operation: MergeOperation,
  backupPlan: BackupPlan,
  rootUri: string,
  canonicalTargetPath?: string,
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

  const targetPath = canonicalTargetPath ?? uriToPath(operation.targetUri);
  if (!targetPath) {
    return {
      failure: failure(operation, 'MERGE_TARGET_GUARD_MISSING', 'Target uri is not a file uri.'),
    };
  }

  let before: MergePathSnapshot;
  try {
    before = await captureMergePath(targetPath);
  } catch (error) {
    return {
      failure: failure(operation, 'MERGE_TARGET_READ_FAILED', `Failed to read target file: ${errorMessage(error)}`),
    };
  }
  if (before.state === 'missing' || before.type !== 'file' || before.contentBase64 === undefined) {
    return { failure: failure(operation, 'MERGE_TARGET_READ_FAILED', 'Target XML file is unavailable for merge materialization.') };
  }
  const currentSource = Buffer.from(before.contentBase64, 'base64').toString('utf8');
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
      before,
    },
  };
}

async function resolveBslRoutineOperation(
  operation: MergeOperation,
  backupPlan: BackupPlan,
  rootUri: string,
  canonicalTargetPath?: string,
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

  const targetPath = canonicalTargetPath ?? uriToPath(operation.targetUri);
  if (!targetPath) {
    return {
      failure: failure(operation, 'MERGE_TARGET_GUARD_MISSING', 'Target uri is not a file uri.'),
    };
  }

  let before: MergePathSnapshot;
  try {
    before = await captureMergePath(targetPath);
  } catch (error) {
    return {
      failure: failure(operation, 'MERGE_TARGET_READ_FAILED', `Failed to read target file: ${errorMessage(error)}`),
    };
  }
  if (before.state === 'missing' || before.type !== 'file' || before.contentBase64 === undefined) {
    return { failure: failure(operation, 'MERGE_TARGET_READ_FAILED', 'Target BSL file is unavailable for merge materialization.') };
  }
  const currentSource = Buffer.from(before.contentBase64, 'base64').toString('utf8');
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
      before,
    },
  };
}

async function resolveFileCopyOperation(
  operation: MergeOperation,
  backupPlan: BackupPlan,
  rootUri: string,
  sourceRootUri: string | undefined,
  canonicalTargetPath?: string,
): Promise<{ resolved: ResolvedFileCopyOperation } | { failure: MergeExecutionOperationResult }> {
  const resolution = await resolveCapturedFileCopyOperation(
    operation,
    backupPlan,
    rootUri,
    sourceRootUri,
    canonicalTargetPath,
  );
  return 'failure' in resolution
    ? { failure: failure(operation, resolution.failure.code, resolution.failure.message) }
    : { resolved: { type: 'fileCopy', operation, ...resolution.resolved } };
}

async function resolveFileDeleteOperation(
  operation: MergeOperation,
  backupPlan: BackupPlan,
  rootUri: string,
  canonicalTargetPath?: string,
): Promise<{ resolved: ResolvedFileDeleteOperation } | { failure: MergeExecutionOperationResult }> {
  if (!operation.targetUri || !operation.expectedOldHash) {
    return {
      failure: failure(operation, 'MERGE_TARGET_GUARD_MISSING', 'File delete operation is incomplete.'),
    };
  }

  const backup = backupItemFor(operation, backupPlan);
  const targetPath = canonicalTargetPath ?? uriToPath(operation.targetUri);
  if (!backup || !targetPath) {
    return {
      failure: failure(operation, 'MERGE_BACKUP_PLAN_INCOMPLETE', 'Backup plan or target uri is missing for operation.'),
    };
  }

  const boundaryFailure = await ensureTargetInsideRootAllowMissing(rootUri, targetPath);
  if (boundaryFailure) {
    return { failure: failure(operation, boundaryFailure.code, boundaryFailure.message) };
  }

  let before: MergePathSnapshot;
  try {
    before = await captureMergePath(targetPath);
  } catch (error) {
    return {
      failure: failure(operation, 'MERGE_TARGET_READ_FAILED', `Failed to read target file: ${errorMessage(error)}`),
    };
  }
  const currentHash = before.state === 'missing' ? MISSING_TARGET_HASH : before.type === 'file' ? before.hash : undefined;
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
      before,
    },
  };
}

async function resolveFolderOperation(
  operation: MergeOperation,
  backupPlan: BackupPlan,
  rootUri: string,
  sourceRootUri: string | undefined,
  canonicalTargetPath?: string,
): Promise<{ resolved: ResolvedFolderOperation } | { failure: MergeExecutionOperationResult }> {
  const payload = operation.fileOperation;
  if (!payload || !operation.targetUri || !operation.expectedOldHash) {
    return {
      failure: failure(operation, 'MERGE_TARGET_GUARD_MISSING', 'Folder operation is incomplete.'),
    };
  }

  const backup = backupItemFor(operation, backupPlan);
  const targetPath = canonicalTargetPath ?? uriToPath(operation.targetUri);
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

  let before: MergePathSnapshot;
  try {
    before = await captureMergePath(targetPath);
  } catch (error) {
    return { failure: failure(operation, 'MERGE_TARGET_READ_FAILED', `Failed to read target folder: ${errorMessage(error)}`) };
  }
  const currentHash = before.state === 'missing' ? MISSING_TARGET_HASH : before.type === 'directory' ? mergeSnapshotHash(before) : undefined;
  if (currentHash !== operation.expectedOldHash) {
    return {
      failure: failure(operation, 'MERGE_STALE_TARGET_HASH', 'Target folder hash changed before execution.'),
    };
  }
  let sourceSnapshot: MergeSnapshotDirectory | undefined;
  if (operation.kind === 'folderCopy') {
    if (!sourcePath || !payload.sourceHash) {
      return {
        failure: failure(operation, 'MERGE_FILE_OPERATION_SOURCE_MISSING', 'Folder copy source is missing.'),
      };
    }
    const sourceBoundaryFailure = await ensureSourceInsideRoot(sourceRootUri, sourcePath, rootUri);
    if (sourceBoundaryFailure) {
      return { failure: failure(operation, sourceBoundaryFailure.code, sourceBoundaryFailure.message) };
    }
    let capturedSource: MergePathSnapshot;
    try {
      capturedSource = await captureMergePath(sourcePath);
    } catch (error) {
      return { failure: failure(operation, 'MERGE_SOURCE_HASH_MISMATCH', `Failed to capture source folder: ${errorMessage(error)}`) };
    }
    if (capturedSource.state === 'missing' || capturedSource.type !== 'directory') {
      return { failure: failure(operation, 'MERGE_SOURCE_HASH_MISMATCH', 'Folder source is not a directory.') };
    }
    sourceSnapshot = capturedSource;
    const sourceHash = mergeSnapshotHash(capturedSource);
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
      sourceSnapshot,
      before,
    },
  };
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
      if (isXmlTextWrite(next) && isSamePath(next.targetPath, resolved.targetPath)) {
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
    before: first.before,
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
    const logicalTargetCount = uniqueOperationTargets(logicalOperations).length;
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
  const bslTextWriteGroups: MergeOperation[][] = [];
  for (const operation of operations.filter(isBslTextWriteOperation)) {
    const targetPath = operation.targetUri ? uriToPath(operation.targetUri) ?? operation.targetUri : undefined;
    const group = bslTextWriteGroups.find((existing) => {
      const existingPath = existing[0]?.targetUri;
      return targetPath !== undefined && existingPath !== undefined
        && isSamePath(uriToPath(existingPath) ?? existingPath, targetPath);
    });
    (group ?? bslTextWriteGroups[bslTextWriteGroups.push([]) - 1]!).push(operation);
  }
  for (const targetOperations of bslTextWriteGroups) {
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

function uniqueOperationTargets(operations: readonly MergeOperation[]): string[] {
  const targets: string[] = [];
  for (const operation of operations) {
    const target = operation.targetUri
      ? uriToPath(operation.targetUri) ?? operation.targetUri
      : operation.operationId;
    if (!targets.some((existing) => isSamePath(existing, target))) {
      targets.push(target);
    }
  }
  return targets;
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
    kind === 'fileWrite' ||
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
  let end = source.length;
  while (end > 0) {
    const char = source.charCodeAt(end - 1);
    if (char !== 10 && char !== 13) {
      break;
    }
    end -= 1;
  }

  return end === source.length ? source : source.slice(0, end);
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
