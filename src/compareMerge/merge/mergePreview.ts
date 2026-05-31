import type {
  BslRoutineLogicalGuardInput,
  BslRoutineLogicalMergePlan,
} from '../bsl/bslRoutineMergePlanTypes';
import type { BslRoutineKind, BslTextRange } from '../../bsl/bslRoutineTypes';
import type { CompareMessage, ComparePreview, CompareSide, IdentityConflict } from '../domain/compareContracts';
import type { CompareSession } from '../domain/compareSession';

export type MergeSupportedOperationKind =
  | 'bslLogicalAutoInsert'
  | 'bslLeafReplace'
  | 'bslRoutineReplace'
  | 'bslLogicalRoutineMerge'
  | 'bslRoutineInsert'
  | 'bslRoutineDelete'
  | 'xmlNodeReplace'
  | 'xmlNodeInsert'
  | 'xmlNodeDelete'
  | 'fileCopy'
  | 'fileDelete'
  | 'folderCopy'
  | 'folderDelete';

export type MergeUnsupportedOperationKind =
  | 'metadataObjectCopy'
  | 'metadataObjectAdd'
  | 'metadataObjectRemove'
  | 'metadataUuidChange'
  | 'metadataNameChange'
  | 'configurationXmlStructuralMerge';

export type MergeCandidateKind = MergeSupportedOperationKind | MergeUnsupportedOperationKind;

export const MISSING_TARGET_HASH = '__missing__';

export type ConflictResolutionChoice = 'acceptIncoming' | 'keepTarget' | 'manual';

export interface LogicalRoutineMergePayload extends BslRoutineLogicalGuardInput {
  plan: BslRoutineLogicalMergePlan;
}

export interface XmlAddress {
  filePath: string;
  pointer: string;
  displayPath: string;
  identityKey?: string;
}

export interface XmlPatchPayload {
  kind: 'replaceNode' | 'insertNode' | 'deleteNode';
  target: XmlAddress;
  expectedOldHash: string;
  newHash: string;
  replacementXml?: string;
}

export interface FileOperationPayload {
  kind: 'fileCopy' | 'fileDelete' | 'folderCopy' | 'folderDelete';
  sourcePath?: string;
  targetPath: string;
  expectedOldHash?: string;
  sourceHash?: string;
  destructive: boolean;
}

export interface BslRoutineIdentityPayload {
  name: string;
  normalizedName: string;
  kind: BslRoutineKind;
  exported: boolean;
}

export interface BslRoutineOperationPayload {
  kind: 'insertRoutine' | 'deleteRoutine';
  targetPath: string;
  expectedOldHash: string;
  newHash: string;
  routine: BslRoutineIdentityPayload;
  sourceText: string;
  sourceRange?: BslTextRange;
  targetRange?: BslTextRange;
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
  xmlPatch?: XmlPatchPayload;
  fileOperation?: FileOperationPayload;
  bslRoutine?: BslRoutineOperationPayload;
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
  xmlPatch?: XmlPatchPayload;
  fileOperation?: FileOperationPayload;
  bslRoutine?: BslRoutineOperationPayload;
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
    xmlPatch: operation.xmlPatch
      ? {
          kind: operation.xmlPatch.kind,
          target: { ...operation.xmlPatch.target },
          expectedOldHash: operation.xmlPatch.expectedOldHash,
          newHash: operation.xmlPatch.newHash,
          replacementXml: operation.xmlPatch.replacementXml,
        }
      : undefined,
    fileOperation: operation.fileOperation
      ? {
          kind: operation.fileOperation.kind,
          sourcePath: operation.fileOperation.sourcePath,
          targetPath: operation.fileOperation.targetPath,
          expectedOldHash: operation.fileOperation.expectedOldHash,
          sourceHash: operation.fileOperation.sourceHash,
          destructive: operation.fileOperation.destructive,
        }
      : undefined,
    bslRoutine: operation.bslRoutine
      ? {
          kind: operation.bslRoutine.kind,
          targetPath: operation.bslRoutine.targetPath,
          expectedOldHash: operation.bslRoutine.expectedOldHash,
          newHash: operation.bslRoutine.newHash,
          routine: { ...operation.bslRoutine.routine },
          sourceText: operation.bslRoutine.sourceText,
          sourceRange: operation.bslRoutine.sourceRange
            ? { ...operation.bslRoutine.sourceRange }
            : undefined,
          targetRange: operation.bslRoutine.targetRange
            ? { ...operation.bslRoutine.targetRange }
            : undefined,
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
