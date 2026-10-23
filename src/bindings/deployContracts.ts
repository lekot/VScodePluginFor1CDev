import type * as vscode from 'vscode';
import type { ConfigurationBinding } from './models/configurationBinding';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';
import type { InfobaseStorageService } from '../infobases/infobaseStorageService';
import type { runInfobaseConfigIncrementalImport, runInfobaseConfigExportObjects } from '../infobases/infobaseConfigCommands';
import type { DeploySupportPreflightErrorCode } from './deployLockedObjectsFilter';
import type { TreeNode } from '../models/treeNode';
import type { ConfigurationId } from '../services/configurationSession/types';
import type { SupportApplicationFacade } from '../support/supportApplicationServiceRegistry';
import type { ProcessTreeTerminationOutcome } from '../services/ibcmd/processTreeTermination';
import type { runIbcmdXmlImportPreflight } from '../services/ibcmdXmlPreflightService';

export type DeployItemStatus = 'success' | 'error' | 'inDoubt' | 'skipped';

export interface DeployItemResult {
  readonly infobaseId: string;
  readonly name: string;
  readonly status: DeployItemStatus;
  readonly message: string;
  readonly errorCode?: DeployItemErrorCode;
  readonly skippedFiles?: readonly string[];
  /** True when an import may have changed the target despite an uncertain outcome. */
  readonly effectPossible?: boolean;
  readonly termination?: ProcessTreeTerminationOutcome;
}

export interface DeployRunSummary {
  readonly results: DeployItemResult[];
  readonly successCount: number;
  readonly errorCount: number;
  /** Imports whose effects may have occurred but could not be confirmed. */
  readonly inDoubtCount: number;
  /** Предпролётные пропуски, веб-базы, отмена и т.п. */
  readonly skippedCount: number;
  /** At least one target omitted concrete requested files from its result. */
  readonly hasPartial: boolean;
  /** Пользователь отменил во время цепочки — дальнейшие базы не запускались. */
  readonly cancelledMidChain: boolean;
}

export interface DeployProgressSink {
  report(value: { message?: string; increment?: number }): void;
}

export type DeploySupportErrorCode =
  | DeploySupportPreflightErrorCode
  | 'SUPPORT_DEPLOY_TARGET_NOT_REPLICATED' | 'SUPPORT_BINDING_INVALID' | 'SUPPORT_TARGET_UNSUPPORTED'
  | 'SUPPORT_FILE_MISSING' | 'SUPPORT_NOT_MANAGED' | 'SUPPORT_REPLICATION_FAILED'
  | 'SUPPORT_REPLICATION_INCOMPLETE' | 'SUPPORT_TARGET_SELECTION_REJECTED';

export type DeployItemErrorCode = DeploySupportErrorCode | 'DEPLOY_OPERATION_IN_DOUBT';

/** Exact support facade/identity pair supplied by UI and Agent composition roots. */
export interface DeploySupportContext {
  readonly configurationId: ConfigurationId;
  readonly facade: Pick<SupportApplicationFacade, 'getStatus' | 'getMasterStatus' | 'sync'>;
}

export type DeployMode = 'copy' | 'block';

export interface DeploySelectedObjectsParams {
  binding: ConfigurationBinding;
  workspaceFolderRoot: string;
  storage: InfobaseStorageService;
  catalog: readonly InfobaseEntry[];
  selectedNodes: readonly TreeNode[];
  progress: DeployProgressSink;
  token: vscode.CancellationToken;
  support?: DeploySupportContext;
  onOutput?: (chunk: string) => void;
}

export interface DeployChangedFilesParams {
  binding: ConfigurationBinding;
  workspaceFolderRoot: string;
  storage: InfobaseStorageService;
  catalog: readonly InfobaseEntry[];
  relativeFiles: readonly string[];
  progress: DeployProgressSink;
  token: vscode.CancellationToken;
  support?: DeploySupportContext;
  onOutput?: (chunk: string) => void;
}

export interface PullSelectedObjectsParams {
  binding: ConfigurationBinding;
  workspaceFolderRoot: string;
  storage: InfobaseStorageService;
  entry: InfobaseEntry;
  selectedNodes: readonly TreeNode[];
  progress: DeployProgressSink;
  token: vscode.CancellationToken;
  onOutput?: (chunk: string) => void;
  runConfigurationMutation?: <T>(resourcePath: string, kind: string, operation: () => Promise<T>) => Promise<T>;
}

export interface DeployServiceDeps {
  runXmlPreflight?: typeof runIbcmdXmlImportPreflight;
  runIncrementalImport?: typeof runInfobaseConfigIncrementalImport;
  runConfigurationExportObjects?: typeof runInfobaseConfigExportObjects;
  runConfigurationMutation?: <T>(resourcePath: string, kind: string, operation: () => Promise<T>) => Promise<T>;
}
