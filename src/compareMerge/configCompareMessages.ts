import type { CompareTreeNode, CompareTreeStats } from './compareTreeTypes';
import type { CompareMessage } from './domain/compareContracts';
import type { CompareJoinStrategy, WorkspacePreviewDto } from './configurationCompareWorkspace';

export type ConfigCompareWebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'setStrategy'; strategy: CompareJoinStrategy }
  | { type: 'selectionChanged'; nodeIds: string[] }
  | { type: 'createPreview'; nodeIds: string[] }
  | { type: 'approvePreview'; previewId: string }
  | { type: 'executeMerge'; previewId: string }
  | { type: 'refresh' };

export interface ConfigCompareWebviewPayloadDto {
  title: string;
  root: CompareTreeNode;
  stats: CompareTreeStats;
  locked: boolean;
  strategy: CompareJoinStrategy;
  executableNodeIds: string[];
}

export interface ConfigComparePreviewDto extends WorkspacePreviewDto {
  approved?: boolean;
}

export interface ConfigCompareAppliedOperationDto {
  operationId: string;
  kind: string;
  code?: string;
  message?: string;
}

export type ConfigCompareHostToWebviewMessage =
  | {
      type: 'state';
      payload: ConfigCompareWebviewPayloadDto;
      selectedNodeIds: string[];
      executableNodeIds: string[];
      canCreatePreview: boolean;
      busy: boolean;
      locked: boolean;
      diagnostics: CompareMessage[];
      preview?: ConfigComparePreviewDto;
    }
  | (ConfigComparePreviewDto & { type: 'previewReady' })
  | {
      type: 'mergeSuccess';
      applied: ConfigCompareAppliedOperationDto[];
      backupPaths: string[];
      payload: ConfigCompareWebviewPayloadDto;
      locked: boolean;
      diagnostics: CompareMessage[];
    }
  | {
      type: 'mergeError';
      message: string;
      diagnostics: CompareMessage[];
      locked: boolean;
      backupPaths?: string[];
    };
