import type { TreeNode } from '../../models/treeNode';
import type { InfobaseEntry } from '../../infobases/models/infobaseEntry';
import type { ConfiguratorCredentials } from '../configurator/configuratorBatchArgs';

export type RepositoryConfigurationKind = 'cf' | 'cfe';

export interface RepositoryTarget {
  readonly configRoot: string;
  readonly configKind: RepositoryConfigurationKind;
  readonly extensionName?: string;
  readonly key: string;
}

export interface RepositoryBinding {
  readonly repositoryPath: string;
  readonly repositoryUser: string;
  /** Catalog id of the file infobase used to execute every later repository command. */
  readonly executionInfobaseId: string;
}

export interface RepositoryBindingWithPassword extends RepositoryBinding {
  readonly repositoryPassword?: string;
}

export type RepositoryConnectionState = 'connected' | 'disconnected' | 'unknown';
export type RepositoryLockState = 'heldByCurrentCredentials' | 'unlocked' | 'unknown';

export interface RepositoryObservedState {
  readonly connection: RepositoryConnectionState;
  readonly locks: Readonly<Record<string, RepositoryLockState>>;
  readonly lastConfirmedAt?: string;
  readonly source: 'configuratorAcknowledgement' | 'unknown';
}

export interface RepositoryObjectReference {
  readonly target: RepositoryTarget;
  /** Root metadata node that the repository command addresses. */
  readonly ownerNode: TreeNode;
  /** 1C configuration repository full name (Russian type prefix). */
  readonly repositoryFullName: string;
  /** ibcmd object identifier used when synchronising XML back from the IB. */
  readonly ibcmdFullName: string;
  /** Files on disk belonging to the owner object. */
  readonly relativeFiles: readonly string[];
}

export type ConfigurationRepositoryOperation =
  | 'bind'
  | 'unbind'
  | 'lock'
  | 'unlock'
  | 'commit'
  | 'updateObject'
  | 'updateConfiguration';

export interface ConfigurationRepositoryTransportRequest {
  readonly operation: ConfigurationRepositoryOperation;
  readonly target: RepositoryTarget;
  readonly binding: RepositoryBindingWithPassword;
  readonly infobase: InfobaseEntry;
  readonly infobaseCredentials?: ConfiguratorCredentials;
  readonly objectListPath?: string;
  readonly comment?: string;
  readonly keepLocked?: boolean;
  readonly force?: boolean;
  readonly cancellation: RepositoryCancellation;
}

export interface RepositoryCancellation {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested: (listener: () => void) => { dispose(): void };
}

export type ConfigurationRepositoryTransportOutcome =
  | {
      readonly status: 'acknowledged';
      readonly operation: ConfigurationRepositoryOperation;
      readonly log: string;
    }
  | {
      readonly status: 'failed';
      readonly operation: ConfigurationRepositoryOperation;
      readonly errorCode: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly log: string;
    }
  | {
      readonly status: 'inDoubt';
      readonly operation: ConfigurationRepositoryOperation;
      readonly errorCode: string;
      readonly message: string;
      readonly log: string;
    };

export interface RepositoryServiceResult {
  readonly status: 'acknowledged' | 'failed' | 'inDoubt' | 'cancelled';
  readonly message: string;
  readonly target: RepositoryTarget;
  readonly affectedFullNames: readonly string[];
  readonly synchronizedFiles?: readonly string[];
}
