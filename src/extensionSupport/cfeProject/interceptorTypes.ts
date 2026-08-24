import type { ConfigurationId } from '../../services/configurationSession/types';
import type { CfeProjectErrorCode } from './types';

/** Kinds supported by the first structural CFE interceptor vertical. */
export type CfeInterceptorKind = 'before' | 'after' | 'instead' | 'changeAndValidate';

/** Designer module file kinds supported by the first CFE interceptor vertical. */
export type CfeModuleKind =
  | 'Module'
  | 'ObjectModule'
  | 'ManagerModule'
  | 'RecordSetModule'
  | 'ValueManagerModule';

/**
 * Creates one interceptor for an already adopted CFE root object.
 * `targetSourceUuid` is the identity in the linked main configuration, never a path.
 */
export interface CfeCreateInterceptorRequest {
  readonly extensionConfigurationId: ConfigurationId | string;
  readonly targetSourceUuid: string;
  readonly moduleKind: CfeModuleKind;
  readonly methodName: string;
  readonly kind: CfeInterceptorKind;
  /** SHA-256 of the canonical source-method text. Required for changeAndValidate. */
  readonly expectedSourceHash?: string;
}

export interface CfeCreateInterceptorOutcome {
  readonly status: 'created' | 'already-exists';
  readonly targetType: string;
  readonly targetName: string;
  readonly targetSourceUuid: string;
  readonly moduleKind: CfeModuleKind;
  readonly methodName: string;
  readonly interceptorName: string;
  /** Extension-relative Designer module path, never an absolute workspace path. */
  readonly modulePath: string;
  /** SHA-256 of the canonical source-method text used to generate the interceptor. */
  readonly sourceHash: string;
  readonly propertyStateUpdated: boolean;
}

/** Stable CFE error codes surfaced by the shared Agent/MCP error union. */
export type CfeInterceptorErrorCode = CfeProjectErrorCode;

/** Structural interceptor conflict that must never overwrite user code. */
export class CfeInterceptorError extends Error {
  constructor(
    readonly code: Extract<CfeInterceptorErrorCode, 'CFE_INTERCEPTOR_CONFLICT'>,
    message: string,
  ) {
    super(message);
    this.name = 'CfeInterceptorError';
  }
}
