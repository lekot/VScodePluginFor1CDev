import * as path from 'path';
import type { BindingManager } from '../bindings/bindingManager';
import type { InfobaseConfigurationOperationQueue } from '../infobases/infobaseConfigurationOperationQueue';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';
import type { InfobaseStorageService } from '../infobases/infobaseStorageService';
import type { ConfigurationId } from '../services/configurationSession/types';
import { ConfiguratorSupportApplicator } from './configuratorSupportApplicator';
import { MetadataUniverseResolver } from './metadataUniverseResolver';
import { ParentConfigurationsStore } from './parentConfigurationsStore';
import {
  SupportApplicationServiceRegistry,
  type SupportApplicationFacade,
  type SupportConfigurationRegistration,
} from './supportApplicationServiceRegistry';
import { SupportApplicationService } from './supportApplicationService';
import {
  SupportBindingResolver,
  type SupportBindingPreflightResult,
  type SupportBindingSelector,
} from './supportBindingResolver';
import { SupportModeService } from './supportModeService';
import { SupportPayloadCache } from './supportPayloadCache';
import { SupportRunJournal } from './supportRunJournal';
import {
  type CoordinatorPreflightResult,
  type CoordinatorReadySupportTarget,
  SupportSyncCoordinator,
} from './supportSyncCoordinator';
import {
  SUPPORT_OPERATIONAL_ERROR_CODES,
  type MasterSupportSnapshot,
  type SupportCancellation,
  type SupportOperationalErrorCode,
  type SupportOperationRejectedOutcome,
  type SupportTargetCapability,
  type UnsupportedSupportTarget,
} from './supportTypes';

const JOURNAL_FILE = 'support-run-journal-v1.json';
const OPERATIONAL_CODES: ReadonlySet<string> = new Set(SUPPORT_OPERATIONAL_ERROR_CODES);

export interface SupportServiceCompositionDeps {
  readonly bindingManager: Pick<BindingManager, 'getDiagnostic'>;
  readonly infobaseStorage: Pick<
    InfobaseStorageService,
    'load' | 'readPasswordSecret'
  >;
  readonly globalStorageRoot: string;
  readonly selector: (
    registration: SupportConfigurationRegistration,
  ) => SupportBindingSelector;
  readonly targetQueue: Pick<InfobaseConfigurationOperationQueue, 'runExclusive'>;
  /**
   * The already-configured extension mutation gateway. Composition never installs another one.
   */
  readonly runExclusiveConfigurationOperation: <T>(
    resourcePath: string,
    kind: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly cancellation?: SupportCancellation;
}

export interface SupportServiceComposition {
  /** Registration/lifecycle controller; adapters should receive only {@link facade}. */
  readonly registry: SupportApplicationServiceRegistry;
  /** Exactly six public support operations. */
  readonly facade: SupportApplicationFacade;
  readonly journal: SupportRunJournal;
  readonly payloadCache: SupportPayloadCache;
  dispose(): Promise<void>;
}

/**
 * Builds one extension-scoped support graph. Durable payloads and the run journal are shared;
 * configuration-local stores, coordinators and facades are constructed lazily by the registry.
 */
export function createSupportServiceComposition(
  deps: SupportServiceCompositionDeps,
): SupportServiceComposition {
  const ownedCancellation = new SupportCancellationSource();
  const cancellation = linkCancellation(ownedCancellation, deps.cancellation);
  const storageRoot = path.resolve(deps.globalStorageRoot);
  const payloadCache = new SupportPayloadCache(storageRoot);
  const journal = new SupportRunJournal(path.join(storageRoot, JOURNAL_FILE));
  const bindingResolver = new SupportBindingResolver({
    bindingManager: deps.bindingManager,
    infobaseStorage: deps.infobaseStorage,
  });
  const applicator = new ConfiguratorSupportApplicator(payloadCache, {
    getCredentials: (entry) => resolveCredentials(entry, deps.infobaseStorage),
  });

  const registry = new SupportApplicationServiceRegistry((registration) => {
    return createConfigurationService(
      registration,
      deps,
      bindingResolver,
      applicator,
      journal,
      cancellation,
    );
  });
  const activeOperations = new Set<Promise<unknown>>();
  let acceptingOperations = true;
  let disposePromise: Promise<void> | undefined;
  const rejected = (): SupportOperationRejectedOutcome => ({
    status: 'operationRejected',
    errorCode: 'SUPPORT_OPERATION_FAILED',
    retryable: true,
  });
  const track = <T>(
    operation: () => Promise<T>,
    rejection: T,
  ): Promise<T> => {
    if (!acceptingOperations) {
      return Promise.resolve(rejection);
    }
    let promise: Promise<T>;
    try {
      promise = operation();
    } catch (error) {
      promise = Promise.reject(error);
    }
    activeOperations.add(promise);
    void promise.then(
      () => activeOperations.delete(promise),
      () => activeOperations.delete(promise),
    );
    return promise;
  };
  const facade: SupportApplicationFacade = {
    getStatus: (request) => track(() => registry.facade.getStatus(request), rejected()),
    setObjectMode: (request) => track(() => registry.facade.setObjectMode(request), rejected()),
    enableObjectRules: (request) => track(() => registry.facade.enableObjectRules(request), rejected()),
    sync: (request) => track(() => registry.facade.sync(request), rejected()),
    verify: (request) => track(() => registry.facade.verify(request), rejected()),
    getLastRun: (request) => track(() => registry.facade.getLastRun(request), rejected()),
  };
  Object.freeze(facade);

  return {
    registry,
    facade,
    journal,
    payloadCache,
    dispose: () => {
      if (disposePromise) {
        return disposePromise;
      }
      acceptingOperations = false;
      ownedCancellation.cancel();
      const pending = [...activeOperations];
      disposePromise = (async () => {
        await Promise.allSettled(pending);
        registry.clear();
        ownedCancellation.dispose();
      })();
      return disposePromise;
    },
  };
}

function createConfigurationService(
  registration: SupportConfigurationRegistration,
  deps: SupportServiceCompositionDeps,
  bindingResolver: SupportBindingResolver,
  applicator: ConfiguratorSupportApplicator,
  journal: SupportRunJournal,
  cancellation: SupportCancellation,
): SupportApplicationService {
  const universeResolver = new MetadataUniverseResolver();
  const store = new ParentConfigurationsStore(registration.configurationId, {
    universeResolver,
    runExclusive: deps.runExclusiveConfigurationOperation,
  });
  const bindingPreflight = () =>
    resolveBindingPreflight(bindingResolver, deps.selector(registration));
  const fullPreflight = async (snapshot: MasterSupportSnapshot) => {
    return probePreflight(await bindingPreflight(), applicator, snapshot);
  };
  const coordinator = new SupportSyncCoordinator({
    applicator,
    journal,
    // Coordinator owns the capability/credential probe for sync and verify operations.
    preflight: bindingPreflight,
    getCurrentGenerationId: async (configurationId) => {
      assertConfigurationIdentity(registration.configurationId, configurationId);
      const master = await store.read(registration.configRoot);
      return master.kind === 'ready'
        ? master.snapshot.generationId
        : unavailableGeneration(configurationId, master.kind);
    },
    runTargetExclusive: (target, operation) =>
      deps.targetQueue.runExclusive(target.canonicalTargetId, async () => operation()),
  });
  const modeService = new SupportModeService({
    configurationId: registration.configurationId,
    configRoot: registration.configRoot,
    store,
    universeResolver,
    // Mutations require the complete all-target gate before entering the configuration lease.
    preflight: fullPreflight,
    coordinator,
    runExclusiveConfigurationOperation: deps.runExclusiveConfigurationOperation,
    cancellation,
  });
  return new SupportApplicationService({
    configurationId: registration.configurationId,
    modeService,
    coordinator,
    journal,
    cancellation,
  });
}

async function resolveBindingPreflight(
  resolver: SupportBindingResolver,
  selector: SupportBindingSelector,
): Promise<CoordinatorPreflightResult> {
  const result = await resolver.resolve(selector);
  if (result.accepted) {
    if (result.scope === 'masterOnly') {
      return result;
    }
    const [firstTarget, ...remainingTargets] = result.targets;
    return {
      accepted: true,
      scope: 'replicated',
      targets: [
        toCoordinatorTarget(firstTarget),
        ...remainingTargets.map(toCoordinatorTarget),
      ],
    };
  }
  if (result.reason === 'bindingInvalid') {
    return {
      accepted: false,
      reason: 'bindingInvalid',
      errorCode: 'SUPPORT_BINDING_INVALID',
      diagnostics: [...result.diagnostics],
    };
  }
  const [firstUnsupported, ...remainingUnsupported] = result.unsupportedTargets;
  return {
    accepted: false,
    reason: 'targetUnsupported',
    errorCode: 'SUPPORT_TARGET_UNSUPPORTED',
    readyTargets: result.readyTargets.map(toCoordinatorTarget),
    unsupportedTargets: [
      toUnsupportedTarget(firstUnsupported),
      ...remainingUnsupported.map(toUnsupportedTarget),
    ],
  };
}

async function probePreflight(
  binding: CoordinatorPreflightResult,
  applicator: ConfiguratorSupportApplicator,
  snapshot: MasterSupportSnapshot,
): Promise<CoordinatorPreflightResult> {
  if (!binding.accepted || binding.scope === 'masterOnly') {
    return binding;
  }
  const capabilities = await Promise.all(binding.targets.map(async (target) => {
    let capability: SupportTargetCapability;
    try {
      capability = await applicator.probe(target.entry, snapshot);
    } catch {
      capability = { supported: false, errorCode: 'SUPPORT_TARGET_PROBE_FAILED' };
    }
    return { target, capability };
  }));
  const readyTargets: CoordinatorReadySupportTarget[] = [];
  const unsupportedTargets: UnsupportedSupportTarget[] = [];
  for (const { target, capability } of capabilities) {
    if (capability.supported && capability.canonicalTargetId === target.canonicalTargetId) {
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
    const [firstUnsupported, ...remainingUnsupported] = unsupportedTargets;
    if (!firstUnsupported) {
      throw new Error('Unsupported support preflight lost its first target.');
    }
    return {
      accepted: false,
      reason: 'targetUnsupported',
      errorCode: 'SUPPORT_TARGET_UNSUPPORTED',
      readyTargets,
      unsupportedTargets: [firstUnsupported, ...remainingUnsupported],
    };
  }
  const [firstReady, ...remainingReady] = readyTargets;
  if (!firstReady) {
    throw new Error('Replicated support preflight unexpectedly resolved no targets.');
  }
  return {
    accepted: true,
    scope: 'replicated',
    targets: [firstReady, ...remainingReady],
  };
}

function toCoordinatorTarget(
  target: Extract<
    SupportBindingPreflightResult,
    { readonly accepted: true; readonly scope: 'replicated' }
  >['targets'][number],
): CoordinatorReadySupportTarget {
  return {
    canonicalTargetId: target.canonicalTargetId,
    infobaseIds: [...target.infobaseIds],
    state: 'ready',
    entry: target.entry,
  };
}

function toUnsupportedTarget(
  target: Extract<
    SupportBindingPreflightResult,
    { readonly accepted: false; readonly reason: 'targetUnsupported' }
  >['unsupportedTargets'][number],
): UnsupportedSupportTarget {
  return {
    canonicalTargetId: target.canonicalTargetId,
    infobaseIds: [...target.infobaseIds],
    state: 'targetUnsupported',
    errorCode: operationalCode(target.errorCode),
  };
}

async function resolveCredentials(
  entry: InfobaseEntry,
  storage: Pick<InfobaseStorageService, 'readPasswordSecret'>,
): Promise<{ readonly user?: string; readonly password?: string } | undefined> {
  const user = entry.user?.trim();
  const password = entry.hasStoredPassword
    ? await storage.readPasswordSecret(entry.id)
    : undefined;
  if (!user && !password) {
    return undefined;
  }
  return {
    ...(user ? { user } : {}),
    ...(password ? { password } : {}),
  };
}

function operationalCode(code: string): SupportOperationalErrorCode {
  return OPERATIONAL_CODES.has(code)
    ? code as SupportOperationalErrorCode
    : 'SUPPORT_TARGET_UNSUPPORTED';
}

function assertConfigurationIdentity(
  expected: ConfigurationId,
  actual: ConfigurationId,
): void {
  if (actual !== expected) {
    throw new Error('Support coordinator requested another configuration identity.');
  }
}

function unavailableGeneration(configurationId: ConfigurationId, state: string): string {
  return `unavailable:${configurationId}:${state}`;
}

class SupportCancellationSource implements SupportCancellation {
  private readonly listeners = new Set<() => void>();
  private cancelled = false;

  get isCancellationRequested(): boolean {
    return this.cancelled;
  }

  onCancellationRequested(listener: () => void): { dispose(): void } {
    if (this.cancelled) {
      listener();
      return { dispose: () => undefined };
    }
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  cancel(): void {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Cancellation must reach every active process even if one listener is faulty.
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

function linkCancellation(
  owned: SupportCancellation,
  external: SupportCancellation | undefined,
): SupportCancellation {
  if (!external) {
    return owned;
  }
  return {
    get isCancellationRequested(): boolean {
      return owned.isCancellationRequested || external.isCancellationRequested;
    },
    onCancellationRequested: (listener) => {
      let active = true;
      let fired = false;
      const notify = (): void => {
        if (!active || fired) {
          return;
        }
        fired = true;
        listener();
      };
      const ownedRegistration = owned.onCancellationRequested(notify);
      const externalRegistration = external.onCancellationRequested(notify);
      if (owned.isCancellationRequested || external.isCancellationRequested) {
        notify();
      }
      return {
        dispose: () => {
          active = false;
          ownedRegistration.dispose();
          externalRegistration.dispose();
        },
      };
    },
  };
}
