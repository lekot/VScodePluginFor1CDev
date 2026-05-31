export type CompareSide = 'left' | 'right';

export type CompareSourceKind = 'workspace' | 'snapshot' | 'file' | 'infobase';

export type CompareMessageSeverity = 'info' | 'warning' | 'error';

export type ComparePhase = 'source' | 'snapshot' | 'compare' | 'preview' | 'execute';

export type CompareSnapshotCleanupPolicy = 'deleteOnSessionClose' | 'retainUntil' | 'manual';

export type PreviewApprovalState = 'draft' | 'approved' | 'executed';
export type MetadataIdentityConfidence = 'strong' | 'nameOnly';
export type MetadataNameSource = 'xmlPropertiesName' | 'fileName' | 'folderName' | 'callerInput';
export type MetadataUuidSource = 'xmlAttribute' | 'missing';
export type MetadataMatchKind = 'uuid' | 'qualifiedName';
export type IdentityConflictKind =
  | 'sameUuidDifferentName'
  | 'sameNameDifferentUuid'
  | 'duplicateQualifiedName'
  | 'duplicateUuid';
export type ConflictResolution = 'manual';

export interface CompareRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface CompareSource {
  sourceId: string;
  side: CompareSide;
  kind: CompareSourceKind;
  displayName: string;
  rootUri: string;
  targetWorkspaceRoot?: string;
  targetUri?: string;
  writable: boolean;
  snapshotId?: string;
}

export interface CompareSnapshot {
  snapshotId: string;
  sourceId: string;
  snapshotRoot: string;
  origin: string;
  createdAt: string;
  retentionUntil: string;
  sourceRevision: string;
  readOnly: boolean;
  cleanupPolicy: CompareSnapshotCleanupPolicy;
  contentHash: string;
}

export interface CompareMessage {
  severity: CompareMessageSeverity;
  code: string;
  phase: ComparePhase;
  sourceId: string;
  nodeId?: string;
  path?: string;
  range?: CompareRange;
  blocking: boolean;
  suggestedAction?: string;
}

export interface ComparePreview {
  previewId: string;
  sessionId: string;
  targetSourceId: string;
  snapshotIds: Readonly<Partial<Record<CompareSide, string>>>;
  createdAt: string;
  summary: string;
  approvalState: PreviewApprovalState;
  payload?: unknown;
}

export interface ComparePreviewInput {
  previewId: string;
  targetSourceId: string;
  snapshotIds: Readonly<Partial<Record<CompareSide, string>>>;
  createdAt: string;
  summary: string;
  payload?: unknown;
}

export interface MetadataIdentity {
  sourceId: string;
  side: CompareSide;
  metadataType: string;
  qualifiedName: string;
  uuid?: string;
  filePath: string;
  containerPath: string;
  objectPath: string;
  nameSource: MetadataNameSource;
  uuidSource: MetadataUuidSource;
  confidence: MetadataIdentityConfidence;
}

export interface MetadataIdentityMatch {
  left: MetadataIdentity;
  right: MetadataIdentity;
  matchKind: MetadataMatchKind;
  confidence: MetadataIdentityConfidence;
}

export interface IdentityConflict {
  kind: IdentityConflictKind;
  resolution: ConflictResolution;
  blocking: boolean;
  message: string;
  side?: CompareSide;
  sourceId?: string;
  metadataType?: string;
  qualifiedName?: string;
  uuid?: string;
  left?: MetadataIdentity;
  right?: MetadataIdentity;
  identities: MetadataIdentity[];
}

export interface MetadataMatchDiagnostic {
  severity: CompareMessageSeverity;
  code: string;
  phase: ComparePhase;
  blocking: boolean;
  message: string;
  side?: CompareSide;
  sourceId?: string;
  path?: string;
  identities: MetadataIdentity[];
}

export interface MatchResult {
  matches: MetadataIdentityMatch[];
  conflicts: IdentityConflict[];
  diagnostics: MetadataMatchDiagnostic[];
  unmatchedLeft: MetadataIdentity[];
  unmatchedRight: MetadataIdentity[];
}

export interface PreviewStoreCreateInput extends ComparePreviewInput {
  sessionId: string;
}

export interface PreviewGuard {
  sessionId: string;
  snapshotIds: Readonly<Partial<Record<CompareSide, string>>>;
}

export interface CompareSessionState {
  sessionId: string;
  createdAt: string;
  sources: CompareSource[];
  snapshots: CompareSnapshot[];
  messages: CompareMessage[];
  previews: ComparePreview[];
}

export interface CompareSessionCreateInput {
  sessionId: string;
  createdAt: string;
  sources: CompareSource[];
}
