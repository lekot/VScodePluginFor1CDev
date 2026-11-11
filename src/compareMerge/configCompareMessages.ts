import type { CompareTreeStats } from './compareTreeTypes';
import type { CompareDisplayNode } from './projection/compareDisplayTree';
import type { CompareMessage } from './domain/compareContracts';
import type {
  CompareJoinStrategy,
  ConfigurationCompareInfo,
  WorkspacePreviewDto,
  WorkspacePreviewItemDto,
} from './configurationCompareWorkspace';
import type { MutationFailureProjection } from '../services/configurationSession/mutationReceiptError';

export type ConfigCompareWebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'cancel' }
  | { type: 'retry' }
  | { type: 'close' }
  | { type: 'setStrategy'; strategy: CompareJoinStrategy }
  | { type: 'selectionChanged'; nodeIds: string[] }
  | { type: 'createPreview'; nodeIds: string[] }
  | { type: 'approvePreview'; previewId: string }
  | { type: 'executeMerge'; previewId: string; destructiveConfirmed?: boolean }
  | { type: 'refresh' };

export interface ConfigCompareWebviewPayloadDto {
  title: string;
  targetLabel: string;
  sourceLabel: string;
  root: CompareDisplayNode;
  stats: CompareTreeStats;
  locked: boolean;
  strategy: CompareJoinStrategy;
  executableNodeIds: string[];
  comparisonInfo?: ConfigurationCompareInfo;
}

export interface ConfigComparePreviewItemDto extends WorkspacePreviewItemDto {
  destructive?: boolean;
}

export interface ConfigComparePreviewDto extends Omit<WorkspacePreviewDto, 'items'> {
  items: ConfigComparePreviewItemDto[];
  destructiveCount: number;
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
      type: 'loadState';
      generation: number;
      status: 'loading' | 'ready' | 'cancelled' | 'error';
      phase?: 'detecting' | 'metadata' | 'inventory' | 'bsl' | 'comparing' | 'projecting';
      completed?: number;
      total?: number;
      partial?: boolean;
      payload?: ConfigCompareWebviewPayloadDto;
      error?: string;
      retryAvailable?: boolean;
    }
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
      mutationFailure?: MutationFailureProjection;
    };
