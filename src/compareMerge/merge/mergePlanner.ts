import { validateBslRoutineLogicalMergePlan } from '../bsl/bslRoutineMergeExecutorGuard';
import type { BslRoutineLogicalManualDiagnostic } from '../bsl/bslRoutineMergePlanTypes';
import { CompareSession } from '../domain/compareSession';
import type { CompareMessage, IdentityConflict } from '../domain/compareContracts';
import {
  cloneMergeOperation,
  compareMessage,
  type BackupPlan,
  type ConflictResolutionChoice,
  type MergeCandidate,
  type MergeOperation,
  type MergePreview,
  type MergePreviewRequest,
  type MergeSupportedOperationKind,
  type PreflightInput,
  type PreflightResult,
  type PreviewValidationResult,
  type RollbackPlan,
  type StoredMergePreviewPayload,
  type BslRoutineOperationPayload,
  type XmlPatchPayload,
} from './mergePreview';

export { MISSING_TARGET_HASH } from './mergePreview';

export {
  type BackupPlan,
  type BackupPlanItem,
  type BslRoutineIdentityPayload,
  type BslRoutineOperationPayload,
  type ConflictResolutionChoice,
  type LogicalRoutineMergePayload,
  type FileOperationPayload,
  type MergeCandidate,
  type MergeCandidateKind,
  type MergeOperation,
  type MergePreview,
  type MergePreviewRequest,
  type MergeSupportedOperationKind,
  type MergeUnsupportedOperationKind,
  type XmlAddress,
  type XmlPatchPayload,
  type PreflightInput,
  type PreflightResult,
  type PreviewValidationResult,
  type RollbackPlan,
  type RollbackPlanItem,
} from './mergePreview';

export interface CreateMergePreviewInput extends MergePreviewRequest {
  session: CompareSession;
}

export interface TrustedPreflightMaterialization {
  approvedPreviewId: string;
  previewId: string;
  backupPlan: BackupPlan;
  rollbackPlan: RollbackPlan;
}

const trustedPreflightMaterializations = new WeakMap<
  CompareSession,
  Map<string, TrustedPreflightMaterialization>
>();

export function createMergePreview(input: CreateMergePreviewInput): PreviewValidationResult {
  const diagnostics: CompareMessage[] = [];

  for (const conflict of input.identityConflicts ?? []) {
    if (conflict.blocking) {
      diagnostics.push(identityConflictDiagnostic(conflict, input.targetSourceId));
    }
  }

  const operations: MergeOperation[] = [];
  input.candidates.forEach((candidate, index) => {
    const operation = candidateToOperation(candidate, index, input, diagnostics);
    if (operation) {
      operations.push(operation);
    }
  });

  if (diagnostics.length === 0 && operations.length === 0) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_NO_EXECUTABLE_OPERATIONS',
        sourceId: input.targetSourceId,
        suggestedAction: 'Select at least one supported BSL merge operation.',
      })
    );
  }

  if (diagnostics.length > 0) {
    return {
      ok: false,
      diagnostics,
    };
  }

  const comparePreview = input.session.createPreview({
    previewId: input.previewId,
    targetSourceId: input.targetSourceId,
    snapshotIds: input.snapshotIds,
    createdAt: input.createdAt,
    summary: input.summary ?? summarizeOperations(operations),
    payload: {
      kind: 'mergePreviewPayload',
      operations: operations.map(cloneMergeOperation),
      diagnostics: [],
    } satisfies StoredMergePreviewPayload,
  });

  return {
    ok: true,
    preview: {
      ...comparePreview,
      operations: operations.map(cloneMergeOperation),
      diagnostics: [],
    },
    diagnostics: [],
  };
}

export function validateMergePreflight(input: PreflightInput): PreflightResult {
  const diagnostics: CompareMessage[] = [];
  const previewSourceId = findPreviewSourceId(input.session, input.previewId);
  const executablePreview = requireExecutableMergePreview(input, diagnostics, previewSourceId);
  const preview = executablePreview
    ? materializeExecutableMergePreview(executablePreview, diagnostics)
    : undefined;

  if (input.approvedPreviewId !== input.previewId) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_APPROVED_PREVIEW_ID_REQUIRED',
        sourceId: preview?.targetSourceId ?? previewSourceId,
        suggestedAction: 'Executor must receive the approved preview id for this preview.',
      })
    );
  }

  if (preview) {
    validateBackupAndRollback(preview, input.backupPlan, input.rollbackPlan, diagnostics);

    for (const operation of preview.operations) {
      validateTargetHash(operation, input.currentTargetHashes, diagnostics, preview.targetSourceId);
      validateConflictResolution(
        operation.conflictId,
        input.conflictResolutions,
        preview.targetSourceId,
        operation.nodeId,
        operation.targetUri,
        diagnostics
      );
    }
  }

  const result: PreflightResult = {
    ok: diagnostics.length === 0,
    approvedPreviewId: input.approvedPreviewId,
    previewId: input.previewId,
    operations: preview ? preview.operations.map(cloneMergeOperation) : [],
    backupPlan: cloneBackupPlan(
      input.backupPlan,
      preview?.operations.map((operation) => operation.operationId)
    ),
    rollbackPlan: cloneRollbackPlan(
      input.rollbackPlan,
      preview?.operations.map((operation) => operation.operationId)
    ),
    diagnostics,
  };

  if (result.ok) {
    storeTrustedPreflightMaterialization(input.session, result);
  }

  return result;
}

export function materializeTrustedPreflight(
  session: CompareSession,
  approvedPreviewId: string
): TrustedPreflightMaterialization | undefined {
  const trusted = trustedPreflightMaterializations.get(session)?.get(approvedPreviewId);
  if (!trusted) {
    return undefined;
  }

  return {
    approvedPreviewId: trusted.approvedPreviewId,
    previewId: trusted.previewId,
    backupPlan: cloneBackupPlan(trusted.backupPlan),
    rollbackPlan: cloneRollbackPlan(trusted.rollbackPlan),
  };
}

function candidateToOperation(
  candidate: MergeCandidate,
  index: number,
  input: CreateMergePreviewInput,
  diagnostics: CompareMessage[]
): MergeOperation | undefined {
  if (isKeepTargetResolution(candidate.conflictId, input.conflictResolutions)) {
    return undefined;
  }

  if (!isSupportedOperationKind(candidate.kind)) {
    diagnostics.push(unsupportedOperationDiagnostic(candidate));
    return undefined;
  }

  validateConflictResolution(
    candidate.conflictId,
    input.conflictResolutions,
    candidate.sourceId,
    candidate.nodeId,
    candidate.targetUri,
    diagnostics
  );
  validateTargetHash(candidate, input.currentTargetHashes, diagnostics, candidate.sourceId);

  if (candidate.kind === 'bslLogicalRoutineMerge') {
    validateLogicalRoutineCandidate(candidate, diagnostics);
  }
  if (isBslRoutineOperationKind(candidate.kind)) {
    validateBslRoutineOperationCandidate(candidate, diagnostics);
  }
  if (isXmlOperationKind(candidate.kind)) {
    validateXmlPatchCandidate(candidate, diagnostics);
  }
  if (isFileOperationKind(candidate.kind)) {
    validateFileOperationCandidate(candidate, diagnostics);
  }

  if (diagnostics.length > 0) {
    return undefined;
  }

  return {
    operationId: `${candidate.kind}:${index}:${candidate.nodeId}`,
    kind: candidate.kind,
    sourceId: candidate.sourceId,
    snapshotId: candidate.snapshotId,
    nodeId: candidate.nodeId,
    targetUri: candidate.targetUri,
    expectedOldHash: candidate.expectedOldHash,
    newHash: candidate.newHash,
    conflictId: candidate.conflictId,
    logicalRoutine: candidate.logicalRoutine,
    xmlPatch: candidate.xmlPatch,
    fileOperation: candidate.fileOperation,
    bslRoutine: candidate.bslRoutine,
  };
}

function validateLogicalRoutineCandidate(
  candidate: MergeCandidate,
  diagnostics: CompareMessage[]
): void {
  if (!candidate.logicalRoutine) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_LOGICAL_GUARD_BLOCKED',
        sourceId: candidate.sourceId,
        nodeId: candidate.nodeId,
        path: candidate.targetUri,
        suggestedAction: 'Logical routine merge operation is missing guard payload.',
      })
    );
    return;
  }

  const guardResult = validateBslRoutineLogicalMergePlan(candidate.logicalRoutine.plan, {
    moduleId: candidate.logicalRoutine.moduleId,
    current: candidate.logicalRoutine.current,
  });
  if (guardResult.ok) {
    return;
  }

  diagnostics.push(
    ...guardResult.diagnostics.map((diagnostic) =>
      logicalGuardDiagnostic(candidate, diagnostic)
    )
  );
}

function validateTargetHash(
  operation: Pick<MergeCandidate | MergeOperation, 'targetUri' | 'expectedOldHash' | 'nodeId'>,
  currentTargetHashes: Readonly<Record<string, string>>,
  diagnostics: CompareMessage[],
  sourceId: string
): void {
  if (!operation.targetUri || !operation.expectedOldHash) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_TARGET_GUARD_MISSING',
        sourceId,
        nodeId: operation.nodeId,
        path: operation.targetUri,
        suggestedAction: 'Merge operation must include target uri and expected old hash.',
      })
    );
    return;
  }

  if (currentTargetHashes[operation.targetUri] !== operation.expectedOldHash) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_STALE_TARGET_HASH',
        sourceId,
        nodeId: operation.nodeId,
        path: operation.targetUri,
        suggestedAction: 'Refresh compare snapshots before creating or executing the merge preview.',
      })
    );
  }
}

function validateXmlPatchCandidate(
  candidate: MergeCandidate,
  diagnostics: CompareMessage[]
): void {
  if (!candidate.xmlPatch) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_XML_PATCH_MISSING',
        sourceId: candidate.sourceId,
        nodeId: candidate.nodeId,
        path: candidate.targetUri,
        suggestedAction: 'XML merge operation is missing patch payload.',
      })
    );
    return;
  }

  if (xmlKindForOperation(candidate.kind) !== candidate.xmlPatch.kind) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_XML_PATCH_KIND_MISMATCH',
        sourceId: candidate.sourceId,
        nodeId: candidate.nodeId,
        path: candidate.targetUri,
        suggestedAction: 'XML merge operation kind must match patch payload kind.',
      })
    );
  }
  if (
    candidate.targetUri &&
    candidate.xmlPatch.target.filePath &&
    candidate.xmlPatch.target.filePath !== candidate.targetUri
  ) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_XML_PATCH_TARGET_MISMATCH',
        sourceId: candidate.sourceId,
        nodeId: candidate.nodeId,
        path: candidate.targetUri,
        suggestedAction: 'XML patch target must match operation target uri.',
      })
    );
  }
  if (candidate.expectedOldHash && candidate.xmlPatch.expectedOldHash !== candidate.expectedOldHash) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_XML_PATCH_GUARD_MISMATCH',
        sourceId: candidate.sourceId,
        nodeId: candidate.nodeId,
        path: candidate.targetUri,
        suggestedAction: 'XML patch hash guard must match operation hash guard.',
      })
    );
  }
  if (candidate.newHash && candidate.xmlPatch.newHash !== candidate.newHash) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_XML_PATCH_NEW_HASH_MISMATCH',
        sourceId: candidate.sourceId,
        nodeId: candidate.nodeId,
        path: candidate.targetUri,
        suggestedAction: 'XML patch new hash must match operation new hash.',
      })
    );
  }
  if (candidate.xmlPatch.kind !== 'deleteNode' && !candidate.xmlPatch.replacementXml) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_XML_PATCH_REPLACEMENT_MISSING',
        sourceId: candidate.sourceId,
        nodeId: candidate.nodeId,
        path: candidate.targetUri,
        suggestedAction: 'XML insert/replace operation must include replacement XML.',
      })
    );
  }
}

function validateBslRoutineOperationCandidate(
  candidate: MergeCandidate,
  diagnostics: CompareMessage[]
): void {
  if (!candidate.bslRoutine) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_BSL_ROUTINE_PAYLOAD_MISSING',
        sourceId: candidate.sourceId,
        nodeId: candidate.nodeId,
        path: candidate.targetUri,
        suggestedAction: 'BSL routine insert/delete operation is missing routine payload.',
      })
    );
    return;
  }

  const payload = candidate.bslRoutine;
  const expectedPayloadKind = bslPayloadKindForOperation(candidate.kind);
  if (payload.kind !== expectedPayloadKind) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_BSL_ROUTINE_KIND_MISMATCH',
        sourceId: candidate.sourceId,
        nodeId: candidate.nodeId,
        path: candidate.targetUri,
        suggestedAction: 'BSL routine operation kind must match routine payload kind.',
      })
    );
  }
  if (candidate.targetUri && payload.targetPath !== candidate.targetUri) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_BSL_ROUTINE_TARGET_MISMATCH',
        sourceId: candidate.sourceId,
        nodeId: candidate.nodeId,
        path: candidate.targetUri,
        suggestedAction: 'BSL routine payload target must match operation target uri.',
      })
    );
  }
  if (candidate.expectedOldHash && payload.expectedOldHash !== candidate.expectedOldHash) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_BSL_ROUTINE_GUARD_MISMATCH',
        sourceId: candidate.sourceId,
        nodeId: candidate.nodeId,
        path: candidate.targetUri,
        suggestedAction: 'BSL routine hash guard must match operation hash guard.',
      })
    );
  }
  if (candidate.newHash && payload.newHash !== candidate.newHash) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_BSL_ROUTINE_NEW_HASH_MISMATCH',
        sourceId: candidate.sourceId,
        nodeId: candidate.nodeId,
        path: candidate.targetUri,
        suggestedAction: 'BSL routine payload new hash must match operation new hash.',
      })
    );
  }
  if (!candidate.newHash) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_BSL_ROUTINE_NEW_HASH_MISSING',
        sourceId: candidate.sourceId,
        nodeId: candidate.nodeId,
        path: candidate.targetUri,
        suggestedAction: 'BSL routine insert/delete operation must include final module hash.',
      })
    );
  }
  if (!payload.sourceText || payload.sourceText.trim().length === 0) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_BSL_ROUTINE_SOURCE_MISSING',
        sourceId: candidate.sourceId,
        nodeId: candidate.nodeId,
        path: candidate.targetUri,
        suggestedAction: 'BSL routine insert/delete operation must include routine source text.',
      })
    );
  }
  if (payload.kind === 'insertRoutine' && !payload.sourceRange) {
    diagnostics.push(bslRoutineRangeDiagnostic(candidate, 'MERGE_BSL_ROUTINE_SOURCE_RANGE_MISSING'));
  }
  if (payload.kind === 'deleteRoutine' && !payload.targetRange) {
    diagnostics.push(bslRoutineRangeDiagnostic(candidate, 'MERGE_BSL_ROUTINE_TARGET_RANGE_MISSING'));
  }
}

function bslRoutineRangeDiagnostic(candidate: MergeCandidate, code: string): CompareMessage {
  return compareMessage({
    severity: 'error',
    code,
    sourceId: candidate.sourceId,
    nodeId: candidate.nodeId,
    path: candidate.targetUri,
    suggestedAction: 'BSL routine insert/delete operation must include the routine source and target range guards.',
  });
}

function validateFileOperationCandidate(
  candidate: MergeCandidate,
  diagnostics: CompareMessage[]
): void {
  if (!candidate.fileOperation) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_FILE_OPERATION_MISSING',
        sourceId: candidate.sourceId,
        nodeId: candidate.nodeId,
        path: candidate.targetUri,
        suggestedAction: 'File merge operation is missing file operation payload.',
      })
    );
    return;
  }

  if (candidate.fileOperation.kind !== candidate.kind) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_FILE_OPERATION_KIND_MISMATCH',
        sourceId: candidate.sourceId,
        nodeId: candidate.nodeId,
        path: candidate.targetUri,
        suggestedAction: 'File merge operation kind must match file operation payload kind.',
      })
    );
  }
  if (candidate.targetUri && candidate.fileOperation.targetPath !== candidate.targetUri) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_FILE_OPERATION_TARGET_MISMATCH',
        sourceId: candidate.sourceId,
        nodeId: candidate.nodeId,
        path: candidate.targetUri,
        suggestedAction: 'File operation target path must match operation target uri.',
      })
    );
  }
  if (
    candidate.expectedOldHash &&
    candidate.fileOperation.expectedOldHash &&
    candidate.fileOperation.expectedOldHash !== candidate.expectedOldHash
  ) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_FILE_OPERATION_GUARD_MISMATCH',
        sourceId: candidate.sourceId,
        nodeId: candidate.nodeId,
        path: candidate.targetUri,
        suggestedAction: 'File operation hash guard must match operation hash guard.',
      })
    );
  }
  if (
    (candidate.kind === 'fileCopy' || candidate.kind === 'folderCopy') &&
    (!candidate.fileOperation.sourcePath || !candidate.fileOperation.sourceHash)
  ) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_FILE_OPERATION_SOURCE_MISSING',
        sourceId: candidate.sourceId,
        nodeId: candidate.nodeId,
        path: candidate.targetUri,
        suggestedAction: 'Copy operation must include source path and source hash.',
      })
    );
  }
}

function validateConflictResolution(
  conflictId: string | undefined,
  conflictResolutions: Readonly<Record<string, ConflictResolutionChoice>> | undefined,
  sourceId: string,
  nodeId: string | undefined,
  targetUri: string | undefined,
  diagnostics: CompareMessage[]
): void {
  if (!conflictId) {
    return;
  }

  const resolution = conflictResolutions?.[conflictId];
  if (!resolution || resolution === 'manual') {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_CONFLICT_RESOLUTION_REQUIRED',
        sourceId,
        nodeId,
        path: targetUri,
        suggestedAction: 'Resolve merge conflict before creating or executing preview.',
      })
    );
  }
}

function validateBackupAndRollback(
  preview: MergePreview,
  backupPlan: BackupPlan,
  rollbackPlan: RollbackPlan,
  diagnostics: CompareMessage[]
): void {
  const sourceId = preview.targetSourceId;
  if (backupPlan.previewId !== preview.previewId) {
    diagnostics.push(planDiagnostic('MERGE_BACKUP_PLAN_PREVIEW_MISMATCH', sourceId));
  }
  if (rollbackPlan.previewId !== preview.previewId) {
    diagnostics.push(planDiagnostic('MERGE_ROLLBACK_PLAN_PREVIEW_MISMATCH', sourceId));
  }

  const operationIds = new Set(preview.operations.map((operation) => operation.operationId));
  validateUniquePlanOperationIds(
    backupPlan.items,
    'MERGE_BACKUP_PLAN_DUPLICATE_ITEM',
    sourceId,
    diagnostics
  );
  validateUniquePlanOperationIds(
    rollbackPlan.items,
    'MERGE_ROLLBACK_PLAN_DUPLICATE_ITEM',
    sourceId,
    diagnostics
  );

  for (const backup of backupPlan.items) {
    if (!operationIds.has(backup.operationId)) {
      diagnostics.push(planDiagnostic('MERGE_BACKUP_PLAN_EXTRA_ITEM', sourceId));
    }
  }
  for (const rollback of rollbackPlan.items) {
    if (!operationIds.has(rollback.operationId)) {
      diagnostics.push(planDiagnostic('MERGE_ROLLBACK_PLAN_EXTRA_ITEM', sourceId));
    }
  }

  for (const operation of preview.operations) {
    if (!operation.targetUri || !operation.expectedOldHash) {
      continue;
    }

    const backup = backupPlan.items.find((item) => item.operationId === operation.operationId);
    if (
      !backup ||
      backup.targetUri !== operation.targetUri ||
      backup.expectedOldHash !== operation.expectedOldHash ||
      backup.backupUri.length === 0
    ) {
      diagnostics.push(planDiagnostic('MERGE_BACKUP_PLAN_INCOMPLETE', sourceId, operation));
      continue;
    }

    const rollback = rollbackPlan.items.find((item) => item.operationId === operation.operationId);
    if (
      !rollback ||
      rollback.targetUri !== operation.targetUri ||
      rollback.backupUri !== backup.backupUri ||
      rollback.restoreHash !== operation.expectedOldHash
    ) {
      diagnostics.push(planDiagnostic('MERGE_ROLLBACK_PLAN_INCOMPLETE', sourceId, operation));
    }
  }
}

function validateUniquePlanOperationIds(
  items: readonly { operationId: string }[],
  code: string,
  sourceId: string,
  diagnostics: CompareMessage[]
): void {
  const seen = new Set<string>();
  const reported = new Set<string>();

  for (const item of items) {
    if (!seen.has(item.operationId)) {
      seen.add(item.operationId);
      continue;
    }

    if (!reported.has(item.operationId)) {
      diagnostics.push(planDiagnostic(code, sourceId));
      reported.add(item.operationId);
    }
  }
}

function identityConflictDiagnostic(
  conflict: IdentityConflict,
  targetSourceId: string
): CompareMessage {
  return compareMessage({
    severity: 'error',
    code: 'MERGE_IDENTITY_CONFLICT',
    sourceId: conflict.sourceId ?? targetSourceId,
    nodeId: conflict.qualifiedName ?? conflict.uuid,
    path: conflict.identities[0]?.filePath,
    suggestedAction: conflict.message,
  });
}

function unsupportedOperationDiagnostic(candidate: MergeCandidate): CompareMessage {
  return compareMessage({
    severity: 'error',
    code: 'MERGE_UNSUPPORTED_OPERATION',
    sourceId: candidate.sourceId,
    nodeId: candidate.nodeId,
    path: candidate.targetUri,
    suggestedAction: `Operation ${candidate.kind} is not executable in merge preview.`,
  });
}

function logicalGuardDiagnostic(
  candidate: MergeCandidate,
  diagnostic: BslRoutineLogicalManualDiagnostic
): CompareMessage {
  return compareMessage({
    severity: 'error',
    code: 'MERGE_LOGICAL_GUARD_BLOCKED',
    sourceId: candidate.sourceId,
    nodeId: candidate.nodeId,
    path: candidate.targetUri,
    range: diagnostic.range
      ? {
          startLine: diagnostic.range.startLine,
          startCharacter: diagnostic.range.startColumn,
          endLine: diagnostic.range.endLine,
          endCharacter: diagnostic.range.endColumn,
        }
      : undefined,
    suggestedAction: diagnostic.message,
  });
}

function planDiagnostic(
  code: string,
  sourceId: string,
  operation?: Pick<MergeOperation, 'nodeId' | 'targetUri'>
): CompareMessage {
  return compareMessage({
    severity: 'error',
    code,
    sourceId,
    nodeId: operation?.nodeId,
    path: operation?.targetUri,
    suggestedAction: 'Backup and rollback plan metadata must match the approved merge preview.',
  });
}

function requireExecutableMergePreview(
  input: PreflightInput,
  diagnostics: CompareMessage[],
  fallbackSourceId: string
): MergePreview | undefined {
  try {
    return input.session.requireExecutablePreview(input.previewId) as MergePreview;
  } catch {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_PREVIEW_NOT_EXECUTABLE',
        sourceId: fallbackSourceId,
        suggestedAction: 'Approve the stored merge preview in the current compare session before execution.',
      })
    );
    return undefined;
  }
}

export function materializeExecutableMergePreview(
  preview: MergePreview,
  diagnostics: CompareMessage[]
): MergePreview | undefined {
  const payload = preview.payload;
  if (!isStoredMergePreviewPayload(payload)) {
    diagnostics.push(
      compareMessage({
        severity: 'error',
        code: 'MERGE_PREVIEW_PAYLOAD_MISSING',
        sourceId: preview.targetSourceId,
        suggestedAction: 'Recreate the merge preview before execution.',
      })
    );
    return undefined;
  }

  for (const operation of payload.operations) {
    if (!isSupportedOperationKind(operation.kind)) {
      diagnostics.push(unsupportedOperationDiagnostic(operation));
    }
  }

  if (diagnostics.length > 0) {
    return undefined;
  }

  return {
    ...preview,
    operations: payload.operations.map(cloneMergeOperation),
    diagnostics: payload.diagnostics.map(cloneCompareMessage),
  };
}

function isStoredMergePreviewPayload(payload: unknown): payload is StoredMergePreviewPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const candidate = payload as Partial<StoredMergePreviewPayload>;
  return (
    candidate.kind === 'mergePreviewPayload' &&
    Array.isArray(candidate.operations) &&
    Array.isArray(candidate.diagnostics)
  );
}

function findPreviewSourceId(session: CompareSession, previewId: string): string {
  return (
    session.state.previews.find((preview) => preview.previewId === previewId)?.targetSourceId ??
    'unknown-source'
  );
}

function isKeepTargetResolution(
  conflictId: string | undefined,
  conflictResolutions: Readonly<Record<string, ConflictResolutionChoice>> | undefined
): boolean {
  return Boolean(conflictId && conflictResolutions?.[conflictId] === 'keepTarget');
}

function isSupportedOperationKind(kind: unknown): kind is MergeSupportedOperationKind {
  return (
    kind === 'bslLogicalAutoInsert' ||
    kind === 'bslLeafReplace' ||
    kind === 'bslRoutineReplace' ||
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

function isXmlOperationKind(kind: MergeCandidate['kind']): boolean {
  return kind === 'xmlNodeReplace' || kind === 'xmlNodeInsert' || kind === 'xmlNodeDelete';
}

function isFileOperationKind(kind: MergeCandidate['kind']): boolean {
  return kind === 'fileCopy' || kind === 'fileDelete' || kind === 'folderCopy' || kind === 'folderDelete';
}

function isBslRoutineOperationKind(kind: MergeCandidate['kind']): boolean {
  return kind === 'bslRoutineInsert' || kind === 'bslRoutineDelete';
}

function bslPayloadKindForOperation(
  kind: MergeCandidate['kind']
): BslRoutineOperationPayload['kind'] | undefined {
  if (kind === 'bslRoutineInsert') {
    return 'insertRoutine';
  }
  if (kind === 'bslRoutineDelete') {
    return 'deleteRoutine';
  }

  return undefined;
}

function xmlKindForOperation(kind: MergeCandidate['kind']): XmlPatchPayload['kind'] | undefined {
  if (kind === 'xmlNodeReplace') {
    return 'replaceNode';
  }
  if (kind === 'xmlNodeInsert') {
    return 'insertNode';
  }
  if (kind === 'xmlNodeDelete') {
    return 'deleteNode';
  }

  return undefined;
}

function summarizeOperations(operations: readonly MergeOperation[]): string {
  return `Prepared ${operations.length} merge operation${operations.length === 1 ? '' : 's'}.`;
}

function cloneBackupPlan(plan: BackupPlan, operationIds?: readonly string[]): BackupPlan {
  return {
    ...plan,
    items: cloneUniquePlanItems(plan.items, operationIds),
  };
}

function cloneRollbackPlan(plan: RollbackPlan, operationIds?: readonly string[]): RollbackPlan {
  return {
    ...plan,
    items: cloneUniquePlanItems(plan.items, operationIds),
  };
}

function storeTrustedPreflightMaterialization(
  session: CompareSession,
  preflight: PreflightResult
): void {
  const sessionMaterializations =
    trustedPreflightMaterializations.get(session) ?? new Map<string, TrustedPreflightMaterialization>();
  trustedPreflightMaterializations.set(session, sessionMaterializations);
  sessionMaterializations.set(preflight.approvedPreviewId, {
    approvedPreviewId: preflight.approvedPreviewId,
    previewId: preflight.previewId,
    backupPlan: cloneBackupPlan(preflight.backupPlan),
    rollbackPlan: cloneRollbackPlan(preflight.rollbackPlan),
  });
}

function cloneUniquePlanItems<T extends { operationId: string }>(
  items: readonly T[],
  operationIds?: readonly string[]
): T[] {
  const allowedOperationIds = operationIds ? new Set(operationIds) : undefined;
  const seen = new Set<string>();
  const clonedItems: T[] = [];

  for (const item of items) {
    if (allowedOperationIds && !allowedOperationIds.has(item.operationId)) {
      continue;
    }
    if (seen.has(item.operationId)) {
      continue;
    }

    seen.add(item.operationId);
    clonedItems.push({ ...item });
  }

  return clonedItems;
}

function cloneCompareMessage(message: CompareMessage): CompareMessage {
  return {
    ...message,
    range: message.range ? { ...message.range } : undefined,
  };
}
