import type { ConfigFormat } from '../../parsers/formatDetector';

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
  readonly workspaceFolderUris: readonly string[];
  readonly format: ConfigFormat;
  readonly capabilities: ConfigurationCapabilities;
}

export interface ConfigurationDescriptor extends ConfigurationIdentity {
  readonly label: string;
  readonly health: 'ready' | 'degraded';
}
