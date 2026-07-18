import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { CONFIGURATION_XML } from '../../constants/fileNames';
import { ConfigFormat } from '../../parsers/formatDetector';
import { ConfigurationSession } from './ConfigurationSession';
import { assertPathWithinRoot, isPathInside } from './pathBoundary';
import type { ConfigurationDescriptor, ConfigurationId, ConfigurationIdentity } from './types';

export type WorkspaceRegistryErrorCode =
  | 'CONFIGURATION_NOT_FOUND'
  | 'CONFIGURATION_SELECTION_REQUIRED'
  | 'CONFIGURATION_ID_UNKNOWN'
  | 'CONFIGURATION_CAPABILITY_UNSUPPORTED'
  | 'REGISTRY_DISPOSED';

export class WorkspaceRegistryError extends Error {
  constructor(readonly code: WorkspaceRegistryErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceRegistryError';
  }
}

export interface DiscoveredConfiguration {
  readonly configPath: string;
  readonly workspaceFolderPath?: string;
  readonly format?: ConfigFormat;
}

interface PersistedIdentityEntry {
  readonly configurationId: ConfigurationId;
  rootUri: string;
  descriptorUuid?: string;
  lastSeenAt: string;
}

interface PersistedIdentityTombstone extends PersistedIdentityEntry {
  readonly replacedAt: string;
  readonly reason: 'descriptor-replaced';
}

interface PersistedIdentityStore {
  readonly version: 1;
  entries: PersistedIdentityEntry[];
  tombstones: PersistedIdentityTombstone[];
}

interface DiscoveredIdentityFacts {
  readonly rootPath: string;
  readonly rootUri: string;
  readonly descriptorUri: string;
  readonly descriptorUuid?: string;
  readonly workspaceFolderUri: string;
  readonly format: ConfigFormat;
  readonly health: ConfigurationDescriptor['health'];
}

/** Minimal runtime registry used by migration adapters and Agent selection. */
export class WorkspaceRegistry {
  private sessions = new Map<ConfigurationId, ConfigurationSession>();
  private descriptors = new Map<ConfigurationId, ConfigurationDescriptor>();
  private disposed = false;
  private identityStoreLoaded = false;
  private identityStore: PersistedIdentityStore = { version: 1, entries: [], tombstones: [] };

  constructor(private readonly identityStorePath?: string) {}

  async refresh(discovered: readonly DiscoveredConfiguration[]): Promise<void> {
    this.ensureActive();
    await this.loadIdentityStore();
    const nextIdentities = new Map<ConfigurationId, ConfigurationIdentity>();
    const labels = new Map<ConfigurationId, string>();
    const health = new Map<ConfigurationId, ConfigurationDescriptor['health']>();
    for (const candidate of discovered) {
      const facts = await discoverIdentityFacts(candidate);
      const identity = this.resolveIdentity(facts);
      const existing = nextIdentities.get(identity.configurationId);
      if (existing) {
        const aliases = new Set([...existing.workspaceFolderUris, ...identity.workspaceFolderUris]);
        nextIdentities.set(identity.configurationId, { ...existing, workspaceFolderUris: [...aliases] });
      } else {
        nextIdentities.set(identity.configurationId, identity);
        labels.set(identity.configurationId, path.basename(identity.rootPath));
      }
      if (facts.health === 'degraded' || !health.has(identity.configurationId)) {
        health.set(identity.configurationId, facts.health);
      }
    }

    await this.persistIdentityStore();

    const removed = [...this.sessions.entries()].filter(([id]) => !nextIdentities.has(id));
    const nextSessions = new Map<ConfigurationId, ConfigurationSession>();
    const nextDescriptors = new Map<ConfigurationId, ConfigurationDescriptor>();
    for (const [id, identity] of nextIdentities) {
      const session = this.sessions.get(id) ?? new ConfigurationSession(identity);
      session.updateIdentity(identity);
      nextSessions.set(id, session);
      nextDescriptors.set(id, {
        ...identity,
        label: labels.get(id) ?? path.basename(identity.rootPath),
        health: health.get(id) ?? 'degraded',
      });
    }
    this.sessions = nextSessions;
    this.descriptors = nextDescriptors;
    await Promise.all(removed.map(([, session]) => session.dispose()));
  }

  list(): ConfigurationDescriptor[] {
    this.ensureActive();
    return [...this.descriptors.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  require(configurationId: ConfigurationId | string): ConfigurationSession {
    this.ensureActive();
    const session = this.sessions.get(configurationId as ConfigurationId);
    if (!session) {
      throw new WorkspaceRegistryError(
        'CONFIGURATION_ID_UNKNOWN',
        `Конфигурация с id ${configurationId} не найдена.`,
      );
    }
    return session;
  }

  resolveLegacyDefault(requiredCapability: keyof ConfigurationIdentity['capabilities'] = 'read'): ConfigurationSession {
    this.ensureActive();
    const compatible = [...this.sessions.values()].filter(
      (session) => session.identity.capabilities[requiredCapability],
    );
    if (compatible.length === 0) {
      throw new WorkspaceRegistryError('CONFIGURATION_NOT_FOUND', 'Корень конфигурации не найден.');
    }
    if (compatible.length > 1) {
      throw new WorkspaceRegistryError(
        'CONFIGURATION_SELECTION_REQUIRED',
        'Открыто несколько конфигураций. Укажите configurationId.',
      );
    }
    return compatible[0]!;
  }

  async resolveResource(resource: string): Promise<ConfigurationSession> {
    this.ensureActive();
    const resourcePath = resource.startsWith('file:') ? fileURLToPath(resource) : resource;
    let best: ConfigurationSession | undefined;
    for (const session of this.sessions.values()) {
      try {
        const { canonicalTarget } = await assertPathWithinRoot(session.identity.rootPath, resourcePath);
        if (
          isPathInside(session.identity.rootPath, canonicalTarget)
          && (!best || session.identity.rootPath.length > best.identity.rootPath.length)
        ) {
          best = session;
        }
      } catch {
        // Not contained by this root.
      }
    }
    if (!best) {
      throw new WorkspaceRegistryError('CONFIGURATION_NOT_FOUND', `Ресурс не принадлежит конфигурации: ${resource}`);
    }
    return best;
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.descriptors.clear();
    await Promise.all(sessions.map((session) => session.dispose()));
  }

  private ensureActive(): void {
    if (this.disposed) {
      throw new WorkspaceRegistryError('REGISTRY_DISPOSED', 'Registry конфигураций уже закрыт.');
    }
  }

  private async loadIdentityStore(): Promise<void> {
    if (this.identityStoreLoaded) {
      return;
    }
    this.identityStoreLoaded = true;
    if (!this.identityStorePath) {
      return;
    }
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.identityStorePath, 'utf8')) as Partial<PersistedIdentityStore>;
      if (parsed.version === 1 && Array.isArray(parsed.entries) && Array.isArray(parsed.tombstones)) {
        this.identityStore = {
          version: 1,
          entries: parsed.entries.filter(isPersistedEntry),
          tombstones: parsed.tombstones.filter(isPersistedTombstone),
        };
      }
    } catch (error) {
      if (!isMissingError(error)) {
        // A corrupt cache must not prevent opening a workspace. New identities are persisted below.
        this.identityStore = { version: 1, entries: [], tombstones: [] };
      }
    }
  }

  private resolveIdentity(facts: DiscoveredIdentityFacts): ConfigurationIdentity {
    const now = new Date().toISOString();
    const sameRoot = this.identityStore.entries.find((entry) => entry.rootUri === facts.rootUri);
    let entry: PersistedIdentityEntry | undefined;

    if (!facts.descriptorUuid) {
      // A transient descriptor read failure degrades, but never changes, a known identity.
      entry = sameRoot;
    } else if (sameRoot && (!sameRoot.descriptorUuid || sameRoot.descriptorUuid === facts.descriptorUuid)) {
      // Promotion from path-only discovery keeps the random id stable.
      sameRoot.descriptorUuid = facts.descriptorUuid;
      entry = sameRoot;
    } else {
      if (sameRoot?.descriptorUuid && sameRoot.descriptorUuid !== facts.descriptorUuid) {
        this.identityStore.entries = this.identityStore.entries.filter((candidate) => candidate !== sameRoot);
        this.identityStore.tombstones.push({
          ...sameRoot,
          replacedAt: now,
          reason: 'descriptor-replaced',
        });
      }
      // UUIDs are routinely copied with configurations; a different physical root is a different identity.
      entry = undefined;
    }

    if (!entry) {
      entry = {
        configurationId: `cfg-${randomUUID()}` as ConfigurationId,
        rootUri: facts.rootUri,
        descriptorUuid: facts.descriptorUuid,
        lastSeenAt: now,
      };
      this.identityStore.entries.push(entry);
    } else {
      entry.rootUri = facts.rootUri;
      entry.lastSeenAt = now;
    }

    return {
      configurationId: entry.configurationId,
      rootPath: facts.rootPath,
      rootUri: facts.rootUri,
      descriptorUri: facts.descriptorUri,
      workspaceFolderUris: [facts.workspaceFolderUri],
      format: facts.format,
      capabilities: {
        read: true,
        write: facts.format === ConfigFormat.Designer && facts.health === 'ready',
        process: facts.format === ConfigFormat.Designer && facts.health === 'ready',
      },
    };
  }

  private async persistIdentityStore(): Promise<void> {
    if (!this.identityStorePath) {
      return;
    }
    const parentPath = path.dirname(this.identityStorePath);
    await fs.promises.mkdir(parentPath, { recursive: true });
    const tempPath = path.join(parentPath, `.configuration-identities-${randomUUID()}.tmp`);
    try {
      await fs.promises.writeFile(tempPath, JSON.stringify(this.identityStore, null, 2), { encoding: 'utf8', flag: 'wx' });
      await fs.promises.rename(tempPath, this.identityStorePath);
    } finally {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

async function discoverIdentityFacts(candidate: DiscoveredConfiguration): Promise<DiscoveredIdentityFacts> {
  const rootPath = await fs.promises.realpath(path.resolve(candidate.configPath));
  const descriptorPath = path.join(rootPath, CONFIGURATION_XML);
  let descriptorUuid: string | undefined;
  let descriptorUri = pathToFileURL(descriptorPath).toString();
  let health: ConfigurationDescriptor['health'] = 'degraded';
  try {
    const canonicalDescriptor = await fs.promises.realpath(descriptorPath);
    descriptorUri = pathToFileURL(canonicalDescriptor).toString();
    const descriptorContent = await fs.promises.readFile(canonicalDescriptor, 'utf8');
    descriptorUuid = /\buuid\s*=\s*["']([^"']+)["']/i.exec(descriptorContent)?.[1];
    health = descriptorUuid ? 'ready' : 'degraded';
  } catch {
    // A degraded descriptor still gets a path-bound identity for migration compatibility.
  }
  const workspaceFolderPath = candidate.workspaceFolderPath
    ? await fs.promises.realpath(path.resolve(candidate.workspaceFolderPath))
    : rootPath;
  const format = candidate.format ?? ConfigFormat.Designer;
  return {
    rootPath,
    rootUri: pathToFileURL(rootPath).toString(),
    descriptorUri,
    descriptorUuid,
    workspaceFolderUri: pathToFileURL(workspaceFolderPath).toString(),
    format,
    health,
  };
}

function isPersistedEntry(value: unknown): value is PersistedIdentityEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<PersistedIdentityEntry>;
  return typeof candidate.configurationId === 'string'
    && candidate.configurationId.startsWith('cfg-')
    && typeof candidate.rootUri === 'string'
    && typeof candidate.lastSeenAt === 'string'
    && (candidate.descriptorUuid === undefined || typeof candidate.descriptorUuid === 'string');
}

function isPersistedTombstone(value: unknown): value is PersistedIdentityTombstone {
  return isPersistedEntry(value)
    && typeof (value as Partial<PersistedIdentityTombstone>).replacedAt === 'string'
    && (value as Partial<PersistedIdentityTombstone>).reason === 'descriptor-replaced';
}

function isMissingError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
