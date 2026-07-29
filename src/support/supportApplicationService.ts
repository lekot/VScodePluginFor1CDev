import type { ConfigurationId } from '../services/configurationSession/types';
import type { SupportModeService } from './supportModeService';
import type { SupportRunJournal } from './supportRunJournal';
import type { SupportSyncCoordinator } from './supportSyncCoordinator';
import type {
  EnableObjectRulesRequest,
  MasterSupportState,
  SupportCancellation,
  SupportGetLastRunOutcome,
  SupportGetLastRunRequest,
  SupportMasterStatusOutcome,
  SupportMasterStatusRequest,
  SupportModeMutationOutcome,
  SupportMutationRequest,
  SupportOperationRejectedOutcome,
  SupportStatusRequest,
  SupportStatusOutcome,
  SupportSyncOperationRequest,
  SupportSyncOperationOutcome,
  SupportSyncRunSummary,
  SupportVerifyOperationRequest,
  SupportVerifyOperationOutcome,
  SupportVerifyRunSummary,
} from './supportTypes';

const NEVER_CANCELLED: SupportCancellation = Object.freeze({
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
});

export interface SupportApplicationServiceDeps {
  readonly configurationId: ConfigurationId;
  readonly modeService: Pick<
    SupportModeService,
    'getStatus' | 'getMasterStatus' | 'setObjectMode' | 'enableObjectRules'
  >;
  readonly coordinator: Pick<SupportSyncCoordinator, 'sync' | 'verifyOnly'>;
  readonly journal: Pick<SupportRunJournal, 'getLastRun'>;
  readonly cancellation?: SupportCancellation;
}

/** The sole public application facade for support UI and Agent/MCP adapters. */
export class SupportApplicationService {
  private readonly cancellation: SupportCancellation;

  constructor(private readonly deps: SupportApplicationServiceDeps) {
    this.cancellation = deps.cancellation ?? NEVER_CANCELLED;
  }

  async getStatus(request: SupportStatusRequest): Promise<SupportStatusOutcome> {
    if (!this.isExpectedConfiguration(request.configurationId)) {
      return operationRejected();
    }
    const status = await this.deps.modeService.getStatus();
    if (status.status === 'operationRejected') {
      return status;
    }
    try {
      const lastRun = await this.deps.journal.getLastRun(request.configurationId);
      if (status.master.kind !== 'ready') {
        return {
          status: 'available',
          master: status.master,
          ...(lastRun ? { lastRun } : {}),
        };
      }
      const metadataUniverse = status.metadataUniverse;
      if (metadataUniverse === undefined) {
        return operationRejected();
      }
      return {
        status: 'available',
        master: filterMasterObjects(status.master, request.objectIds),
        metadataUniverse,
        ...(lastRun ? { lastRun } : {}),
      };
    } catch {
      return operationRejected();
    }
  }

  async getMasterStatus(request: SupportMasterStatusRequest): Promise<SupportMasterStatusOutcome> {
    if (!this.isExpectedConfiguration(request.configurationId)) {
      return operationRejected();
    }
    return this.deps.modeService.getMasterStatus();
  }

  setObjectMode(request: SupportMutationRequest): Promise<SupportModeMutationOutcome> {
    if (!this.isExpectedConfiguration(request.configurationId)) {
      return Promise.resolve(operationRejected());
    }
    return this.deps.modeService.setObjectMode(request);
  }

  enableObjectRules(request: EnableObjectRulesRequest): Promise<SupportModeMutationOutcome> {
    if (!this.isExpectedConfiguration(request.configurationId)) {
      return Promise.resolve(operationRejected());
    }
    return this.deps.modeService.enableObjectRules(request);
  }

  async sync(request: SupportSyncOperationRequest): Promise<SupportSyncOperationOutcome> {
    if (!this.isExpectedConfiguration(request.configurationId)) {
      return operationRejected();
    }
    const status = await this.getMasterStatus(request);
    if (status.status === 'operationRejected') {
      return status;
    }
    const master = status.master;
    if (master.kind !== 'ready') {
      return rejectMasterForSync(master);
    }
    try {
      const outcome = await this.deps.coordinator.sync({
        snapshot: master.snapshot,
        verification: request.verification ?? 'fast',
        targets: request.targets,
        cancellation: this.cancellation,
      });
      if (outcome.status !== 'completed') {
        return outcome;
      }
      if (isFullySynchronized(outcome.run)) {
        return {
          status: 'synchronized',
          master: outcome.master,
          preflight: outcome.preflight,
          run: outcome.run as typeof outcome.run & { readonly state: 'complete' },
        };
      }
      return {
        status: 'incomplete',
        master: outcome.master,
        preflight: outcome.preflight,
        run: outcome.run,
        errorCode: 'SUPPORT_REPLICATION_INCOMPLETE',
        retryable: true,
      };
    } catch {
      return {
        status: 'incomplete',
        master: master.snapshot,
        errorCode: 'SUPPORT_REPLICATION_FAILED',
        retryable: true,
      };
    }
  }

  async verify(request: SupportVerifyOperationRequest): Promise<SupportVerifyOperationOutcome> {
    if (!this.isExpectedConfiguration(request.configurationId)) {
      return operationRejected();
    }
    const status = await this.getMasterStatus(request);
    if (status.status === 'operationRejected') {
      return status;
    }
    const master = status.master;
    if (master.kind !== 'ready') {
      return rejectMasterForVerify(master);
    }
    try {
      const outcome = await this.deps.coordinator.verifyOnly({
        snapshot: master.snapshot,
        targets: request.targets,
        cancellation: this.cancellation,
      });
      if (outcome.status !== 'completed') {
        return outcome;
      }
      if (isFullyVerified(outcome.run)) {
        return {
          status: 'synchronized',
          master: outcome.master,
          preflight: outcome.preflight,
          run: outcome.run as typeof outcome.run & { readonly state: 'complete' },
        };
      }
      return {
        status: 'incomplete',
        master: outcome.master,
        preflight: outcome.preflight,
        run: outcome.run,
        errorCode: 'SUPPORT_REPLICATION_INCOMPLETE',
        retryable: true,
      };
    } catch {
      return {
        status: 'incomplete',
        master: master.snapshot,
        errorCode: 'SUPPORT_REPLICATION_FAILED',
        retryable: true,
      };
    }
  }

  async getLastRun(request: SupportGetLastRunRequest): Promise<SupportGetLastRunOutcome> {
    if (!this.isExpectedConfiguration(request.configurationId)) {
      return operationRejected();
    }
    try {
      const run = await this.deps.journal.getLastRun(request.configurationId);
      return { status: 'available', ...(run ? { run } : {}) };
    } catch {
      return operationRejected();
    }
  }

  private isExpectedConfiguration(configurationId: ConfigurationId): boolean {
    return configurationId === this.deps.configurationId;
  }
}

function filterMasterObjects(
  master: Extract<MasterSupportState, { readonly kind: 'ready' }>,
  objectIds: readonly string[] | undefined,
): Extract<MasterSupportState, { readonly kind: 'ready' }> {
  if (objectIds === undefined) {
    return master;
  }
  const requested = new Set(objectIds.map((objectId) => objectId.toLocaleLowerCase()));
  return {
    kind: 'ready',
    snapshot: {
      ...master.snapshot,
      objectModes: new Map(
        [...master.snapshot.objectModes].filter(([objectId]) => requested.has(objectId.toLocaleLowerCase())),
      ),
    },
  };
}

function rejectMasterForSync(
  master: Exclude<MasterSupportState, { readonly kind: 'ready' }>,
): Extract<SupportSyncOperationOutcome, { readonly status: 'masterRejected' }> {
  return rejectMaster(master);
}

function rejectMasterForVerify(
  master: Exclude<MasterSupportState, { readonly kind: 'ready' }>,
): Extract<SupportVerifyOperationOutcome, { readonly status: 'masterRejected' }> {
  return rejectMaster(master);
}

function rejectMaster(
  master: Exclude<MasterSupportState, { readonly kind: 'ready' }>,
): Extract<SupportSyncOperationOutcome, { readonly status: 'masterRejected' }> {
  if (master.kind === 'unmanaged') {
    return master.reason === 'missing'
      ? { status: 'masterRejected', master, errorCode: 'SUPPORT_FILE_MISSING' }
      : { status: 'masterRejected', master, errorCode: 'SUPPORT_NOT_MANAGED' };
  }
  switch (master.errorCode) {
    case 'SUPPORT_FILE_INVALID':
      return {
        status: 'masterRejected',
        master: { ...master, errorCode: 'SUPPORT_FILE_INVALID' },
        errorCode: 'SUPPORT_FILE_INVALID',
      };
    case 'SUPPORT_FORMAT_UNSUPPORTED':
      return {
        status: 'masterRejected',
        master: { ...master, errorCode: 'SUPPORT_FORMAT_UNSUPPORTED' },
        errorCode: 'SUPPORT_FORMAT_UNSUPPORTED',
      };
    case 'SUPPORT_MASTER_RECOVERY_REQUIRED':
      return {
        status: 'masterRejected',
        master: { ...master, errorCode: 'SUPPORT_MASTER_RECOVERY_REQUIRED' },
        errorCode: 'SUPPORT_MASTER_RECOVERY_REQUIRED',
      };
  }
}

function operationRejected(): SupportOperationRejectedOutcome {
  return {
    status: 'operationRejected',
    errorCode: 'SUPPORT_OPERATION_FAILED',
    retryable: true,
  };
}

function isFullySynchronized(run: SupportSyncRunSummary): boolean {
  return run.state === 'complete'
    && (
      run.scope === 'masterOnly'
      || run.targets.every((target) => target.state === 'applied' || target.state === 'verified')
    );
}

function isFullyVerified(run: SupportVerifyRunSummary): boolean {
  return run.state === 'complete'
    && (
      run.scope === 'masterOnly'
      || run.targets.every((target) => target.state === 'verified')
    );
}
