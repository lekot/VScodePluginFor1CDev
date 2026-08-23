import type { ConfigurationSession } from '../../services/configurationSession/ConfigurationSession';
import type { ConfigurationId } from '../../services/configurationSession/types';

export const CFE_PROJECT_MANIFEST_VERSION = 1 as const;

export interface CfeProjectManifestRecord {
  readonly baseConfiguration: string;
  readonly extensionConfiguration: string;
  readonly extensionName: string;
}

export interface CfeProjectManifestV1 {
  readonly version: typeof CFE_PROJECT_MANIFEST_VERSION;
  readonly projects: readonly CfeProjectManifestRecord[];
}

export type CfeProjectPurpose = 'Customization' | 'Patch' | 'AddOn';

export interface CfeProjectContext {
  readonly baseSession: ConfigurationSession;
  readonly extensionSession: ConfigurationSession;
  readonly baseRoot: string;
  readonly extensionRoot: string;
  readonly extensionName: string;
  readonly purpose: CfeProjectPurpose;
  readonly namePrefix: string;
  readonly formatVersion: string;
  readonly compatibilityMode: string;
  readonly baseConfigurationUuid: string;
  readonly baseFingerprint: string;
}

export interface CfeCreateProjectRequest {
  readonly baseConfigurationId: ConfigurationId | string;
  readonly extensionName: string;
  readonly purpose: CfeProjectPurpose;
  readonly namePrefix: string;
  readonly compatibilityMode: string;
  /** Workspace-relative directory. Defaults to ConfigurationExtensions/<extensionName> beside the base root. */
  readonly target?: string;
  readonly includeDefaultRole?: boolean;
}

export interface CfeCreateProjectOutcome {
  readonly status: 'created' | 'outcome-unknown';
  readonly context?: CfeProjectContext;
  readonly code?: 'CFE_OUTCOME_UNKNOWN';
  readonly recoveryJournalPath?: string;
}

export class CfeProjectError extends Error {
  constructor(
    readonly code:
      | 'CFE_PROJECT_NOT_FOUND'
      | 'CFE_RELATION_AMBIGUOUS'
      | 'CFE_UNSUPPORTED_FORMAT'
      | 'CFE_VALIDATION_FAILED'
      | 'CFE_OUTCOME_UNKNOWN',
    message: string,
  ) {
    super(message);
    this.name = 'CfeProjectError';
  }
}
