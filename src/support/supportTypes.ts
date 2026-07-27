import type { ConfigurationId } from '../services/configurationSession/types';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';

export type ObjectSupportMode = 'notEditable' | 'editableWithSupport' | 'removedFromSupport';
export type ConfigurationSupportMode = 'locked' | 'mixed' | 'editable';
export type GlobalEditability = 'enabled' | 'disabled';

export type SupportMasterErrorCode =
  | 'SUPPORT_NOT_MANAGED'
  | 'SUPPORT_FILE_MISSING'
  | 'SUPPORT_FILE_INVALID'
  | 'SUPPORT_FORMAT_UNSUPPORTED'
  | 'SUPPORT_MASTER_RECOVERY_REQUIRED';

export type SupportMutationErrorCode =
  | 'SUPPORT_OBJECT_NOT_FOUND'
  | 'SUPPORT_STALE_GENERATION'
  | 'SUPPORT_METADATA_UNIVERSE_STALE'
  | 'SUPPORT_MASTER_RECOVERY_REQUIRED'
  | 'SUPPORT_GLOBAL_EDITING_DISABLED'
  | 'SUPPORT_OBJECT_UNIVERSE_INCOMPLETE'
  | 'SUPPORT_EFFECTIVE_DIFF_VIOLATION';

/** Stable operational codes safe to persist in the support run journal. */
export const SUPPORT_OPERATIONAL_ERROR_CODES = [
  'SUPPORT_NOT_MANAGED',
  'SUPPORT_FILE_MISSING',
  'SUPPORT_FILE_INVALID',
  'SUPPORT_FORMAT_UNSUPPORTED',
  'SUPPORT_MASTER_RECOVERY_REQUIRED',
  'SUPPORT_OBJECT_NOT_FOUND',
  'SUPPORT_STALE_GENERATION',
  'SUPPORT_METADATA_UNIVERSE_STALE',
  'SUPPORT_GLOBAL_EDITING_DISABLED',
  'SUPPORT_OBJECT_UNIVERSE_INCOMPLETE',
  'SUPPORT_EFFECTIVE_DIFF_VIOLATION',
  'SUPPORT_BINDING_INVALID',
  'SUPPORT_TARGET_UNSUPPORTED',
  'SUPPORT_TARGET_TYPE_UNSUPPORTED',
  'SUPPORT_FILE_TARGET_UNAVAILABLE',
  'SUPPORT_TARGET_PROBE_FAILED',
  'SUPPORT_TARGET_DRIFT',
  'SUPPORT_PREPARE_FAILED',
  'SUPPORT_APPLY_FAILED',
  'SUPPORT_VERIFY_FAILED',
  'SUPPORT_DUMP_FAILED',
  'SUPPORT_DUMP_INVALID',
  'SUPPORT_DUMP_SUPPLIER_MISMATCH',
  'SUPPORT_ACK_PERSIST_FAILED',
  'SUPPORT_ACKNOWLEDGED_GENERATION_MISMATCH',
  'SUPPORT_TARGET_LEASE_FAILED',
  'SUPPORT_RUN_INTERRUPTED',
  'SUPPORT_JOURNAL_INVALID',
  'SUPPORT_JOURNAL_CONFLICT',
  'SUPPORT_OPERATION_FAILED',
  'SUPPORT_REPLICATION_FAILED',
  'SUPPORT_REPLICATION_INCOMPLETE',
  'SUPPORT_REPLICATION_PREFLIGHT_DRIFT',
  'CONFIGURATOR_TARGET_UNSUPPORTED',
  'CONFIGURATOR_EXECUTABLE_NOT_FOUND',
  'CONFIGURATOR_EXECUTABLE_INVALID',
  'CONFIGURATOR_PLATFORM_VERSION_UNKNOWN',
  'CONFIGURATOR_PLATFORM_VERSION_MISMATCH',
  'CONFIGURATOR_CANCELLED_BEFORE_START',
  'CONFIGURATOR_OUTPUT_PREPARE_FAILED',
  'CONFIGURATOR_SPAWN_FAILED',
  'CONFIGURATOR_EXIT_FAILED',
  'CONFIGURATOR_FATAL_MARKER',
  'CONFIGURATOR_CANCELLED_AFTER_START',
  'CONFIGURATOR_TIMED_OUT_AFTER_START',
  'CONFIGURATOR_PROCESS_START_UNCERTAIN',
  'CONFIGURATOR_PROCESS_CRASHED',
  'CONFIGURATOR_ACKNOWLEDGEMENT_LOST',
  'CONFIGURATOR_OUTPUT_UNREADABLE',
] as const;

export type SupportOperationalErrorCode = typeof SUPPORT_OPERATIONAL_ERROR_CODES[number];

export interface SupplierSupportState {
  readonly supplierConfigurationId: string;
  readonly name: string;
  readonly vendor: string;
  readonly version: string;
  readonly blockEditability: GlobalEditability;
}

export interface ObjectSupportSource {
  readonly supplierConfigurationId: string;
  readonly rawMode: ObjectSupportMode;
}

export interface ObjectSupportState {
  readonly objectId: string;
  readonly locked: boolean;
  readonly effectiveMode: ObjectSupportMode;
  readonly sources: readonly ObjectSupportSource[];
}

export interface MasterSupportSnapshot {
  readonly configurationId: ConfigurationId;
  readonly generationId: string;
  readonly semanticDigest: string;
  readonly filePath: string;
  readonly formatRevision: string;
  readonly globalEditability: GlobalEditability;
  readonly configurationMode: ConfigurationSupportMode;
  readonly objectModes: ReadonlyMap<string, ObjectSupportState>;
  readonly supplierConfigurations: readonly SupplierSupportState[];
}

export type MasterSupportState =
  | { readonly kind: 'ready'; readonly snapshot: MasterSupportSnapshot }
  | {
      readonly kind: 'unmanaged';
      readonly reason: 'missing';
      readonly configurationId: ConfigurationId;
      readonly expectedFilePath: string;
    }
  | {
      readonly kind: 'unmanaged';
      readonly reason: 'empty';
      readonly configurationId: ConfigurationId;
      readonly expectedFilePath: string;
    }
  | {
      readonly kind: 'unknown';
      readonly configurationId: ConfigurationId;
      readonly filePath: string;
      readonly generationId?: string;
      readonly errorCode: 'SUPPORT_FILE_INVALID' | 'SUPPORT_FORMAT_UNSUPPORTED' | 'SUPPORT_MASTER_RECOVERY_REQUIRED';
      readonly diagnostics: readonly string[];
    };

export interface SupportMutationRequest {
  readonly configurationId: ConfigurationId;
  readonly objectId: string;
  readonly targetMode: ObjectSupportMode;
  readonly expectedGenerationId: string;
}

export interface EnableObjectRulesRequest {
  readonly configurationId: ConfigurationId;
  readonly targetObjectId: string;
  readonly targetMode: 'editableWithSupport' | 'removedFromSupport';
  readonly expectedGenerationId: string;
  readonly expectedMetadataUniverseGenerationId: string;
}

export interface SupportMutationResult {
  readonly before: MasterSupportSnapshot;
  readonly after: MasterSupportSnapshot;
  readonly changedTokenCount: number;
}

export interface MetadataUniverseEntry {
  readonly relativeMetadataPath: string;
  readonly objectUuid: string;
  readonly supportSubjectUuid: string;
}

export interface MetadataUniverseSnapshot {
  readonly configRoot: string;
  readonly metadataUniverseGenerationId: string;
  readonly entries: readonly MetadataUniverseEntry[];
}

export interface TargetGenerationRef {
  readonly canonicalTargetId: string;
  readonly infobaseIds: readonly string[];
  readonly desiredGenerationId: string;
}

export type TargetSupportSyncState =
  | TargetGenerationRef & { readonly state: 'pending' }
  | TargetGenerationRef & { readonly state: 'preparing'; readonly startedAt: string }
  | TargetGenerationRef & { readonly state: 'applying'; readonly startedAt: string }
  | TargetGenerationRef & { readonly state: 'verifying'; readonly startedAt: string }
  | TargetGenerationRef & { readonly state: 'reconciling'; readonly startedAt: string }
  | TargetGenerationRef & {
      readonly state: 'applied';
      readonly acknowledgedGenerationId: string;
      readonly evidence: 'configuratorAck' | 'cachedConfiguratorAck';
    }
  | TargetGenerationRef & {
      readonly state: 'verified';
      readonly verifiedGenerationId: string;
      readonly evidence: 'semanticDump';
    }
  | TargetGenerationRef & {
      readonly state: 'stale';
      readonly reason: 'masterAdvanced' | 'targetDrift';
      readonly lastAppliedGenerationId?: string;
    }
  | TargetGenerationRef & {
      readonly state: 'failed';
      readonly stage: 'prepare' | 'apply' | 'verify';
      readonly errorCode: SupportOperationalErrorCode;
      readonly retryable: boolean;
    }
  | TargetGenerationRef & {
      readonly state: 'inDoubt';
      readonly stage: 'apply' | 'reconcile';
      readonly errorCode: SupportOperationalErrorCode;
    }
  | TargetGenerationRef & {
      readonly state: 'skipped';
      readonly reason: 'cancelled' | 'obsolete';
    };

export type TargetSupportSyncResult = Extract<
  TargetSupportSyncState,
  { readonly state: 'applied' | 'verified' | 'stale' | 'failed' | 'inDoubt' | 'skipped' }
>;

export type TargetSupportVerifyResult =
  | Extract<TargetSupportSyncResult, { readonly state: 'verified' | 'stale' | 'skipped' }>
  | TargetGenerationRef & {
      readonly state: 'failed';
      readonly stage: 'verify';
      readonly errorCode: SupportOperationalErrorCode;
      readonly retryable: boolean;
    }
  | TargetGenerationRef & {
      readonly state: 'inDoubt';
      readonly stage: 'reconcile';
      readonly errorCode: SupportOperationalErrorCode;
    };

export interface ReadySupportTarget {
  readonly canonicalTargetId: string;
  readonly infobaseIds: readonly string[];
  readonly state: 'ready';
}

export interface UnsupportedSupportTarget {
  readonly canonicalTargetId: string;
  readonly infobaseIds: readonly string[];
  readonly state: 'targetUnsupported';
  readonly errorCode: SupportOperationalErrorCode;
}

export type SupportPreflightResult =
  | { readonly accepted: true; readonly scope: 'masterOnly'; readonly targets: readonly [] }
  | {
      readonly accepted: true;
      readonly scope: 'replicated';
      readonly targets: readonly [ReadySupportTarget, ...ReadySupportTarget[]];
    }
  | {
      readonly accepted: false;
      readonly reason: 'bindingInvalid';
      readonly errorCode: 'SUPPORT_BINDING_INVALID';
      readonly diagnostics: readonly string[];
    }
  | {
      readonly accepted: false;
      readonly reason: 'targetUnsupported';
      readonly errorCode: 'SUPPORT_TARGET_UNSUPPORTED';
      readonly readyTargets: readonly ReadySupportTarget[];
      readonly unsupportedTargets: readonly [UnsupportedSupportTarget, ...UnsupportedSupportTarget[]];
    };

export type SupportTargetCapability =
  | {
      readonly supported: true;
      readonly canonicalTargetId: string;
      readonly strategyId: string;
      readonly platformVersion: string;
    }
  | {
      readonly supported: false;
      readonly errorCode: SupportOperationalErrorCode;
      readonly diagnostics?: readonly string[];
    };

export interface FileDatabaseStamp {
  readonly resolvedPath: string;
  readonly fileId: string;
  readonly length: number;
  readonly lastWriteTimeUtcTicks: string;
}

export interface SupportPayloadCacheKey {
  readonly canonicalTargetId: string;
  readonly platformVersion: string;
  readonly configurationId: ConfigurationId;
  readonly supplierConfigurationIds: readonly string[];
  readonly formatRevision: string;
}

export interface PreparedSupportSupplierFile {
  readonly supplierConfigurationId: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly cacheEntryId: string;
  /** A private copy whose hash is revalidated immediately before apply. */
  readonly content: Uint8Array;
}

export interface PreparedTargetSupportPayload {
  readonly cacheKey: SupportPayloadCacheKey;
  readonly canonicalTargetId: string;
  readonly platformVersion: string;
  readonly databaseStamp: FileDatabaseStamp;
  readonly observedSemanticDigest: string;
  readonly supplierFiles: readonly PreparedSupportSupplierFile[];
  readonly desiredGenerationId: string;
  readonly desiredMasterBytes: Uint8Array;
  readonly acknowledgedGenerationId?: string;
}

export type SupportPrepareOutcome =
  | { readonly status: 'prepared'; readonly payload: PreparedTargetSupportPayload }
  | {
      readonly status: 'alreadyAcknowledged';
      readonly acknowledgedGenerationId: string;
      readonly evidence: 'cachedConfiguratorAck';
    }
  | {
      readonly status: 'matched';
      readonly verifiedGenerationId: string;
      readonly evidence: 'semanticDump';
    }
  | { readonly status: 'stale'; readonly reason: 'targetDrift' }
  | {
      readonly status: 'failed';
      readonly errorCode: SupportOperationalErrorCode;
      readonly retryable: boolean;
      readonly diagnostics?: readonly string[];
    };

export type SupportApplyOutcome =
  | { readonly status: 'acknowledged'; readonly acknowledgedGenerationId: string }
  | { readonly status: 'stale'; readonly reason: 'targetDrift' }
  | {
      readonly status: 'failed';
      readonly errorCode: SupportOperationalErrorCode;
      readonly retryable: boolean;
      readonly diagnostics?: readonly string[];
    }
  | {
      readonly status: 'inDoubt';
      readonly errorCode: SupportOperationalErrorCode;
      readonly diagnostics?: readonly string[];
    };

export type SupportVerifyOutcome =
  | { readonly status: 'matched'; readonly verifiedGenerationId: string }
  | {
      readonly status: 'mismatch';
      readonly lastAppliedGenerationId?: string;
      readonly payload: PreparedTargetSupportPayload;
    }
  | {
      readonly status: 'failed';
      readonly errorCode: SupportOperationalErrorCode;
      readonly diagnostics?: readonly string[];
    };

export interface SupportApplicator {
  probe(target: InfobaseEntry, snapshot: MasterSupportSnapshot): Promise<SupportTargetCapability>;
  prepare(
    target: InfobaseEntry,
    snapshot: MasterSupportSnapshot,
    cancellation: SupportCancellation,
  ): Promise<SupportPrepareOutcome>;
  apply(
    target: InfobaseEntry,
    snapshot: MasterSupportSnapshot,
    payload: PreparedTargetSupportPayload,
    cancellation: SupportCancellation,
  ): Promise<SupportApplyOutcome>;
  verify(
    target: InfobaseEntry,
    snapshot: MasterSupportSnapshot,
    cancellation: SupportCancellation,
  ): Promise<SupportVerifyOutcome>;
}

export type TargetSelection =
  | { readonly kind: 'all' }
  | {
      readonly kind: 'retryable';
      readonly include: readonly ('failed' | 'inDoubt' | 'targetDrift')[];
    }
  | { readonly kind: 'ids'; readonly targetIds: readonly string[] };

export interface SupportDisposable {
  dispose(): void;
}

export interface SupportCancellation {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): SupportDisposable;
}

export interface SupportSyncRequest {
  readonly snapshot: MasterSupportSnapshot;
  readonly verification: 'fast' | 'strict';
  readonly targets: TargetSelection;
  readonly cancellation?: SupportCancellation;
}

export interface SupportVerifyRequest {
  readonly snapshot: MasterSupportSnapshot;
  readonly targets: TargetSelection;
  readonly cancellation?: SupportCancellation;
}

export interface SupportRunHeader {
  readonly runId: string;
  readonly configurationId: ConfigurationId;
  readonly desiredGenerationId: string;
}

type TerminalSupportRun<TBase> =
  | TBase & {
      readonly state: 'complete' | 'partial' | 'failed' | 'cancelled';
      readonly supersededByGenerationId?: never;
    }
  | TBase & {
      readonly state: 'obsolete';
      readonly supersededByGenerationId: string;
    };

export type SupportSyncRunSummary =
  | SupportRunHeader & {
      readonly operation: 'sync';
      readonly scope: 'masterOnly';
      readonly targets: readonly [];
      readonly state: 'complete';
      readonly supersededByGenerationId?: never;
    }
  | TerminalSupportRun<
      SupportRunHeader & {
        readonly operation: 'sync';
        readonly scope: 'replicated';
        readonly targets: readonly TargetSupportSyncResult[];
      }
    >;

export type SupportVerifyRunSummary =
  | SupportRunHeader & {
      readonly operation: 'verify';
      readonly scope: 'masterOnly';
      readonly targets: readonly [];
      readonly state: 'complete';
      readonly supersededByGenerationId?: never;
    }
  | TerminalSupportRun<
      SupportRunHeader & {
        readonly operation: 'verify';
        readonly scope: 'replicated';
        readonly targets: readonly TargetSupportVerifyResult[];
      }
    >;

export type SupportRunSummary = SupportSyncRunSummary | SupportVerifyRunSummary;

type UnknownSupportMasterErrorCode = Exclude<
  SupportMasterErrorCode,
  'SUPPORT_NOT_MANAGED' | 'SUPPORT_FILE_MISSING'
>;

type UnknownMasterRejectedOutcome = {
  [TCode in UnknownSupportMasterErrorCode]: {
    readonly status: 'masterRejected';
    readonly master: Extract<MasterSupportState, { readonly kind: 'unknown' }> & {
      readonly errorCode: TCode;
    };
    readonly errorCode: TCode;
  };
}[UnknownSupportMasterErrorCode];

export type SupportMasterRejectedOutcome =
  | {
      readonly status: 'masterRejected';
      readonly master: Extract<MasterSupportState, { readonly kind: 'unmanaged'; readonly reason: 'missing' }>;
      readonly errorCode: 'SUPPORT_FILE_MISSING';
    }
  | {
      readonly status: 'masterRejected';
      readonly master: Extract<MasterSupportState, { readonly kind: 'unmanaged'; readonly reason: 'empty' }>;
      readonly errorCode: 'SUPPORT_NOT_MANAGED';
    }
  | UnknownMasterRejectedOutcome;

export interface SupportPreflightRejectedOutcome {
  readonly status: 'preflightRejected';
  readonly master: MasterSupportSnapshot;
  readonly preflight: Extract<SupportPreflightResult, { readonly accepted: false }>;
}

export type SupportSyncOutcome =
  | SupportMasterRejectedOutcome
  | SupportPreflightRejectedOutcome
  | {
      readonly status: 'completed';
      readonly master: MasterSupportSnapshot;
      readonly preflight: Extract<SupportPreflightResult, { readonly accepted: true; readonly scope: 'masterOnly' }>;
      readonly run: Extract<SupportSyncRunSummary, { readonly scope: 'masterOnly' }>;
    }
  | {
      readonly status: 'completed';
      readonly master: MasterSupportSnapshot;
      readonly preflight: Extract<SupportPreflightResult, { readonly accepted: true; readonly scope: 'replicated' }>;
      readonly run: Extract<SupportSyncRunSummary, { readonly scope: 'replicated' }>;
    };

export type SupportVerifyRunOutcome =
  | SupportMasterRejectedOutcome
  | SupportPreflightRejectedOutcome
  | {
      readonly status: 'completed';
      readonly master: MasterSupportSnapshot;
      readonly preflight: Extract<SupportPreflightResult, { readonly accepted: true; readonly scope: 'masterOnly' }>;
      readonly run: Extract<SupportVerifyRunSummary, { readonly scope: 'masterOnly' }>;
    }
  | {
      readonly status: 'completed';
      readonly master: MasterSupportSnapshot;
      readonly preflight: Extract<SupportPreflightResult, { readonly accepted: true; readonly scope: 'replicated' }>;
      readonly run: Extract<SupportVerifyRunSummary, { readonly scope: 'replicated' }>;
    };

export interface SupportStatusRequest {
  readonly configurationId: ConfigurationId;
  readonly objectIds?: readonly string[];
}

export interface SupportStatusResult {
  readonly status: 'available';
  readonly master: MasterSupportState;
  readonly metadataUniverse: MetadataUniverseSnapshot;
  readonly lastRun?: SupportRunSummary;
}

export interface SupportSyncOperationRequest {
  readonly configurationId: ConfigurationId;
  readonly targets: TargetSelection;
  readonly verification?: 'fast' | 'strict';
}

export interface SupportVerifyOperationRequest {
  readonly configurationId: ConfigurationId;
  readonly targets: TargetSelection;
}

export interface SupportGetLastRunRequest {
  readonly configurationId: ConfigurationId;
}

export interface SupportOperationRejectedOutcome {
  readonly status: 'operationRejected';
  readonly errorCode: 'SUPPORT_OPERATION_FAILED';
  readonly retryable: true;
}

export type SupportStatusOutcome = SupportStatusResult | SupportOperationRejectedOutcome;

export type SupportGetLastRunOutcome =
  | {
      readonly status: 'available';
      readonly run?: SupportRunSummary;
    }
  | SupportOperationRejectedOutcome;

export interface SupportMutationRejectedOutcome {
  readonly status: 'mutationRejected';
  readonly master: MasterSupportSnapshot;
  readonly preflight: Extract<SupportPreflightResult, { readonly accepted: true }>;
  readonly errorCode: SupportMutationErrorCode;
}

type SynchronizedSupportMutationOutcome =
  | {
      readonly status: 'synchronized';
      readonly preflight: Extract<
        SupportPreflightResult,
        { readonly accepted: true; readonly scope: 'masterOnly' }
      >;
      readonly mutation: SupportMutationResult;
      readonly desiredGenerationId: string;
      readonly run: Extract<SupportSyncRunSummary, { readonly scope: 'masterOnly' }> & {
        readonly state: 'complete';
      };
    }
  | {
      readonly status: 'synchronized';
      readonly preflight: Extract<
        SupportPreflightResult,
        { readonly accepted: true; readonly scope: 'replicated' }
      >;
      readonly mutation: SupportMutationResult;
      readonly desiredGenerationId: string;
      readonly run: Extract<SupportSyncRunSummary, { readonly scope: 'replicated' }> & {
        readonly state: 'complete';
      };
    };

export interface CommittedWithReplicationIssueOutcome {
  readonly status: 'committedWithReplicationIssue';
  readonly preflight: Extract<SupportPreflightResult, { readonly accepted: true }>;
  readonly mutation: SupportMutationResult;
  readonly desiredGenerationId: string;
  readonly errorCode:
    | 'SUPPORT_REPLICATION_FAILED'
    | 'SUPPORT_REPLICATION_INCOMPLETE'
    | 'SUPPORT_REPLICATION_PREFLIGHT_DRIFT';
  readonly retryable: true;
  readonly retryOperation: 'sync';
  readonly run?: SupportSyncRunSummary;
}

export type SupportModeMutationOutcome =
  | SupportMasterRejectedOutcome
  | SupportPreflightRejectedOutcome
  | SupportMutationRejectedOutcome
  | SupportOperationRejectedOutcome
  | SynchronizedSupportMutationOutcome
  | CommittedWithReplicationIssueOutcome;

export type SupportSyncOperationOutcome =
  | SupportMasterRejectedOutcome
  | SupportPreflightRejectedOutcome
  | SupportOperationRejectedOutcome
  | {
      readonly status: 'synchronized';
      readonly master: MasterSupportSnapshot;
      readonly preflight: Extract<SupportPreflightResult, { readonly accepted: true }>;
      readonly run: SupportSyncRunSummary & { readonly state: 'complete' };
    }
  | {
      readonly status: 'incomplete';
      readonly master: MasterSupportSnapshot;
      readonly errorCode: 'SUPPORT_REPLICATION_FAILED' | 'SUPPORT_REPLICATION_INCOMPLETE';
      readonly retryable: true;
      readonly preflight?: Extract<SupportPreflightResult, { readonly accepted: true }>;
      readonly run?: SupportSyncRunSummary;
    };

export type SupportVerifyOperationOutcome =
  | SupportMasterRejectedOutcome
  | SupportPreflightRejectedOutcome
  | SupportOperationRejectedOutcome
  | {
      readonly status: 'synchronized';
      readonly master: MasterSupportSnapshot;
      readonly preflight: Extract<SupportPreflightResult, { readonly accepted: true }>;
      readonly run: SupportVerifyRunSummary & { readonly state: 'complete' };
    }
  | {
      readonly status: 'incomplete';
      readonly master: MasterSupportSnapshot;
      readonly errorCode: 'SUPPORT_REPLICATION_FAILED' | 'SUPPORT_REPLICATION_INCOMPLETE';
      readonly retryable: true;
      readonly preflight?: Extract<SupportPreflightResult, { readonly accepted: true }>;
      readonly run?: SupportVerifyRunSummary;
    };

export class SupportMutationError extends Error {
  constructor(readonly code: SupportMutationErrorCode, message: string) {
    super(message);
    this.name = 'SupportMutationError';
  }
}
