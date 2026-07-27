import * as path from 'path';
import type { ConfigurationId } from '../services/configurationSession/types';
import type {
  MasterSupportState,
  MetadataUniverseEntry,
  SupportStatusRequest,
  SupportStatusResult,
} from './supportTypes';

/** Narrow facade boundary: the UI cache can only read the public support status operation. */
export interface SupportStatusFacade {
  getStatus(request: SupportStatusRequest): Promise<SupportStatusResult>;
}

export interface CachedSupportStatus extends SupportStatusResult {
  readonly configRoot: string;
  readonly configurationId: ConfigurationId;
  /** Present only when the master file supplied an immutable content generation. */
  readonly generationId?: string;
  /** Immutable O(1) membership index for exact universe identities used by tree decoration. */
  readonly metadataUniverseIdentityIndex: MetadataUniverseIdentityIndex;
}

export interface MetadataUniverseIdentityIndex {
  has(entry: MetadataUniverseEntry): boolean;
}

interface Registration {
  readonly configRoot: string;
  readonly configurationId: ConfigurationId;
}

interface InFlightLoad {
  readonly epoch: number;
  readonly promise: Promise<CachedSupportStatus>;
}

/**
 * Read-through UI cache indexed by canonical configuration root and master generation.
 *
 * Invalidation advances a per-root epoch. A load started before invalidation may finish for its
 * caller, but can never republish stale data into the cache.
 */
export class SupportStateCache {
  private readonly registrations = new Map<string, Registration>();
  private readonly epochs = new Map<string, number>();
  private readonly latestGenerationKeys = new Map<string, string>();
  private readonly statusesByGeneration = new Map<string, CachedSupportStatus>();
  private readonly inFlightLoads = new Map<string, InFlightLoad>();

  constructor(private readonly facade: SupportStatusFacade) {}

  register(configRoot: string, configurationId: ConfigurationId): void {
    const registration = createRegistration(configRoot, configurationId);
    const rootKey = normalizeRootKey(registration.configRoot);
    const previous = this.registrations.get(rootKey);
    if (previous?.configurationId === configurationId) {
      return;
    }
    this.invalidateByKey(rootKey);
    this.registrations.set(rootKey, registration);
  }

  unregister(configRoot: string): void {
    const rootKey = normalizeRootKey(configRoot);
    this.invalidateByKey(rootKey);
    this.registrations.delete(rootKey);
  }

  isRegistered(configRoot: string): boolean {
    return this.registrations.has(normalizeRootKey(configRoot));
  }

  get(configRoot: string, generationId?: string): CachedSupportStatus | undefined {
    const rootKey = normalizeRootKey(configRoot);
    const generationKey = generationId === undefined
      ? this.latestGenerationKeys.get(rootKey)
      : generationStorageKey(rootKey, `generation:${generationId}`);
    return generationKey === undefined ? undefined : this.statusesByGeneration.get(generationKey);
  }

  async load(configRoot: string): Promise<CachedSupportStatus> {
    const rootKey = normalizeRootKey(configRoot);
    const registration = this.requireRegistration(rootKey);
    const cached = this.get(registration.configRoot);
    if (cached) {
      return cached;
    }

    const epoch = this.epochs.get(rootKey) ?? 0;
    const currentLoad = this.inFlightLoads.get(rootKey);
    if (currentLoad?.epoch === epoch) {
      return currentLoad.promise;
    }

    const promise = this.loadFresh(rootKey, registration, epoch);
    this.inFlightLoads.set(rootKey, { epoch, promise });
    return promise.finally(() => {
      if (this.inFlightLoads.get(rootKey)?.promise === promise) {
        this.inFlightLoads.delete(rootKey);
      }
    });
  }

  invalidate(configRoot: string): void {
    this.invalidateByKey(normalizeRootKey(configRoot));
  }

  clear(): void {
    for (const rootKey of this.registrations.keys()) {
      this.invalidateByKey(rootKey);
    }
  }

  private async loadFresh(
    rootKey: string,
    registration: Registration,
    epoch: number,
  ): Promise<CachedSupportStatus> {
    const status = await this.facade.getStatus({
      configurationId: registration.configurationId,
    });
    const cached = freezeCachedStatus(registration, status);
    const currentRegistration = this.registrations.get(rootKey);
    if (
      (this.epochs.get(rootKey) ?? 0) === epoch
      && currentRegistration?.configurationId === registration.configurationId
    ) {
      this.publish(rootKey, cached);
    }
    return cached;
  }

  private publish(rootKey: string, status: CachedSupportStatus): void {
    const previousKey = this.latestGenerationKeys.get(rootKey);
    if (previousKey !== undefined) {
      this.statusesByGeneration.delete(previousKey);
    }
    const generationKey = generationStorageKey(rootKey, masterGenerationDiscriminator(status.master));
    this.statusesByGeneration.set(generationKey, status);
    this.latestGenerationKeys.set(rootKey, generationKey);
  }

  private invalidateByKey(rootKey: string): void {
    this.epochs.set(rootKey, (this.epochs.get(rootKey) ?? 0) + 1);
    const generationKey = this.latestGenerationKeys.get(rootKey);
    if (generationKey !== undefined) {
      this.statusesByGeneration.delete(generationKey);
      this.latestGenerationKeys.delete(rootKey);
    }
  }

  private requireRegistration(rootKey: string): Registration {
    const registration = this.registrations.get(rootKey);
    if (!registration) {
      throw new Error('Support state cache cannot load an unregistered configuration root.');
    }
    return registration;
  }
}

function createRegistration(configRoot: string, configurationId: ConfigurationId): Registration {
  if (!configurationId) {
    throw new Error('Support state cache registration requires a configuration identity.');
  }
  return Object.freeze({
    configRoot: path.resolve(configRoot),
    configurationId,
  });
}

function freezeCachedStatus(
  registration: Registration,
  status: SupportStatusResult,
): CachedSupportStatus {
  const generationId = masterGenerationId(status.master);
  return Object.freeze({
    status: 'available',
    configRoot: registration.configRoot,
    configurationId: registration.configurationId,
    master: status.master,
    metadataUniverse: status.metadataUniverse,
    metadataUniverseIdentityIndex: createMetadataUniverseIdentityIndex(
      status.metadataUniverse.entries
    ),
    ...(status.lastRun === undefined ? {} : { lastRun: status.lastRun }),
    ...(generationId === undefined ? {} : { generationId }),
  });
}

export function createMetadataUniverseIdentityIndex(
  entries: readonly MetadataUniverseEntry[]
): MetadataUniverseIdentityIndex {
  const keys = new Set(entries.map(metadataUniverseIdentityKey));
  return Object.freeze({
    has: (entry: MetadataUniverseEntry): boolean =>
      keys.has(metadataUniverseIdentityKey(entry)),
  });
}

function metadataUniverseIdentityKey(entry: MetadataUniverseEntry): string {
  return `${entry.relativeMetadataPath}\0${entry.objectUuid}\0${entry.supportSubjectUuid}`;
}

function masterGenerationId(master: MasterSupportState): string | undefined {
  if (master.kind === 'ready') {
    return master.snapshot.generationId;
  }
  return master.kind === 'unknown' ? master.generationId : undefined;
}

function masterGenerationDiscriminator(master: MasterSupportState): string {
  if (master.kind === 'ready') {
    return `generation:${master.snapshot.generationId}`;
  }
  if (master.kind === 'unknown') {
    return master.generationId === undefined
      ? `unknown:${master.errorCode}:${master.filePath}`
      : `generation:${master.generationId}`;
  }
  return `unmanaged:${master.reason}:${master.expectedFilePath}`;
}

function generationStorageKey(rootKey: string, generation: string): string {
  return `${rootKey}\0${generation}`;
}

function normalizeRootKey(configRoot: string): string {
  const resolved = path.resolve(configRoot);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}
