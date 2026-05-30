import type {
  BslRoutineLogicalGuardInput,
  BslRoutineLogicalMergePlan,
} from '../bsl/bslRoutineMergePlanTypes';
import type { CompareMessage, ComparePreview, CompareSide, IdentityConflict } from '../domain/compareContracts';
import type { CompareSession } from '../domain/compareSession';

export type MergeSupportedOperationKind =
  | 'bslLogicalAutoInsert'
  | 'bslLeafReplace'
  | 'bslRoutineReplace'
  | 'bslLogicalRoutineMerge';

export type MergeUnsupportedOperationKind =
  | 'metadataObjectCopy'
  | 'metadataObjectAdd'
  | 'metadataObjectRemove'
  | 'metadataUuidChange'
  | 'metadataNameChange'
  | 'configurationXmlStructuralMerge';

export type MergeCandidateKind = MergeSupportedOperationKind | MergeUnsupportedOperationKind;

export type ConflictResolutionChoice = 'acceptIncoming' | 'keepTarget' | 'manual';

export interface LogicalRoutineMergePayload extends BslRoutineLogicalGuardInput {
  plan: BslRoutineLogicalMergePlan;
}

export interface MergeCandidate {
  kind: MergeCandidateKind;
  sourceId: string;
  snapshotId: string;
  nodeId: string;
  targetUri?: string;
  expectedOldHash?: string;
  newHash?: string;
  conflictId?: string;
  logicalRoutine?: LogicalRoutineMergePayload;
}

export interface MergeOperation {
  operationId: string;
  kind: MergeSupportedOperationKind;
  sourceId: string;
  snapshotId: string;
  nodeId: string;
  targetUri?: string;
  expectedOldHash?: string;
  newHash?: string;
  conflictId?: string;
  logicalRoutine?: LogicalRoutineMergePayload;
}

export interface BackupPlanItem {
  operationId: string;
  targetUri: string;
  backupUri: string;
  expectedOldHash: string;
}

export interface BackupPlan {
  previewId: string;
  strategy: 'copyBeforeWrite';
  items: BackupPlanItem[];
}

export interface RollbackPlanItem {
  operationId: string;
  targetUri: string;
  backupUri: string;
  restoreHash: string;
}

export interface RollbackPlan {
  previewId: string;
  strategy: 'restoreBackups';
  items: RollbackPlanItem[];
}

export interface MergePreview extends ComparePreview {
  operations: MergeOperation[];
  diagnostics: CompareMessage[];
}

export interface StoredMergePreviewPayload {
  kind: 'mergePreviewPayload';
  operations: MergeOperation[];
  diagnostics: CompareMessage[];
}

export interface MergePreviewRequest {
  previewId: string;
  targetSourceId: string;
  snapshotIds: Readonly<Partial<Record<CompareSide, string>>>;
  createdAt: string;
  summary?: string;
  candidates: readonly MergeCandidate[];
  currentTargetHashes: Readonly<Record<string, string>>;
  identityConflicts?: readonly IdentityConflict[];
  conflictResolutions?: Readonly<Record<string, ConflictResolutionChoice>>;
}

export type PreviewValidationResult =
  | {
      ok: true;
      preview: MergePreview;
      diagnostics: [];
    }
  | {
      ok: false;
      diagnostics: CompareMessage[];
    };

export interface PreflightInput {
  session: CompareSession;
  previewId: string;
  approvedPreviewId: string;
  currentTargetHashes: Readonly<Record<string, string>>;
  conflictResolutions?: Readonly<Record<string, ConflictResolutionChoice>>;
  backupPlan: BackupPlan;
  rollbackPlan: RollbackPlan;
}

export interface PreflightResult {
  ok: boolean;
  approvedPreviewId: string;
  previewId: string;
  operations: MergeOperation[];
  backupPlan: BackupPlan;
  rollbackPlan: RollbackPlan;
  diagnostics: CompareMessage[];
}

export function cloneMergeOperation(operation: MergeOperation): MergeOperation {
  return {
    ...operation,
    logicalRoutine: operation.logicalRoutine
      ? {
          moduleId: operation.logicalRoutine.moduleId,
          current: operation.logicalRoutine.current,
          plan: operation.logicalRoutine.plan,
        }
      : undefined,
  };
}

export function compareMessage(input: Omit<CompareMessage, 'phase' | 'blocking'>): CompareMessage {
  return {
    ...input,
    phase: 'preview',
    blocking: true,
  };
}
