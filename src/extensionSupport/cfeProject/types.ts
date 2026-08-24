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

/** Identifies exactly one root object in the main configuration to borrow. */
export interface CfeBorrowObjectRequest {
  readonly extensionConfigurationId: ConfigurationId | string;
  /** Root metadata path in the form `Catalog.Products`. Mutually exclusive with sourceUuid. */
  readonly sourceDotPath?: string;
  /** UUID of a root metadata object in the linked main configuration. Mutually exclusive with sourceDotPath. */
  readonly sourceUuid?: string;
}

export interface CfeBorrowObjectOutcome {
  readonly status: 'borrowed' | 'already-borrowed';
  readonly type: string;
  readonly name: string;
  readonly sourceUuid: string;
  /** Extension-relative Designer path, never an absolute workspace path. */
  readonly objectPath: string;
  readonly localUuid: string;
}

export type CfeProjectErrorCode =
  | 'CFE_PROJECT_NOT_FOUND'
  | 'CFE_RELATION_AMBIGUOUS'
  | 'CFE_UNSUPPORTED_FORMAT'
  | 'CFE_SOURCE_CHANGED'
  | 'CFE_SOURCE_OBJECT_NOT_FOUND'
  | 'CFE_OWNERSHIP_INVALID'
  | 'CFE_ADOPTED_OPERATION_REQUIRED'
  | 'CFE_DEPENDENCY_UNSUPPORTED'
  | 'CFE_INTERCEPTOR_CONFLICT'
  | 'CFE_FORM_ID_EXHAUSTED'
  | 'CFE_VALIDATION_FAILED'
  | 'CFE_OUTCOME_UNKNOWN';

export class CfeProjectError extends Error {
  constructor(
    readonly code: CfeProjectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CfeProjectError';
  }
}
