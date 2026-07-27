import type { ConfigurationId } from '../services/configurationSession/types';
import type { SupportApplicationFacade } from '../support/supportApplicationServiceRegistry';
import type {
  SupportGetLastRunOutcome,
  SupportModeMutationOutcome,
  SupportStatusOutcome,
  SupportSyncOperationOutcome,
  SupportVerifyOperationOutcome,
} from '../support/supportTypes';
import type {
  AgentResult,
  AgentSupportEnableObjectRulesParams,
  AgentSupportGetLastRunParams,
  AgentSupportGetStatusParams,
  AgentSupportSetObjectModeParams,
  AgentSupportSyncParams,
  AgentSupportVerifyParams,
} from './types';

export const AGENT_SUPPORT_COMMAND_IDS = Object.freeze({
  getStatus: '1c-metadata-tree.agent.supportGetStatus',
  setObjectMode: '1c-metadata-tree.agent.supportSetObjectMode',
  enableObjectRules: '1c-metadata-tree.agent.supportEnableObjectRules',
  sync: '1c-metadata-tree.agent.supportSync',
  verify: '1c-metadata-tree.agent.supportVerify',
  getLastRun: '1c-metadata-tree.agent.supportGetLastRun',
} as const);

export type AgentSupportOperationName =
  | 'supportGetStatus'
  | 'supportSetObjectMode'
  | 'supportEnableObjectRules'
  | 'supportSync'
  | 'supportVerify'
  | 'supportGetLastRun';

export const AGENT_SUPPORT_COMMAND_REGISTRATIONS = Object.freeze([
  { operation: 'supportGetStatus', command: AGENT_SUPPORT_COMMAND_IDS.getStatus },
  { operation: 'supportSetObjectMode', command: AGENT_SUPPORT_COMMAND_IDS.setObjectMode },
  { operation: 'supportEnableObjectRules', command: AGENT_SUPPORT_COMMAND_IDS.enableObjectRules },
  { operation: 'supportSync', command: AGENT_SUPPORT_COMMAND_IDS.sync },
  { operation: 'supportVerify', command: AGENT_SUPPORT_COMMAND_IDS.verify },
  { operation: 'supportGetLastRun', command: AGENT_SUPPORT_COMMAND_IDS.getLastRun },
] as const satisfies readonly {
  readonly operation: AgentSupportOperationName;
  readonly command: string;
}[]);

type JsonSafe<T> =
  T extends ReadonlyMap<string, infer TValue>
    ? Readonly<Record<string, JsonSafe<TValue>>>
    : T extends readonly (infer TItem)[]
      ? readonly JsonSafe<TItem>[]
      : T extends object
        ? { readonly [TKey in keyof T]: JsonSafe<T[TKey]> }
        : T;

export type AgentSupportResult<T> = AgentResult<JsonSafe<T>> & {
  readonly data: JsonSafe<T>;
};

export interface AgentSupportOperationsDeps {
  readonly facade: SupportApplicationFacade;
}

/**
 * JSON-safe Agent boundary over the six public support facade operations.
 * It owns no parser, store, coordinator, binding, process or mutation logic.
 */
export class AgentSupportOperations {
  constructor(private readonly deps: AgentSupportOperationsDeps) {}

  async supportGetStatus(
    params: AgentSupportGetStatusParams,
  ): Promise<AgentSupportResult<SupportStatusOutcome>> {
    const outcome = await this.deps.facade.getStatus({
      configurationId: asConfigurationId(params.configurationId),
      ...(params.objectIds === undefined ? {} : { objectIds: params.objectIds }),
    });
    return toAgentResult(outcome, outcome.status === 'available');
  }

  async supportSetObjectMode(
    params: AgentSupportSetObjectModeParams,
  ): Promise<AgentSupportResult<SupportModeMutationOutcome>> {
    const outcome = await this.deps.facade.setObjectMode({
      configurationId: asConfigurationId(params.configurationId),
      objectId: params.objectId,
      targetMode: params.targetMode,
      expectedGenerationId: params.expectedGenerationId,
    });
    return toAgentResult(outcome, outcome.status === 'synchronized');
  }

  async supportEnableObjectRules(
    params: AgentSupportEnableObjectRulesParams,
  ): Promise<AgentSupportResult<SupportModeMutationOutcome>> {
    const outcome = await this.deps.facade.enableObjectRules({
      configurationId: asConfigurationId(params.configurationId),
      targetObjectId: params.targetObjectId,
      targetMode: params.targetMode,
      expectedGenerationId: params.expectedGenerationId,
      expectedMetadataUniverseGenerationId: params.expectedMetadataUniverseGenerationId,
    });
    return toAgentResult(outcome, outcome.status === 'synchronized');
  }

  async supportSync(
    params: AgentSupportSyncParams,
  ): Promise<AgentSupportResult<SupportSyncOperationOutcome>> {
    const outcome = await this.deps.facade.sync({
      configurationId: asConfigurationId(params.configurationId),
      targets: params.targets,
      ...(params.verification === undefined ? {} : { verification: params.verification }),
    });
    return toAgentResult(outcome, outcome.status === 'synchronized');
  }

  async supportVerify(
    params: AgentSupportVerifyParams,
  ): Promise<AgentSupportResult<SupportVerifyOperationOutcome>> {
    const outcome = await this.deps.facade.verify({
      configurationId: asConfigurationId(params.configurationId),
      targets: params.targets,
    });
    return toAgentResult(outcome, outcome.status === 'synchronized');
  }

  async supportGetLastRun(
    params: AgentSupportGetLastRunParams,
  ): Promise<AgentSupportResult<SupportGetLastRunOutcome>> {
    const outcome = await this.deps.facade.getLastRun({
      configurationId: asConfigurationId(params.configurationId),
    });
    return toAgentResult(outcome, outcome.status === 'available');
  }
}

function asConfigurationId(configurationId: string): ConfigurationId {
  return configurationId as ConfigurationId;
}

function toAgentResult<T extends { readonly status: string }>(
  outcome: T,
  success: boolean,
): AgentSupportResult<T> {
  const data = toJsonSafe(outcome);
  if (success) {
    return { success: true, data };
  }
  return {
    success: false,
    data,
    code: outcomeErrorCode(outcome),
    error: `Support operation completed with status ${outcome.status}.`,
  };
}

function outcomeErrorCode(outcome: { readonly status: string }): string {
  if (
    'errorCode' in outcome
    && typeof outcome.errorCode === 'string'
  ) {
    return outcome.errorCode;
  }
  if (
    'preflight' in outcome
    && isRecord(outcome.preflight)
    && outcome.preflight.accepted === false
    && typeof outcome.preflight.errorCode === 'string'
  ) {
    return outcome.preflight.errorCode;
  }
  return 'SUPPORT_OPERATION_FAILED';
}

function toJsonSafe<T>(value: T): JsonSafe<T> {
  const serialized = JSON.stringify(value, (_key: string, candidate: unknown) => {
    return candidate instanceof Map
      ? Object.fromEntries(candidate)
      : candidate;
  });
  return JSON.parse(serialized) as JsonSafe<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
