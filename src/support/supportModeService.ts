import * as path from 'path';
import type { ConfigurationId } from '../services/configurationSession/types';
import type { ParsedParentConfigurations } from './parentConfigurationsCodec';
import { ParentConfigurationsCodec } from './parentConfigurationsCodec';
import type { MetadataUniverseResolver } from './metadataUniverseResolver';
import type {
  EnableObjectRulesRequest,
  MasterSupportSnapshot,
  MasterSupportState,
  MetadataUniverseSnapshot,
  SupportCancellation,
  SupportModeMutationOutcome,
  SupportMutationRequest,
  SupportMutationResult,
  SupportOperationRejectedOutcome,
  SupportPreflightResult,
  SupportSyncRunSummary,
} from './supportTypes';
import { SupportMutationError } from './supportTypes';
import type {
  CoordinatorPreflightResult,
  SupportSyncCoordinator,
} from './supportSyncCoordinator';

const SUPPORT_RESOURCE_PATH = path.join('Ext', 'ParentConfigurations.bin');
const NEVER_CANCELLED: SupportCancellation = Object.freeze({
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
});

type RunExclusiveConfigurationOperation = <T>(
  resourcePath: string,
  kind: string,
  operation: () => Promise<T>,
) => Promise<T>;

export interface SupportModeServiceDeps {
  readonly configurationId: ConfigurationId;
  readonly configRoot: string;
  readonly store: {
    read(configRoot: string): Promise<MasterSupportState>;
    readParsedWithinExclusiveLease(configRoot: string): Promise<ParsedParentConfigurations>;
    commitWithinExclusiveLease(
      plan: ReturnType<typeof ParentConfigurationsCodec.planObjectMode>,
      expectedGenerationId: string,
    ): Promise<SupportMutationResult>;
  };
  readonly universeResolver: Pick<MetadataUniverseResolver, 'resolve'>;
  /**
   * Full all-target gate: binding membership, canonical target support, executable and credentials.
   * The same function should back SupportSyncCoordinator's preflight dependency.
   */
  readonly preflight: (snapshot: MasterSupportSnapshot) => Promise<CoordinatorPreflightResult>;
  readonly coordinator: Pick<SupportSyncCoordinator, 'sync'>;
  readonly runExclusiveConfigurationOperation: RunExclusiveConfigurationOperation;
  readonly cancellation?: SupportCancellation;
}

export interface SupportModeStatus {
  readonly status: 'available';
  readonly master: MasterSupportState;
  readonly metadataUniverse: MetadataUniverseSnapshot;
}

export type SupportModeStatusOutcome = SupportModeStatus | SupportOperationRejectedOutcome;

type MutationPlanFactory = (
  document: ParsedParentConfigurations,
) => Promise<ReturnType<typeof ParentConfigurationsCodec.planObjectMode>>;

/** Local source-of-truth mutation plus post-lease replica fan-out. */
export class SupportModeService {
  private readonly configRoot: string;
  private readonly supportResourcePath: string;
  private readonly cancellation: SupportCancellation;

  constructor(private readonly deps: SupportModeServiceDeps) {
    this.configRoot = path.resolve(deps.configRoot);
    this.supportResourcePath = path.join(this.configRoot, SUPPORT_RESOURCE_PATH);
    this.cancellation = deps.cancellation ?? NEVER_CANCELLED;
  }

  async getStatus(): Promise<SupportModeStatusOutcome> {
    try {
      const [master, universe] = await Promise.all([
        this.deps.store.read(this.configRoot),
        this.deps.universeResolver.resolve(this.configRoot),
      ]);
      return {
        status: 'available',
        master,
        metadataUniverse: freezeUniverse(universe),
      };
    } catch {
      return operationRejected();
    }
  }

  setObjectMode(request: SupportMutationRequest): Promise<SupportModeMutationOutcome> {
    return this.mutate(
      request.configurationId,
      request.expectedGenerationId,
      async (document) => ParentConfigurationsCodec.planObjectMode(document, request),
    );
  }

  enableObjectRules(request: EnableObjectRulesRequest): Promise<SupportModeMutationOutcome> {
    return this.mutate(
      request.configurationId,
      request.expectedGenerationId,
      async (document) => {
        if (document.state.kind !== 'ready' || document.state.snapshot.formatRevision !== '6') {
          throw new SupportMutationError(
            'SUPPORT_EFFECTIVE_DIFF_VIOLATION',
            'Only ParentConfigurations revision 6 is certified for global object-rule transition.',
          );
        }
        const universe = await this.deps.universeResolver.resolve(this.configRoot);
        return ParentConfigurationsCodec.planEnableObjectRules(document, request, universe);
      },
    );
  }

  private async mutate(
    configurationId: ConfigurationId,
    expectedGenerationId: string,
    createPlan: MutationPlanFactory,
  ): Promise<SupportModeMutationOutcome> {
    let initialMaster: MasterSupportState;
    try {
      initialMaster = await this.deps.store.read(this.configRoot);
    } catch {
      return operationRejected();
    }
    if (initialMaster.kind !== 'ready') {
      return rejectMaster(initialMaster);
    }
    if (configurationId !== this.deps.configurationId) {
      return operationRejected();
    }

    let preflight: CoordinatorPreflightResult;
    try {
      preflight = await this.deps.preflight(initialMaster.snapshot);
    } catch {
      return operationRejected();
    }
    if (!preflight.accepted) {
      return {
        status: 'preflightRejected',
        master: initialMaster.snapshot,
        preflight: publicRejectedPreflight(preflight),
      };
    }
    const publicPreflight = publicAcceptedPreflight(preflight);

    let mutation: SupportMutationResult;
    let plannedMutation: SupportMutationResult | undefined;
    try {
      mutation = await this.deps.runExclusiveConfigurationOperation(
        this.supportResourcePath,
        'support.mutateMode',
        async () => {
          const document = await this.deps.store.readParsedWithinExclusiveLease(this.configRoot);
          if (
            document.state.kind !== 'ready'
            || document.state.snapshot.configurationId !== configurationId
            || document.state.snapshot.generationId !== expectedGenerationId
          ) {
            throw new SupportMutationError(
              'SUPPORT_STALE_GENERATION',
              'Support master changed before the exclusive mutation started.',
            );
          }
          const plan = await createPlan(document);
          plannedMutation = {
            before: plan.before,
            after: plan.after,
            changedTokenCount: plan.patches.length,
          };
          return this.deps.store.commitWithinExclusiveLease(plan, expectedGenerationId);
        },
      );
    } catch (error) {
      let currentMaster: MasterSupportState;
      try {
        currentMaster = await this.deps.store.read(this.configRoot);
      } catch {
        return operationRejected();
      }
      if (currentMaster.kind !== 'ready') {
        return rejectMaster(currentMaster);
      }
      if (
        plannedMutation
        && currentMaster.snapshot.generationId === plannedMutation.after.generationId
      ) {
        return replicationIssue(
          publicPreflight,
          {
            ...plannedMutation,
            after: currentMaster.snapshot,
          },
          'SUPPORT_REPLICATION_FAILED',
        );
      }
      if (error instanceof SupportMutationError) {
        return {
          status: 'mutationRejected',
          master: currentMaster.snapshot,
          preflight: publicPreflight,
          errorCode: error.code,
        };
      }
      return operationRejected();
    }

    let sync;
    try {
      sync = await this.deps.coordinator.sync({
        snapshot: mutation.after,
        verification: 'fast',
        targets: { kind: 'all' },
        cancellation: this.cancellation,
      });
    } catch {
      return replicationIssue(
        publicPreflight,
        mutation,
        'SUPPORT_REPLICATION_FAILED',
      );
    }
    if (sync.status !== 'completed') {
      return replicationIssue(
        publicPreflight,
        mutation,
        sync.status === 'preflightRejected'
          ? 'SUPPORT_REPLICATION_PREFLIGHT_DRIFT'
          : 'SUPPORT_REPLICATION_FAILED',
      );
    }
    if (!isFullySynchronized(sync.run)) {
      return replicationIssue(
        publicPreflight,
        mutation,
        'SUPPORT_REPLICATION_INCOMPLETE',
        sync.run,
      );
    }
    if (publicPreflight.scope === 'masterOnly' && sync.run.scope === 'masterOnly') {
      return {
        status: 'synchronized',
        preflight: publicPreflight,
        mutation,
        desiredGenerationId: mutation.after.generationId,
        run: sync.run as typeof sync.run & { readonly state: 'complete' },
      };
    }
    if (publicPreflight.scope === 'replicated' && sync.run.scope === 'replicated') {
      return {
        status: 'synchronized',
        preflight: publicPreflight,
        mutation,
        desiredGenerationId: mutation.after.generationId,
        run: sync.run as typeof sync.run & { readonly state: 'complete' },
      };
    }
    return replicationIssue(
      publicPreflight,
      mutation,
      'SUPPORT_REPLICATION_PREFLIGHT_DRIFT',
      sync.run,
    );
  }
}

function operationRejected(): SupportOperationRejectedOutcome {
  return {
    status: 'operationRejected',
    errorCode: 'SUPPORT_OPERATION_FAILED',
    retryable: true,
  };
}

function replicationIssue(
  preflight: Extract<SupportPreflightResult, { readonly accepted: true }>,
  mutation: SupportMutationResult,
  errorCode:
    | 'SUPPORT_REPLICATION_FAILED'
    | 'SUPPORT_REPLICATION_INCOMPLETE'
    | 'SUPPORT_REPLICATION_PREFLIGHT_DRIFT',
  run?: SupportSyncRunSummary,
): Extract<SupportModeMutationOutcome, { readonly status: 'committedWithReplicationIssue' }> {
  return {
    status: 'committedWithReplicationIssue',
    preflight,
    mutation,
    desiredGenerationId: mutation.after.generationId,
    errorCode,
    retryable: true,
    retryOperation: 'sync',
    ...(run ? { run } : {}),
  };
}

function isFullySynchronized(run: SupportSyncRunSummary): boolean {
  return run.state === 'complete'
    && (
      run.scope === 'masterOnly'
      || run.targets.every((target) => target.state === 'applied' || target.state === 'verified')
    );
}

function freezeUniverse(universe: MetadataUniverseSnapshot): MetadataUniverseSnapshot {
  return Object.freeze({
    configRoot: universe.configRoot,
    metadataUniverseGenerationId: universe.metadataUniverseGenerationId,
    entries: Object.freeze(universe.entries.map((entry) => Object.freeze({ ...entry }))),
  });
}

function rejectMaster(
  master: Exclude<MasterSupportState, { readonly kind: 'ready' }>,
): Extract<SupportModeMutationOutcome, { readonly status: 'masterRejected' }> {
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

function publicAcceptedPreflight(
  preflight: Extract<CoordinatorPreflightResult, { readonly accepted: true }>,
): Extract<SupportPreflightResult, { readonly accepted: true }> {
  return preflight.scope === 'masterOnly'
    ? { accepted: true, scope: 'masterOnly', targets: [] }
    : publicReplicatedPreflight(preflight);
}

function publicRejectedPreflight(
  preflight: Extract<CoordinatorPreflightResult, { readonly accepted: false }>,
): Extract<SupportPreflightResult, { readonly accepted: false }> {
  if (preflight.reason === 'bindingInvalid') {
    return { ...preflight, diagnostics: [...preflight.diagnostics] };
  }
  const [firstUnsupported, ...remainingUnsupported] = preflight.unsupportedTargets;
  const toUnsupported = (target: typeof firstUnsupported) => ({
    canonicalTargetId: target.canonicalTargetId,
    infobaseIds: [...target.infobaseIds],
    state: 'targetUnsupported' as const,
    errorCode: target.errorCode,
  });
  return {
    accepted: false,
    reason: 'targetUnsupported',
    errorCode: 'SUPPORT_TARGET_UNSUPPORTED',
    readyTargets: preflight.readyTargets.map((target) => ({
      canonicalTargetId: target.canonicalTargetId,
      infobaseIds: [...target.infobaseIds],
      state: 'ready',
    })),
    unsupportedTargets: [
      toUnsupported(firstUnsupported),
      ...remainingUnsupported.map(toUnsupported),
    ],
  };
}

function publicReplicatedPreflight(
  preflight: Extract<
    CoordinatorPreflightResult,
    { readonly accepted: true; readonly scope: 'replicated' }
  >,
): Extract<
  SupportPreflightResult,
  { readonly accepted: true; readonly scope: 'replicated' }
> {
  const [firstTarget, ...remainingTargets] = preflight.targets;
  const toReady = (target: typeof firstTarget) => ({
    canonicalTargetId: target.canonicalTargetId,
    infobaseIds: [...target.infobaseIds],
    state: 'ready' as const,
  });
  return {
    accepted: true,
    scope: 'replicated',
    targets: [toReady(firstTarget), ...remainingTargets.map(toReady)],
  };
}
