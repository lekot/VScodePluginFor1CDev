import type {
  BslRoutineLogicalGuardInput,
  BslRoutineLogicalMergePlan,
} from '../bsl/bslRoutineMergePlanTypes';
import type { BslRoutineKind, BslTextRange } from '../../bsl/bslRoutineTypes';
import type { CompareMessage, ComparePreview, CompareSide, IdentityConflict } from '../domain/compareContracts';
import type { CompareSession } from '../domain/compareSession';
import type { XmlOrderScope } from '../xml/xmlPatchTypes';

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
  | 'xmlNodeMove'
  | 'fileCopy'
  | 'fileWrite'
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
  kind: 'replaceNode' | 'insertNode' | 'deleteNode' | 'moveNode';
  target: XmlAddress;
  destinationParent?: XmlAddress;
  createDestinationChildItems?: true;
  createDestinationChildObjects?: true;
  createDestinationEvents?: true;
  orderScope?: XmlOrderScope;
  insertBefore?: XmlAddress;
  insertPosition?: 'append';
  insertOrder?: number;
  semanticKind?: 'metadataXml' | 'formXml' | 'predefinedXml' | 'roleRightsXml' | 'dcsXml';
  expectedOldHash: string;
  newHash: string;
  replacementXml?: string;
  sourceWitnesses?: readonly MergeFileWitness[];
  semanticContext?: {
    availableFormReferences?: {
      attributes?: readonly string[];
      commands?: readonly string[];
      elements?: readonly string[];
    };
    availableMetadataReferences?: readonly string[];
    configurationName?: string;
    ownerDescriptorVersions?: { target: string; incoming: string };
  };
}

export interface FileOperationPayload {
  kind: 'fileCopy' | 'fileDelete' | 'folderCopy' | 'folderDelete';
  sourcePath?: string;
  targetPath: string;
  expectedOldHash?: string;
  sourceHash?: string;
  destructive: boolean;
}

export interface MergeFileWitness {
  sourceId: string;
  relativePath: string;
  expectedHash: string;
  kind?: 'file' | 'directory';
}

export interface CapturedFileWritePayload {
  contentBase64: string;
  witnesses: readonly MergeFileWitness[];
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
  /** Exact source-module range for sourceText when it includes attached directives. */
  sourceTextRange?: BslTextRange;
  /** Exact target-module range for sourceText when deleting attached directives. */
  targetTextRange?: BslTextRange;
}

export interface MergeCandidate {
  kind: MergeCandidateKind;
  sourceId: string;
  snapshotId: string;
  nodeId: string;
  targetUri?: string;
  previewPath?: string;
  previewEffect?: 'create' | 'replace' | 'delete';
  expectedOldHash?: string;
  newHash?: string;
  conflictId?: string;
  /** Captured files whose raw bytes were used to validate this operation. */
  sourceWitnesses?: readonly MergeFileWitness[];
  logicalRoutine?: LogicalRoutineMergePayload;
  xmlPatch?: XmlPatchPayload;
  fileOperation?: FileOperationPayload;
  fileWrite?: CapturedFileWritePayload;
  bslRoutine?: BslRoutineOperationPayload;
}

export interface MergeOperation {
  operationId: string;
  kind: MergeSupportedOperationKind;
  sourceId: string;
  snapshotId: string;
  nodeId: string;
  targetUri?: string;
  previewPath?: string;
  previewEffect?: 'create' | 'replace' | 'delete';
  expectedOldHash?: string;
  newHash?: string;
  conflictId?: string;
  /** Captured files whose raw bytes were used to validate this operation. */
  sourceWitnesses?: readonly MergeFileWitness[];
  logicalRoutine?: LogicalRoutineMergePayload;
  xmlPatch?: XmlPatchPayload;
  fileOperation?: FileOperationPayload;
  fileWrite?: CapturedFileWritePayload;
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
    sourceWitnesses: Array.isArray(operation.sourceWitnesses)
      ? operation.sourceWitnesses.map((witness) => ({ ...witness }))
      : operation.sourceWitnesses,
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
          destinationParent: operation.xmlPatch.destinationParent
            ? { ...operation.xmlPatch.destinationParent }
            : undefined,
          createDestinationChildItems: operation.xmlPatch.createDestinationChildItems,
          createDestinationChildObjects: operation.xmlPatch.createDestinationChildObjects,
          createDestinationEvents: operation.xmlPatch.createDestinationEvents,
          orderScope: operation.xmlPatch.orderScope ? { ...operation.xmlPatch.orderScope } : undefined,
          insertBefore: operation.xmlPatch.insertBefore
            ? { ...operation.xmlPatch.insertBefore }
            : undefined,
          insertPosition: operation.xmlPatch.insertPosition,
          insertOrder: operation.xmlPatch.insertOrder,
          semanticKind: operation.xmlPatch.semanticKind,
          expectedOldHash: operation.xmlPatch.expectedOldHash,
          newHash: operation.xmlPatch.newHash,
          replacementXml: operation.xmlPatch.replacementXml,
          sourceWitnesses: Array.isArray(operation.xmlPatch.sourceWitnesses)
            ? operation.xmlPatch.sourceWitnesses.map((witness) => ({ ...witness }))
            : operation.xmlPatch.sourceWitnesses,
          semanticContext: operation.xmlPatch.semanticContext
            ? {
                availableFormReferences: operation.xmlPatch.semanticContext.availableFormReferences
                  ? {
                      attributes: operation.xmlPatch.semanticContext.availableFormReferences.attributes
                        ? [...operation.xmlPatch.semanticContext.availableFormReferences.attributes]
                        : undefined,
                      commands: operation.xmlPatch.semanticContext.availableFormReferences.commands
                        ? [...operation.xmlPatch.semanticContext.availableFormReferences.commands]
                        : undefined,
                      elements: operation.xmlPatch.semanticContext.availableFormReferences.elements
                        ? [...operation.xmlPatch.semanticContext.availableFormReferences.elements]
                        : undefined,
                    }
                  : undefined,
                availableMetadataReferences: operation.xmlPatch.semanticContext.availableMetadataReferences
                  ? [...operation.xmlPatch.semanticContext.availableMetadataReferences]
                  : undefined,
                configurationName: operation.xmlPatch.semanticContext.configurationName,
                ownerDescriptorVersions: operation.xmlPatch.semanticContext.ownerDescriptorVersions
                  ? { ...operation.xmlPatch.semanticContext.ownerDescriptorVersions }
                  : undefined,
              }
            : undefined,
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
    fileWrite: operation.fileWrite
      ? {
          contentBase64: operation.fileWrite.contentBase64,
          witnesses: operation.fileWrite.witnesses.map((witness) => ({
            sourceId: witness.sourceId,
            relativePath: witness.relativePath,
            expectedHash: witness.expectedHash,
            kind: witness.kind,
          })),
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
          sourceTextRange: operation.bslRoutine.sourceTextRange
            ? { ...operation.bslRoutine.sourceTextRange }
            : undefined,
          targetTextRange: operation.bslRoutine.targetTextRange
            ? { ...operation.bslRoutine.targetTextRange }
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
