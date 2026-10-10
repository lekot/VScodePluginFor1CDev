import type { ConfigFormat } from '../../parsers/formatDetector';
import type { ConfigurationSession } from './ConfigurationSession';

declare const configurationIdBrand: unique symbol;
export type ConfigurationId = string & { readonly [configurationIdBrand]: true };

export interface ConfigurationCapabilities {
  readonly read: boolean;
  readonly write: boolean;
  readonly process: boolean;
}

export interface ConfigurationIdentity {
  readonly configurationId: ConfigurationId;
  readonly rootPath: string;
  readonly rootUri: string;
  readonly descriptorUri: string;
  readonly descriptorUuid?: string;
  readonly workspaceFolderUris: readonly string[];
  readonly format: ConfigFormat;
  readonly capabilities: ConfigurationCapabilities;
}

export interface ConfigurationDescriptor extends ConfigurationIdentity {
  readonly label: string;
  readonly health: 'ready' | 'degraded';
}

/**
 * Resolved immutable application context representing an active configuration boundary.
 * Acquired at boundary entrypoints (selected TreeNode, Agent params, file path/URI, watcher event)
 * and passed down to use-cases without repeating root discovery or using service locators.
 */
export interface ConfigurationContext {
  readonly configurationId: ConfigurationId;
  readonly rootPath: string;
  readonly rootUri: string;
  readonly workspaceFolderUri: string;
  readonly format: ConfigFormat;
  readonly capabilities: ConfigurationCapabilities;
  readonly descriptorUri: string;
  readonly descriptorUuid?: string;
  readonly session: ConfigurationSession;
}
