import { randomUUID } from 'crypto';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';
import type { ConfigurationId } from '../services/configurationSession/types';
import { SupportRunJournal, SupportRunJournalError } from './supportRunJournal';
import type {
  MasterSupportSnapshot,
  PreparedTargetSupportPayload,
  ReadySupportTarget,
  SupportApplicator,
  SupportApplyOutcome,
  SupportCancellation,
  SupportPreflightResult,
  SupportSyncOutcome,
  SupportSyncRequest,
  SupportSyncRunSummary,
  SupportTargetCapability,
  SupportTargetSelectionRejectedOutcome,
  SupportVerifyOutcome,
  SupportVerifyRequest,
  SupportVerifyRunOutcome,
  SupportVerifyRunSummary,
  TargetGenerationRef,
  TargetSelection,
  TargetSupportSyncResult,
  TargetSupportSyncState,
  TargetSupportVerifyResult,
  UnsupportedSupportTarget,
} from './supportTypes';

const NEVER_CANCELLED: SupportCancellation = Object.freeze({
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
});

export interface CoordinatorReadySupportTarget extends ReadySupportTarget {
  readonly entry: InfobaseEntry;
}

export type CoordinatorPreflightResult =
  | Extract<SupportPreflightResult, { readonly accepted: false }>
  | Extract<SupportPreflightResult, { readonly accepted: true; readonly scope: 'masterOnly' }>
  | {
      readonly accepted: true;
      readonly scope: 'replicated';
      readonly targets: readonly [CoordinatorReadySupportTarget, ...CoordinatorReadySupportTarget[]];
    };

export interface SupportSyncCoordinatorDeps {
  readonly applicator: SupportApplicator;
  readonly journal: SupportRunJournal;
  readonly preflight: (snapshot: MasterSupportSnapshot) => Promise<CoordinatorPreflightResult>;
  readonly getCurrentGenerationId: (configurationId: ConfigurationId) => Promise<string>;
  readonly runTargetExclusive: <T>(
    target: CoordinatorReadySupportTarget,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly now?: () => string;
  readonly createRunId?: () => string;
}

export class SupportSyncCoordinator {
  private readonly now: () => string;
  private readonly createRunId: () => string;

  constructor(private readonly deps: SupportSyncCoordinatorDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.createRunId = deps.createRunId ?? randomUUID;
  }

  async sync(request: SupportSyncRequest): Promise<SupportSyncOutcome> {
    const preflight = await this.preflightWithCapabilities(request.snapshot);
    if (!preflight.accepted) {
      return { status: 'preflightRejected', master: request.snapshot, preflight };
    }
    const lastRun = await this.deps.journal.getLastRun(request.snapshot.configurationId);
    const selection = selectTargets(
      preflight.scope === 'replicated' ? preflight.targets : [],
      request.targets,
      lastRun?.targets ?? [],
      request.snapshot.generationId,
    );
    if (!selection.accepted) {
      return targetSelectionRejected(request.snapshot, selection);
    }
    const targets = selection.targets;
    const runId = this.createRunId();
    if (preflight.scope === 'masterOnly') {
      const run: Extract<SupportSyncRunSummary, { readonly scope: 'masterOnly' }> = {
        runId,
        configurationId: request.snapshot.configurationId,
        desiredGenerationId: request.snapshot.generationId,
        operation: 'sync',
        scope: 'masterOnly',
        targets: [],
        state: 'complete',
      };
      await this.deps.journal.complete(run);
      return { status: 'completed', master: request.snapshot, preflight, run };
    }

    const refs = targets.map((target) => targetRef(target, request.snapshot.generationId));
    await this.deps.journal.begin({
      runId,
      configurationId: request.snapshot.configurationId,
      desiredGenerationId: request.snapshot.generationId,
      operation: 'sync',
    }, refs);

    const results: TargetSupportSyncResult[] = [];
    let supersededByGenerationId: string | undefined;
    let cancelled = false;
    for (let index = 0; index < targets.length; index += 1) {
      if (request.cancellation?.isCancellationRequested) {
        cancelled = true;
        await this.skipRemaining(runId, request.snapshot.configurationId, refs, results, index, 'cancelled');
        break;
      }
      const target = targets[index]!;
      const prior = findPriorTarget(lastRun?.targets ?? [], target.canonicalTargetId, request.snapshot.generationId);
      let result: TargetSupportSyncResult;
      let resultIndex: number | undefined;
      let stopAfterTarget = false;
      try {
        const currentGenerationId = await this.deps.getCurrentGenerationId(request.snapshot.configurationId);
        if (currentGenerationId !== request.snapshot.generationId) {
          supersededByGenerationId = currentGenerationId;
          await this.obsoleteRemaining(runId, request.snapshot.configurationId, refs, results, index);
          break;
        }
        result = await this.deps.runTargetExclusive(
          target,
          () => prior?.state === 'inDoubt'
            ? this.reconcileTarget(
                runId,
                target,
                request.snapshot,
                request.cancellation ?? NEVER_CANCELLED,
              )
            : this.syncTarget(runId, target, request),
        );
        resultIndex = results.length;
        results.push(result);
        const postTargetGenerationId = await this.deps.getCurrentGenerationId(
          request.snapshot.configurationId,
        );
        if (
          postTargetGenerationId !== request.snapshot.generationId
          && (
            index + 1 < targets.length
            || results.some((targetResult) =>
              targetResult.state === 'applied' || targetResult.state === 'verified')
            || (
              result.state === 'stale'
              && result.reason === 'masterAdvanced'
            )
          )
        ) {
          await this.obsoleteRemaining(
            runId,
            request.snapshot.configurationId,
            refs,
            results,
            index + 1,
          );
          supersededByGenerationId = postTargetGenerationId;
          stopAfterTarget = true;
        }
      } catch {
        result = await this.terminalFromException(
          request.snapshot.configurationId,
          runId,
          refs[index]!,
          prior?.state === 'inDoubt',
          'sync',
        );
        if (resultIndex === undefined) {
          results.push(result);
        } else {
          results[resultIndex] = result;
        }
      }
      if (stopAfterTarget) {
        break;
      }
      if (
        request.cancellation?.isCancellationRequested
        && (index + 1 < targets.length || isCancellationTerminal(result))
      ) {
        cancelled = true;
        await this.skipRemaining(
          runId,
          request.snapshot.configurationId,
          refs,
          results,
          index + 1,
          'cancelled',
        );
        break;
      }
    }

    const run = createSyncSummary(
      runId,
      request.snapshot,
      results,
      cancelled,
      supersededByGenerationId,
    );
    await this.deps.journal.complete(run);
    return {
      status: 'completed',
      master: request.snapshot,
      preflight: asPublicReplicatedPreflight(preflight),
      run,
    };
  }

  /**
   * Read-only by construction: this method and every helper reachable from it only call
   * `SupportApplicator.verify`; `prepare` and `apply` are not referenced.
   */
  async verifyOnly(request: SupportVerifyRequest): Promise<SupportVerifyRunOutcome> {
    const preflight = await this.preflightWithCapabilities(request.snapshot);
    if (!preflight.accepted) {
      return { status: 'preflightRejected', master: request.snapshot, preflight };
    }
    const lastRun = await this.deps.journal.getLastRun(request.snapshot.configurationId);
    const selection = selectTargets(
      preflight.scope === 'replicated' ? preflight.targets : [],
      request.targets,
      lastRun?.targets ?? [],
      request.snapshot.generationId,
    );
    if (!selection.accepted) {
      return targetSelectionRejected(request.snapshot, selection);
    }
    const targets = selection.targets;
    const runId = this.createRunId();
    if (preflight.scope === 'masterOnly') {
      const run: Extract<SupportVerifyRunSummary, { readonly scope: 'masterOnly' }> = {
        runId,
        configurationId: request.snapshot.configurationId,
        desiredGenerationId: request.snapshot.generationId,
        operation: 'verify',
        scope: 'masterOnly',
        targets: [],
        state: 'complete',
      };
      await this.deps.journal.complete(run);
      return { status: 'completed', master: request.snapshot, preflight, run };
    }

    const refs = targets.map((target) => targetRef(target, request.snapshot.generationId));
    await this.deps.journal.begin({
      runId,
      configurationId: request.snapshot.configurationId,
      desiredGenerationId: request.snapshot.generationId,
      operation: 'verify',
    }, refs);

    const results: TargetSupportVerifyResult[] = [];
    let supersededByGenerationId: string | undefined;
    let cancelled = false;
    for (let index = 0; index < targets.length; index += 1) {
      if (request.cancellation?.isCancellationRequested) {
        cancelled = true;
        await this.skipRemaining(runId, request.snapshot.configurationId, refs, results, index, 'cancelled');
        break;
      }
      const target = targets[index]!;
      const prior = findPriorTarget(lastRun?.targets ?? [], target.canonicalTargetId, request.snapshot.generationId);
      let result: TargetSupportVerifyResult;
      let resultIndex: number | undefined;
      let stopAfterTarget = false;
      try {
        const currentGenerationId = await this.deps.getCurrentGenerationId(request.snapshot.configurationId);
        if (currentGenerationId !== request.snapshot.generationId) {
          supersededByGenerationId = currentGenerationId;
          await this.obsoleteRemaining(runId, request.snapshot.configurationId, refs, results, index);
          break;
        }
        result = await this.deps.runTargetExclusive(
          target,
          () => this.verifyTargetReadOnly(
            runId,
            target,
            request.snapshot,
            prior?.state === 'inDoubt',
            request.cancellation ?? NEVER_CANCELLED,
          ),
        );
        resultIndex = results.length;
        results.push(result);
        const postTargetGenerationId = await this.deps.getCurrentGenerationId(
          request.snapshot.configurationId,
        );
        if (
          postTargetGenerationId !== request.snapshot.generationId
          && (
            index + 1 < targets.length
            || results.some((targetResult) => targetResult.state === 'verified')
          )
        ) {
          await this.obsoleteRemaining(
            runId,
            request.snapshot.configurationId,
            refs,
            results,
            index + 1,
          );
          supersededByGenerationId = postTargetGenerationId;
          stopAfterTarget = true;
        }
      } catch {
        result = await this.terminalFromException(
          request.snapshot.configurationId,
          runId,
          refs[index]!,
          prior?.state === 'inDoubt',
          'verify',
        ) as TargetSupportVerifyResult;
        if (resultIndex === undefined) {
          results.push(result);
        } else {
          results[resultIndex] = result;
        }
      }
      if (stopAfterTarget) {
        break;
      }
      if (
        request.cancellation?.isCancellationRequested
        && (index + 1 < targets.length || isCancellationTerminal(result))
      ) {
        cancelled = true;
        await this.skipRemaining(
          runId,
          request.snapshot.configurationId,
          refs,
          results,
          index + 1,
          'cancelled',
        );
        break;
      }
    }

    const run = createVerifySummary(
      runId,
      request.snapshot,
      results,
      cancelled,
      supersededByGenerationId,
    );
    await this.deps.journal.complete(run);
    return {
      status: 'completed',
      master: request.snapshot,
      preflight: asPublicReplicatedPreflight(preflight),
      run,
    };
  }

  private async syncTarget(
    runId: string,
    target: CoordinatorReadySupportTarget,
    request: SupportSyncRequest,
  ): Promise<TargetSupportSyncResult> {
    const ref = targetRef(target, request.snapshot.generationId);
    await this.record(request.snapshot.configurationId, runId, {
      ...ref,
      state: 'preparing',
      startedAt: this.now(),
    });
    const prepared = await this.deps.applicator.prepare(
      target.entry,
      request.snapshot,
      request.cancellation ?? NEVER_CANCELLED,
    );
    switch (prepared.status) {
      case 'alreadyAcknowledged':
        if (prepared.acknowledgedGenerationId !== request.snapshot.generationId) {
          return this.finish(request.snapshot.configurationId, runId, {
            ...ref,
            state: 'failed',
            stage: 'prepare',
            errorCode: 'SUPPORT_ACKNOWLEDGED_GENERATION_MISMATCH',
            retryable: false,
          });
        }
        if (request.verification === 'fast') {
          return this.finish(request.snapshot.configurationId, runId, {
            ...ref,
            state: 'applied',
            acknowledgedGenerationId: prepared.acknowledgedGenerationId,
            evidence: 'cachedConfiguratorAck',
          });
        }
        return this.verifyAfterAcknowledgement(
          runId,
          target,
          request.snapshot,
          request.cancellation ?? NEVER_CANCELLED,
        );
      case 'matched':
        return this.finish(request.snapshot.configurationId, runId, {
          ...ref,
          state: prepared.verifiedGenerationId === request.snapshot.generationId ? 'verified' : 'stale',
          ...(prepared.verifiedGenerationId === request.snapshot.generationId
            ? { verifiedGenerationId: prepared.verifiedGenerationId, evidence: 'semanticDump' as const }
            : { reason: 'targetDrift' as const }),
        } as TargetSupportSyncResult);
      case 'stale':
        return this.finish(request.snapshot.configurationId, runId, {
          ...ref,
          state: 'stale',
          reason: 'targetDrift',
        });
      case 'failed':
        return this.finish(request.snapshot.configurationId, runId, {
          ...ref,
          state: 'failed',
          stage: 'prepare',
          errorCode: prepared.errorCode,
          retryable: prepared.retryable,
        });
      case 'prepared':
        return this.applyPrepared(
          runId,
          target,
          request.snapshot,
          prepared.payload,
          request.verification,
          false,
          request.cancellation ?? NEVER_CANCELLED,
        );
    }
  }

  private async applyPrepared(
    runId: string,
    target: CoordinatorReadySupportTarget,
    snapshot: MasterSupportSnapshot,
    payload: PreparedTargetSupportPayload,
    verification: 'fast' | 'strict',
    fromReconcile: boolean,
    cancellation: SupportCancellation,
  ): Promise<TargetSupportSyncResult> {
    const ref = targetRef(target, snapshot.generationId);
    const outcome = await this.deps.applicator.apply(
      target.entry,
      snapshot,
      payload,
      cancellation,
      async () => {
        await this.record(snapshot.configurationId, runId, {
          ...ref,
          state: 'applying',
          startedAt: this.now(),
        });
        const generationImmediatelyBeforeApply = await this.deps.getCurrentGenerationId(
          snapshot.configurationId,
        );
        return generationImmediatelyBeforeApply === snapshot.generationId;
      },
    );
    const terminal = await this.mapApplyOutcome(runId, target, snapshot, outcome);
    if (
      terminal.state === 'applied'
      && verification === 'strict'
      && !fromReconcile
    ) {
      return this.verifyAfterAcknowledgement(runId, target, snapshot, cancellation);
    }
    return terminal;
  }

  private async mapApplyOutcome(
    runId: string,
    target: CoordinatorReadySupportTarget,
    snapshot: MasterSupportSnapshot,
    outcome: SupportApplyOutcome,
  ): Promise<TargetSupportSyncResult> {
    const ref = targetRef(target, snapshot.generationId);
    switch (outcome.status) {
      case 'acknowledged':
        return this.finish(snapshot.configurationId, runId, outcome.acknowledgedGenerationId === snapshot.generationId
          ? {
              ...ref,
              state: 'applied',
              acknowledgedGenerationId: outcome.acknowledgedGenerationId,
              evidence: 'configuratorAck',
            }
          : {
              ...ref,
              state: 'failed',
              stage: 'apply',
              errorCode: 'SUPPORT_ACKNOWLEDGED_GENERATION_MISMATCH',
              retryable: false,
            });
      case 'stale':
        return this.finish(snapshot.configurationId, runId, {
          ...ref,
          state: 'stale',
          reason: outcome.reason,
        });
      case 'failed':
        return this.finish(snapshot.configurationId, runId, {
          ...ref,
          state: 'failed',
          stage: 'apply',
          errorCode: outcome.errorCode,
          retryable: outcome.retryable,
        });
      case 'inDoubt':
        return this.finish(snapshot.configurationId, runId, {
          ...ref,
          state: 'inDoubt',
          stage: 'apply',
          errorCode: outcome.errorCode,
        });
    }
  }

  private async verifyAfterAcknowledgement(
    runId: string,
    target: CoordinatorReadySupportTarget,
    snapshot: MasterSupportSnapshot,
    cancellation: SupportCancellation,
  ): Promise<TargetSupportSyncResult> {
    const currentGenerationId = await this.deps.getCurrentGenerationId(snapshot.configurationId);
    if (currentGenerationId !== snapshot.generationId) {
      return this.finish(snapshot.configurationId, runId, {
        ...targetRef(target, snapshot.generationId),
        state: 'stale',
        reason: 'masterAdvanced',
        lastAppliedGenerationId: snapshot.generationId,
      });
    }
    return this.verifyTarget(runId, target, snapshot, false, cancellation);
  }

  private async reconcileTarget(
    runId: string,
    target: CoordinatorReadySupportTarget,
    snapshot: MasterSupportSnapshot,
    cancellation: SupportCancellation,
  ): Promise<TargetSupportSyncResult> {
    const ref = targetRef(target, snapshot.generationId);
    await this.record(snapshot.configurationId, runId, {
      ...ref,
      state: 'reconciling',
      startedAt: this.now(),
    });
    const outcome = await this.deps.applicator.verify(target.entry, snapshot, cancellation);
    if (outcome.status === 'failed') {
      return this.finish(snapshot.configurationId, runId, {
        ...ref,
        state: 'inDoubt',
        stage: 'reconcile',
        errorCode: outcome.errorCode,
      });
    }
    if (outcome.status === 'matched') {
      return this.finish(snapshot.configurationId, runId, outcome.verifiedGenerationId === snapshot.generationId
        ? {
            ...ref,
            state: 'verified',
            verifiedGenerationId: outcome.verifiedGenerationId,
            evidence: 'semanticDump',
          }
        : {
            ...ref,
            state: 'stale',
            reason: 'targetDrift',
          });
    }
    const currentGenerationId = await this.deps.getCurrentGenerationId(snapshot.configurationId);
    if (currentGenerationId !== snapshot.generationId) {
      return this.finish(snapshot.configurationId, runId, {
        ...ref,
        state: 'stale',
        reason: 'masterAdvanced',
        ...(outcome.lastAppliedGenerationId
          ? { lastAppliedGenerationId: outcome.lastAppliedGenerationId }
          : {}),
      });
    }
    // The immutable payload is the evidence from this reconcile dump. It is applied directly:
    // no second prepare/dump, including under the strict profile.
    return this.applyPrepared(runId, target, snapshot, outcome.payload, 'fast', true, cancellation);
  }

  private async verifyTarget(
    runId: string,
    target: CoordinatorReadySupportTarget,
    snapshot: MasterSupportSnapshot,
    priorWasInDoubt: boolean,
    cancellation: SupportCancellation,
  ): Promise<TargetSupportSyncResult> {
    const ref = targetRef(target, snapshot.generationId);
    await this.record(snapshot.configurationId, runId, priorWasInDoubt
      ? { ...ref, state: 'reconciling', startedAt: this.now() }
      : { ...ref, state: 'verifying', startedAt: this.now() });
    const outcome = await this.deps.applicator.verify(target.entry, snapshot, cancellation);
    return this.mapVerifyOutcome(snapshot.configurationId, runId, ref, outcome, priorWasInDoubt);
  }

  private async verifyTargetReadOnly(
    runId: string,
    target: CoordinatorReadySupportTarget,
    snapshot: MasterSupportSnapshot,
    priorWasInDoubt: boolean,
    cancellation: SupportCancellation,
  ): Promise<TargetSupportVerifyResult> {
    return this.verifyTarget(
      runId,
      target,
      snapshot,
      priorWasInDoubt,
      cancellation,
    ) as Promise<TargetSupportVerifyResult>;
  }

  private async mapVerifyOutcome(
    configurationId: ConfigurationId,
    runId: string,
    ref: TargetGenerationRef,
    outcome: SupportVerifyOutcome,
    priorWasInDoubt: boolean,
  ): Promise<TargetSupportSyncResult> {
    switch (outcome.status) {
      case 'matched':
        return this.finish(configurationId, runId, outcome.verifiedGenerationId === ref.desiredGenerationId
          ? {
              ...ref,
              state: 'verified',
              verifiedGenerationId: outcome.verifiedGenerationId,
              evidence: 'semanticDump',
            }
          : {
              ...ref,
              state: 'stale',
              reason: 'targetDrift',
            });
      case 'mismatch':
        return this.finish(configurationId, runId, {
          ...ref,
          state: 'stale',
          reason: 'targetDrift',
          ...(outcome.lastAppliedGenerationId
            ? { lastAppliedGenerationId: outcome.lastAppliedGenerationId }
            : {}),
        });
      case 'failed':
        return this.finish(configurationId, runId, priorWasInDoubt
          ? { ...ref, state: 'inDoubt', stage: 'reconcile', errorCode: outcome.errorCode }
          : {
              ...ref,
              state: 'failed',
              stage: 'verify',
              errorCode: outcome.errorCode,
              retryable: true,
            });
    }
  }

  private async preflightWithCapabilities(
    snapshot: MasterSupportSnapshot,
  ): Promise<CoordinatorPreflightResult> {
    const preflight = await this.deps.preflight(snapshot);
    if (!preflight.accepted || preflight.scope === 'masterOnly') {
      return preflight;
    }
    const readyTargets: CoordinatorReadySupportTarget[] = [];
    const unsupportedTargets: UnsupportedSupportTarget[] = [];
    for (const target of preflight.targets) {
      let capability: SupportTargetCapability;
      try {
        capability = await this.deps.applicator.probe(target.entry, snapshot);
      } catch {
        capability = { supported: false, errorCode: 'SUPPORT_TARGET_PROBE_FAILED' };
      }
      if (
        capability.supported
        && capability.canonicalTargetId === target.canonicalTargetId
      ) {
        readyTargets.push(target);
      } else {
        unsupportedTargets.push({
          canonicalTargetId: target.canonicalTargetId,
          infobaseIds: [...target.infobaseIds],
          state: 'targetUnsupported',
          errorCode: capability.supported
            ? 'SUPPORT_TARGET_UNSUPPORTED'
            : capability.errorCode,
        });
      }
    }
    if (unsupportedTargets.length > 0) {
      return {
        accepted: false,
        reason: 'targetUnsupported',
        errorCode: 'SUPPORT_TARGET_UNSUPPORTED',
        readyTargets,
        unsupportedTargets: unsupportedTargets as [UnsupportedSupportTarget, ...UnsupportedSupportTarget[]],
      };
    }
    return {
      accepted: true,
      scope: 'replicated',
      targets: readyTargets as [CoordinatorReadySupportTarget, ...CoordinatorReadySupportTarget[]],
    };
  }

  private async terminalFromException(
    configurationId: ConfigurationId,
    runId: string,
    ref: TargetGenerationRef,
    priorWasInDoubt: boolean,
    operation: 'sync' | 'verify',
  ): Promise<TargetSupportSyncResult> {
    let current: TargetSupportSyncState | undefined;
    try {
      current = (await this.deps.journal.getActiveRun(configurationId))
        ?.targets.find((target) => target.canonicalTargetId === ref.canonicalTargetId);
    } catch {
      // The durable completion is still attempted below with a conservative terminal state.
    }
    if (
      current
      && (
        current.state === 'applied'
        || current.state === 'verified'
        || current.state === 'stale'
        || current.state === 'failed'
        || current.state === 'inDoubt'
        || current.state === 'skipped'
      )
    ) {
      return current;
    }

    let terminal: TargetSupportSyncResult;
    if (current?.state === 'applying') {
      terminal = {
        ...ref,
        state: 'inDoubt',
        stage: 'apply',
        errorCode: 'SUPPORT_APPLY_FAILED',
      };
    } else if (current?.state === 'reconciling' || priorWasInDoubt) {
      terminal = {
        ...ref,
        state: 'inDoubt',
        stage: 'reconcile',
        errorCode: 'SUPPORT_VERIFY_FAILED',
      };
    } else if (current?.state === 'verifying' || operation === 'verify') {
      terminal = {
        ...ref,
        state: 'failed',
        stage: 'verify',
        errorCode: 'SUPPORT_VERIFY_FAILED',
        retryable: true,
      };
    } else {
      terminal = {
        ...ref,
        state: 'failed',
        stage: 'prepare',
        errorCode: current?.state === 'preparing'
          ? 'SUPPORT_PREPARE_FAILED'
          : 'SUPPORT_TARGET_LEASE_FAILED',
        retryable: true,
      };
    }
    await this.record(configurationId, runId, terminal).catch(() => undefined);
    return terminal;
  }

  private async obsoleteRemaining(
    runId: string,
    configurationId: ConfigurationId,
    refs: readonly TargetGenerationRef[],
    results: (TargetSupportSyncResult | TargetSupportVerifyResult)[],
    firstUnstartedIndex: number,
  ): Promise<void> {
    for (let index = 0; index < results.length; index += 1) {
      const current = results[index]!;
      if (current.state === 'applied' || current.state === 'verified') {
        const stale: TargetSupportSyncResult = {
          ...generationRef(current),
          state: 'stale',
          reason: 'masterAdvanced',
          lastAppliedGenerationId: current.desiredGenerationId,
        };
        await this.record(configurationId, runId, stale);
        results[index] = stale;
      }
    }
    await this.skipRemaining(runId, configurationId, refs, results, firstUnstartedIndex, 'obsolete');
  }

  private async skipRemaining(
    runId: string,
    configurationId: ConfigurationId,
    refs: readonly TargetGenerationRef[],
    results: (TargetSupportSyncResult | TargetSupportVerifyResult)[],
    firstIndex: number,
    reason: 'cancelled' | 'obsolete',
  ): Promise<void> {
    for (let index = firstIndex; index < refs.length; index += 1) {
      const skipped: TargetSupportSyncResult = { ...refs[index]!, state: 'skipped', reason };
      await this.record(configurationId, runId, skipped);
      results.push(skipped);
    }
  }

  private async record(
    configurationId: ConfigurationId,
    runId: string,
    state: TargetSupportSyncState,
  ): Promise<void> {
    try {
      await this.deps.journal.transition(configurationId, runId, state);
    } catch (error) {
      if (
        error instanceof SupportRunJournalError
        && error.code === 'SUPPORT_JOURNAL_DURABILITY_BARRIER_FAILED'
      ) {
        return;
      }
      throw error;
    }
  }

  private async finish<T extends TargetSupportSyncResult>(
    configurationId: ConfigurationId,
    runId: string,
    result: T,
  ): Promise<T> {
    await this.record(configurationId, runId, result);
    return result;
  }
}

type RejectedTargetSelection =
  | {
      readonly accepted: false;
      readonly reason: 'empty' | 'noMatch';
      readonly requestedTargetIds: readonly string[];
    }
  | {
      readonly accepted: false;
      readonly reason: 'duplicate';
      readonly requestedTargetIds: readonly string[];
      readonly duplicateTargetIds: readonly string[];
    }
  | {
      readonly accepted: false;
      readonly reason: 'unknown';
      readonly requestedTargetIds: readonly string[];
      readonly unknownTargetIds: readonly string[];
    };

type TargetSelectionResult =
  | {
      readonly accepted: true;
      readonly targets: CoordinatorReadySupportTarget[];
    }
  | RejectedTargetSelection;

function selectTargets(
  available: readonly CoordinatorReadySupportTarget[],
  selection: TargetSelection,
  previous: readonly TargetSupportSyncResult[],
  desiredGenerationId: string,
): TargetSelectionResult {
  if (selection.kind === 'all') {
    return { accepted: true, targets: [...available] };
  }
  if (selection.kind === 'ids') {
    const requestedTargetIds = [...selection.targetIds];
    if (requestedTargetIds.length === 0) {
      return { accepted: false, reason: 'empty', requestedTargetIds };
    }
    const duplicateTargetIds = duplicateValues(requestedTargetIds);
    if (duplicateTargetIds.length > 0) {
      return {
        accepted: false,
        reason: 'duplicate',
        requestedTargetIds,
        duplicateTargetIds,
      };
    }
    const availableIds = new Set(available.map((target) => target.canonicalTargetId));
    const unknownTargetIds = requestedTargetIds.filter((targetId) => !availableIds.has(targetId));
    if (unknownTargetIds.length > 0) {
      return {
        accepted: false,
        reason: 'unknown',
        requestedTargetIds,
        unknownTargetIds,
      };
    }
    const ids = new Set(requestedTargetIds);
    return {
      accepted: true,
      targets: available.filter((target) => ids.has(target.canonicalTargetId)),
    };
  }
  const allowed = new Set(selection.include);
  const retryable = new Set(previous.filter((target) => {
    if (target.desiredGenerationId !== desiredGenerationId) {
      return false;
    }
    return (target.state === 'failed' && target.retryable && allowed.has('failed'))
      || (target.state === 'inDoubt' && allowed.has('inDoubt'))
      || (
        target.state === 'stale'
        && target.reason === 'targetDrift'
        && allowed.has('targetDrift')
      );
  }).map((target) => target.canonicalTargetId));
  const targets = available.filter((target) => retryable.has(target.canonicalTargetId));
  if (targets.length === 0) {
    return {
      accepted: false,
      reason: 'noMatch',
      requestedTargetIds: [],
    };
  }
  return { accepted: true, targets };
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    } else {
      seen.add(value);
    }
  }
  return [...duplicates];
}

function targetSelectionRejected(
  master: MasterSupportSnapshot,
  selection: RejectedTargetSelection,
): SupportTargetSelectionRejectedOutcome {
  return {
    status: 'targetSelectionRejected',
    master,
    errorCode: 'SUPPORT_TARGET_SELECTION_REJECTED',
    reason: selection.reason,
    requestedTargetIds: [...selection.requestedTargetIds],
    ...(selection.reason === 'duplicate'
      ? { duplicateTargetIds: [...selection.duplicateTargetIds] }
      : {}),
    ...(selection.reason === 'unknown'
      ? { unknownTargetIds: [...selection.unknownTargetIds] }
      : {}),
  } as SupportTargetSelectionRejectedOutcome;
}

function findPriorTarget(
  targets: readonly TargetSupportSyncResult[],
  canonicalTargetId: string,
  desiredGenerationId: string,
): TargetSupportSyncResult | undefined {
  return targets.find(
    (target) =>
      target.canonicalTargetId === canonicalTargetId
      && target.desiredGenerationId === desiredGenerationId,
  );
}

function targetRef(
  target: ReadySupportTarget,
  desiredGenerationId: string,
): TargetGenerationRef {
  return {
    canonicalTargetId: target.canonicalTargetId,
    infobaseIds: [...target.infobaseIds],
    desiredGenerationId,
  };
}

function generationRef(target: TargetGenerationRef): TargetGenerationRef {
  return {
    canonicalTargetId: target.canonicalTargetId,
    infobaseIds: [...target.infobaseIds],
    desiredGenerationId: target.desiredGenerationId,
  };
}

function createSyncSummary(
  runId: string,
  snapshot: MasterSupportSnapshot,
  targets: readonly TargetSupportSyncResult[],
  cancelled: boolean,
  supersededByGenerationId: string | undefined,
): Extract<SupportSyncRunSummary, { readonly scope: 'replicated' }> {
  const base = {
    runId,
    configurationId: snapshot.configurationId,
    desiredGenerationId: snapshot.generationId,
    operation: 'sync' as const,
    scope: 'replicated' as const,
    targets: [...targets],
  };
  if (supersededByGenerationId) {
    return { ...base, state: 'obsolete', supersededByGenerationId };
  }
  return { ...base, state: aggregate(targets, cancelled) };
}

function createVerifySummary(
  runId: string,
  snapshot: MasterSupportSnapshot,
  targets: readonly TargetSupportVerifyResult[],
  cancelled: boolean,
  supersededByGenerationId: string | undefined,
): Extract<SupportVerifyRunSummary, { readonly scope: 'replicated' }> {
  const base = {
    runId,
    configurationId: snapshot.configurationId,
    desiredGenerationId: snapshot.generationId,
    operation: 'verify' as const,
    scope: 'replicated' as const,
    targets: [...targets],
  };
  if (supersededByGenerationId) {
    return { ...base, state: 'obsolete', supersededByGenerationId };
  }
  return { ...base, state: aggregate(targets, cancelled) };
}

function aggregate(
  targets: readonly (TargetSupportSyncResult | TargetSupportVerifyResult)[],
  cancelled: boolean,
): 'complete' | 'partial' | 'failed' | 'cancelled' {
  if (cancelled) {
    return 'cancelled';
  }
  const successes = targets.filter((target) => target.state === 'applied' || target.state === 'verified').length;
  if (successes === targets.length) {
    return 'complete';
  }
  return successes > 0 ? 'partial' : 'failed';
}

function isCancellationTerminal(
  target: TargetSupportSyncResult | TargetSupportVerifyResult,
): boolean {
  return (target.state === 'failed' || target.state === 'inDoubt')
    && (
      target.errorCode === 'CONFIGURATOR_CANCELLED_BEFORE_START'
      || target.errorCode === 'CONFIGURATOR_CANCELLED_AFTER_START'
    );
}

function asPublicReplicatedPreflight(
  preflight: Extract<CoordinatorPreflightResult, { readonly accepted: true; readonly scope: 'replicated' }>,
): Extract<SupportPreflightResult, { readonly accepted: true; readonly scope: 'replicated' }> {
  return {
    accepted: true,
    scope: 'replicated',
    targets: preflight.targets,
  };
}
