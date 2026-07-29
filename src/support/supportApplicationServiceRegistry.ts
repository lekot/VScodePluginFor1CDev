import * as path from 'path';
import { normalizeConfigRelativePath } from '../bindings/bindingPathUtils';
import type { ConfigurationId } from '../services/configurationSession/types';
import type { SupportApplicationService } from './supportApplicationService';
import type {
  EnableObjectRulesRequest,
  SupportGetLastRunOutcome,
  SupportGetLastRunRequest,
  SupportMasterStatusOutcome,
  SupportMasterStatusRequest,
  SupportModeMutationOutcome,
  SupportMutationRequest,
  SupportOperationRejectedOutcome,
  SupportStatusOutcome,
  SupportStatusRequest,
  SupportSyncOperationOutcome,
  SupportSyncOperationRequest,
  SupportVerifyOperationOutcome,
  SupportVerifyOperationRequest,
} from './supportTypes';

export interface SupportConfigurationRegistration {
  readonly configurationId: ConfigurationId;
  readonly configRoot: string;
  readonly workspaceFolderName: string;
  readonly configRelativePath: string;
}

/** The support surface exposed to UI, deploy, and Agent/MCP adapters. */
export interface SupportApplicationFacade {
  getStatus(request: SupportStatusRequest): Promise<SupportStatusOutcome>;
  getMasterStatus(request: SupportMasterStatusRequest): Promise<SupportMasterStatusOutcome>;
  setObjectMode(request: SupportMutationRequest): Promise<SupportModeMutationOutcome>;
  enableObjectRules(request: EnableObjectRulesRequest): Promise<SupportModeMutationOutcome>;
  sync(request: SupportSyncOperationRequest): Promise<SupportSyncOperationOutcome>;
  verify(request: SupportVerifyOperationRequest): Promise<SupportVerifyOperationOutcome>;
  getLastRun(request: SupportGetLastRunRequest): Promise<SupportGetLastRunOutcome>;
}

export type SupportApplicationServiceFactory = (
  registration: SupportConfigurationRegistration,
) => SupportApplicationService;

interface RegisteredConfiguration {
  readonly registration: SupportConfigurationRegistration;
  service?: SupportApplicationService;
}

/**
 * Extension-scoped multi-root router. Registration is cheap; the complete per-configuration
 * application service graph is created only when a facade operation is called.
 */
export class SupportApplicationServiceRegistry {
  private readonly byConfigurationId = new Map<ConfigurationId, RegisteredConfiguration>();
  private readonly configurationIdByRoot = new Map<string, ConfigurationId>();

  readonly facade: SupportApplicationFacade;

  constructor(private readonly createService: SupportApplicationServiceFactory) {
    this.facade = Object.freeze({
      getStatus: (request: SupportStatusRequest) => this.getStatus(request),
      getMasterStatus: (request: SupportMasterStatusRequest) => this.getMasterStatus(request),
      setObjectMode: (request: SupportMutationRequest) => this.setObjectMode(request),
      enableObjectRules: (request: EnableObjectRulesRequest) => this.enableObjectRules(request),
      sync: (request: SupportSyncOperationRequest) => this.sync(request),
      verify: (request: SupportVerifyOperationRequest) => this.verify(request),
      getLastRun: (request: SupportGetLastRunRequest) => this.getLastRun(request),
    });
  }

  registerConfiguration(registration: SupportConfigurationRegistration): void {
    const normalized = normalizeRegistration(registration);
    const rootKey = normalizeRootKey(normalized.configRoot);
    const rootOwner = this.configurationIdByRoot.get(rootKey);
    if (rootOwner !== undefined && rootOwner !== normalized.configurationId) {
      throw new Error('A support configuration root cannot be registered with two identities.');
    }

    const existing = this.byConfigurationId.get(normalized.configurationId);
    if (
      existing
      && normalizeRootKey(existing.registration.configRoot) !== rootKey
    ) {
      throw new Error('A support configuration identity cannot be registered for two roots.');
    }
    if (existing && registrationsEqual(existing.registration, normalized)) {
      return;
    }

    this.configurationIdByRoot.set(rootKey, normalized.configurationId);
    this.byConfigurationId.set(normalized.configurationId, { registration: normalized });
  }

  unregisterConfiguration(configurationId: ConfigurationId): void {
    const existing = this.byConfigurationId.get(configurationId);
    if (!existing) {
      return;
    }
    this.byConfigurationId.delete(configurationId);
    this.configurationIdByRoot.delete(normalizeRootKey(existing.registration.configRoot));
  }

  getRegistration(configurationId: ConfigurationId): SupportConfigurationRegistration | undefined {
    return this.byConfigurationId.get(configurationId)?.registration;
  }

  getRegistrationByRoot(configRoot: string): SupportConfigurationRegistration | undefined {
    const configurationId = this.configurationIdByRoot.get(normalizeRootKey(configRoot));
    return configurationId === undefined
      ? undefined
      : this.byConfigurationId.get(configurationId)?.registration;
  }

  /** Resolves and lazily constructs the per-configuration facade implementation. */
  get(configurationId: ConfigurationId): SupportApplicationService | undefined {
    const registered = this.byConfigurationId.get(configurationId);
    if (!registered) {
      return undefined;
    }
    registered.service ??= this.createService(registered.registration);
    return registered.service;
  }

  clear(): void {
    this.byConfigurationId.clear();
    this.configurationIdByRoot.clear();
  }

  async getStatus(request: SupportStatusRequest): Promise<SupportStatusOutcome> {
    const service = this.get(request.configurationId);
    return service ? service.getStatus(request) : operationRejected();
  }

  async getMasterStatus(request: SupportMasterStatusRequest): Promise<SupportMasterStatusOutcome> {
    const service = this.get(request.configurationId);
    return service ? service.getMasterStatus(request) : operationRejected();
  }

  async setObjectMode(request: SupportMutationRequest): Promise<SupportModeMutationOutcome> {
    const service = this.get(request.configurationId);
    return service ? service.setObjectMode(request) : operationRejected();
  }

  async enableObjectRules(request: EnableObjectRulesRequest): Promise<SupportModeMutationOutcome> {
    const service = this.get(request.configurationId);
    return service ? service.enableObjectRules(request) : operationRejected();
  }

  async sync(request: SupportSyncOperationRequest): Promise<SupportSyncOperationOutcome> {
    const service = this.get(request.configurationId);
    return service ? service.sync(request) : operationRejected();
  }

  async verify(request: SupportVerifyOperationRequest): Promise<SupportVerifyOperationOutcome> {
    const service = this.get(request.configurationId);
    return service ? service.verify(request) : operationRejected();
  }

  async getLastRun(request: SupportGetLastRunRequest): Promise<SupportGetLastRunOutcome> {
    const service = this.get(request.configurationId);
    return service ? service.getLastRun(request) : operationRejected();
  }
}

function normalizeRegistration(
  registration: SupportConfigurationRegistration,
): SupportConfigurationRegistration {
  if (
    !registration.configurationId
    || !registration.configRoot.trim()
    || !registration.workspaceFolderName.trim()
    || !registration.configRelativePath.trim()
  ) {
    throw new Error('Support configuration registration is incomplete.');
  }
  return Object.freeze({
    configurationId: registration.configurationId,
    configRoot: path.resolve(registration.configRoot.trim()),
    workspaceFolderName: registration.workspaceFolderName.trim(),
    configRelativePath: normalizeConfigRelativePath(registration.configRelativePath.trim()),
  });
}

function registrationsEqual(
  left: SupportConfigurationRegistration,
  right: SupportConfigurationRegistration,
): boolean {
  return normalizeRootKey(left.configRoot) === normalizeRootKey(right.configRoot)
    && left.workspaceFolderName === right.workspaceFolderName
    && left.configRelativePath === right.configRelativePath;
}

function normalizeRootKey(configRoot: string): string {
  const resolved = path.resolve(configRoot);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}

function operationRejected(): SupportOperationRejectedOutcome {
  return {
    status: 'operationRejected',
    errorCode: 'SUPPORT_OPERATION_FAILED',
    retryable: true,
  };
}
