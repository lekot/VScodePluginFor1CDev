import type { StreamCancellation } from '../process/streamingProcessRunner';

export interface ExternalProcessorCredentials {
  readonly user?: string;
  readonly password?: string;
}

export type ExternalProcessorExecutionContext =
  | {
      readonly kind: 'infobase';
      readonly infobasePath: string;
      readonly credentials?: ExternalProcessorCredentials;
    }
  | {
      readonly kind: 'standalone';
      readonly acknowledgeTypeLoss: true;
    };

interface ExternalProcessorOperationOptionsBase {
  readonly context: ExternalProcessorExecutionContext;
  readonly timeoutMs?: number;
  readonly cancellation?: StreamCancellation;
}

export interface DumpExternalProcessorOptions extends ExternalProcessorOperationOptionsBase {
  readonly externalFilePath: string;
  readonly outputDirectory: string;
  readonly format: 'Plain' | 'Hierarchical';
}

export interface BuildExternalProcessorOptions extends ExternalProcessorOperationOptionsBase {
  readonly rootXmlPath: string;
  readonly destinationPath?: string;
}

export type ExternalProcessorFailedErrorCode =
  | 'EXTERNAL_CONTEXT_INVALID'
  | 'EXTERNAL_INPUT_MISSING'
  | 'EXTERNAL_INPUT_NOT_FILE'
  | 'EXTERNAL_EXTENSION_UNSUPPORTED'
  | 'EXTERNAL_ROOT_UNSUPPORTED'
  | 'EXTERNAL_OUTPUT_EXISTS'
  | 'CONFIGURATOR_UNAVAILABLE'
  | 'CONFIGURATOR_FAILED'
  | 'EXTERNAL_POSTCONDITION_FAILED'
  | 'EXTERNAL_PUBLISH_CONFLICT'
  | 'EXTERNAL_PUBLISH_UNAVAILABLE'
  | 'EXTERNAL_RECOVERY_REQUIRED'
  | 'EXTERNAL_IO_FAILED';

export type ExternalProcessorInDoubtErrorCode =
  | 'CONFIGURATOR_IN_DOUBT'
  | 'EXTERNAL_POSTCONDITION_IN_DOUBT';

export type ExternalProcessorErrorCode =
  | ExternalProcessorFailedErrorCode
  | ExternalProcessorInDoubtErrorCode;

export type ExternalProcessorOperationResult =
  | {
      readonly state: 'completed';
      readonly artifactPath: string;
      readonly rootXmlPath?: string;
      readonly warning?: string;
      readonly combinedLog: string;
    }
  | {
      readonly state: 'failed';
      readonly code: ExternalProcessorFailedErrorCode;
      readonly message: string;
      readonly retryable: boolean;
      readonly effectPossible: boolean;
      readonly combinedLog: string;
    }
  | {
      readonly state: 'inDoubt';
      readonly code: ExternalProcessorInDoubtErrorCode;
      readonly message: string;
      readonly retryable: false;
      readonly effectPossible: true;
      readonly stagingPath: string;
      /** Set when publication may already have made the canonical destination visible. */
      readonly publishedArtifactPath?: string;
      readonly combinedLog: string;
      readonly processErrorCode?: string;
    };

export interface ExternalProcessorRootInspection {
  readonly kind: 'ExternalDataProcessor' | 'ExternalReport';
  readonly extension: '.epf' | '.erf';
  readonly defaultDestinationPath: string;
}
