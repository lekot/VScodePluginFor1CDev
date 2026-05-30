import * as path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';

import type { CompareTreeNode, CompareTreeStats } from './compareTreeTypes';
import type { CompareTreeProjection } from './projection/compareTreeProjection';
import { CompareSession } from './domain/compareSession';
import type { CompareMessage, CompareSide } from './domain/compareContracts';
import {
  createMergePreview,
  validateMergePreflight,
  type BackupPlan,
  type MergeCandidate,
  type MergePreview,
  type PreflightResult,
  type RollbackPlan,
} from './merge/mergePlanner';
import {
  executeBslMergePreview,
  type MergeExecutionResult,
  type MergeExecutorInput,
} from './merge/mergeExecutor';

const LEFT_SOURCE_ID = 'left-source';

export interface ConfigCompareWebviewPayload {
  root: CompareTreeNode;
  stats: CompareTreeStats;
  sourceRoots: {
    left: string;
    right: string;
  };
  locked: boolean;
}

export interface WorkspaceSelectionState {
  selectedNodeIds: string[];
  executableNodeIds: string[];
  canCreatePreview: boolean;
  diagnostics: CompareMessage[];
}

export interface WorkspacePreviewItemDto {
  nodeId: string;
  label: string;
  kind: string;
  status: CompareTreeNode['status'];
}

export interface WorkspacePreviewDto {
  previewId: string;
  summary: string;
  operationCount: number;
  items: WorkspacePreviewItemDto[];
  diagnostics: CompareMessage[];
}

export type WorkspacePreviewResult =
  | {
      ok: true;
      preview: WorkspacePreviewDto;
      diagnostics: [];
    }
  | {
      ok: false;
      diagnostics: CompareMessage[];
    };

export type WorkspaceApprovalResult =
  | {
      ok: true;
      preview: WorkspacePreviewDto;
      diagnostics: [];
    }
  | {
      ok: false;
      diagnostics: CompareMessage[];
    };

export type WorkspaceExecutionResult =
  | {
      ok: true;
      result: MergeExecutionResult;
      payload: ConfigCompareWebviewPayload;
      locked: boolean;
      diagnostics: CompareMessage[];
    }
  | {
      ok: false;
      locked: boolean;
      diagnostics: CompareMessage[];
      result?: MergeExecutionResult;
    };

export type WorkspaceRefreshResult =
  | {
      ok: true;
      payload: ConfigCompareWebviewPayload;
      locked: false;
      diagnostics: [];
    }
  | {
      ok: false;
      payload: ConfigCompareWebviewPayload;
      locked: true;
      diagnostics: CompareMessage[];
    };

export type ExecutableCandidateFactoryResult =
  | {
      ok: true;
      candidate: MergeCandidate;
    }
  | {
      ok: false;
      diagnostics: CompareMessage[];
    };

export type ExecutableCandidateFactory = () => Promise<ExecutableCandidateFactoryResult>;

export interface ConfigurationCompareWorkspaceState {
  session: CompareSession;
  projection: CompareTreeProjection;
  candidateFactories: ReadonlyMap<string, ExecutableCandidateFactory>;
}

export interface ConfigurationCompareWorkspaceInput extends ConfigurationCompareWorkspaceState {
  leftRootPath: string;
  rightRootPath: string;
  createdAt?: Date;
  backupRootPath: string;
  refreshWorkspace?: () => Promise<ConfigurationCompareWorkspaceState>;
  createPreview?: typeof createMergePreview;
  validatePreflight?: typeof validateMergePreflight;
  executeMerge?: (input: MergeExecutorInput) => Promise<MergeExecutionResult>;
}

interface PreviewRecord {
  preview: MergePreview;
  redacted: WorkspacePreviewDto;
  approved: boolean;
}

export class ConfigurationCompareWorkspace {
  private session: CompareSession;
  private projection: CompareTreeProjection;
  private readonly leftRootPath: string;
  private readonly rightRootPath: string;
  private readonly createdAt: Date;
  private readonly backupRootPath: string;
  private readonly refreshWorkspace?: () => Promise<ConfigurationCompareWorkspaceState>;
  private readonly createPreview: typeof createMergePreview;
  private readonly validatePreflight: typeof validateMergePreflight;
  private readonly executeMerge: (input: MergeExecutorInput) => Promise<MergeExecutionResult>;
  private readonly previewRecords = new Map<string, PreviewRecord>();
  private candidateFactories: Map<string, ExecutableCandidateFactory>;
  private previewCounter = 0;
  private disposed = false;
  private locked = false;

  constructor(input: ConfigurationCompareWorkspaceInput) {
    this.session = input.session;
    this.projection = input.projection;
    this.leftRootPath = input.leftRootPath;
    this.rightRootPath = input.rightRootPath;
    this.createdAt = input.createdAt ?? new Date();
    this.backupRootPath = input.backupRootPath;
    this.refreshWorkspace = input.refreshWorkspace;
    this.createPreview = input.createPreview ?? createMergePreview;
    this.validatePreflight = input.validatePreflight ?? validateMergePreflight;
    this.executeMerge = input.executeMerge ?? executeBslMergePreview;
    this.candidateFactories = new Map(input.candidateFactories);
  }

  get payload(): ConfigCompareWebviewPayload {
    return {
      root: this.projection.root,
      stats: this.projection.stats,
      sourceRoots: {
        left: this.leftRootPath,
        right: this.rightRootPath,
      },
      locked: this.locked,
    };
  }

  selectNodeIds(nodeIds: readonly string[]): WorkspaceSelectionState {
    const executableNodeIds = nodeIds.filter((nodeId) => this.candidateFactories.has(nodeId));
    const diagnostics =
      executableNodeIds.length === 1 && nodeIds.length === 1
        ? []
        : [
            diagnostic(
              'CONFIG_COMPARE_SINGLE_EXECUTABLE_REQUIRED',
              'Выберите ровно один исполняемый узел сравнения перед построением preview.'
            ),
          ];

    return {
      selectedNodeIds: [...nodeIds],
      executableNodeIds,
      canCreatePreview: diagnostics.length === 0,
      diagnostics,
    };
  }

  listMergeableNodeIds(): string[] {
    return this.disposed ? [] : [...this.candidateFactories.keys()].sort();
  }

  async createPreviewForNodeIds(nodeIds: readonly string[]): Promise<WorkspacePreviewResult> {
    const unavailable = this.unavailableDiagnostic();
    if (unavailable) {
      return { ok: false, diagnostics: [unavailable] };
    }

    if (nodeIds.length !== 1) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            'CONFIG_COMPARE_SINGLE_EXECUTABLE_REQUIRED',
            'Выберите ровно один исполняемый узел сравнения перед построением preview.'
          ),
        ],
      };
    }

    const nodeId = nodeIds[0];
    const factory = this.candidateFactories.get(nodeId);
    if (!factory) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            'CONFIG_COMPARE_UNKNOWN_SELECTION',
            'Выбранный узел сравнения не зарегистрирован как исполняемый host-side кандидат merge.',
            nodeId
          ),
        ],
      };
    }

    const candidateResult = await factory();
    if (!candidateResult.ok) {
      return { ok: false, diagnostics: candidateResult.diagnostics.map(redactDiagnostic) };
    }

    const previewId = this.nextPreviewId();
    const validation = this.createPreview({
      session: this.session,
      previewId,
      targetSourceId: LEFT_SOURCE_ID,
      snapshotIds: currentSnapshotIds(this.session),
      createdAt: this.createdAt.toISOString(),
      candidates: [candidateResult.candidate],
      currentTargetHashes: currentTargetHashes([candidateResult.candidate]),
    });

    if (!validation.ok) {
      return { ok: false, diagnostics: validation.diagnostics.map(redactDiagnostic) };
    }

    const redacted = this.redactPreview(validation.preview);
    this.previewRecords.set(previewId, {
      preview: validation.preview,
      redacted,
      approved: false,
    });

    return {
      ok: true,
      preview: redacted,
      diagnostics: [],
    };
  }

  approvePreview(previewId: string): WorkspaceApprovalResult {
    const unavailable = this.unavailableDiagnostic();
    if (unavailable) {
      return { ok: false, diagnostics: [unavailable] };
    }

    const record = this.previewRecords.get(previewId);
    if (!record) {
      return {
        ok: false,
        diagnostics: [diagnostic('CONFIG_COMPARE_PREVIEW_NOT_FOUND', 'Preview недоступен.')],
      };
    }

    try {
      this.session.approvePreview(previewId);
    } catch (error) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            'CONFIG_COMPARE_PREVIEW_APPROVE_FAILED',
            error instanceof Error ? error.message : String(error)
          ),
        ],
      };
    }

    record.approved = true;
    return {
      ok: true,
      preview: record.redacted,
      diagnostics: [],
    };
  }

  async executeApprovedPreview(previewId: string): Promise<WorkspaceExecutionResult> {
    const unavailable = this.unavailableDiagnostic();
    if (unavailable) {
      return { ok: false, locked: this.locked, diagnostics: [unavailable] };
    }

    const record = this.previewRecords.get(previewId);
    if (!record) {
      return {
        ok: false,
        locked: this.locked,
        diagnostics: [diagnostic('CONFIG_COMPARE_PREVIEW_NOT_FOUND', 'Preview недоступен.')],
      };
    }
    if (!record.approved) {
      return {
        ok: false,
        locked: this.locked,
        diagnostics: [
          diagnostic(
            'CONFIG_COMPARE_PREVIEW_NOT_APPROVED',
            'Подтвердите текущий preview перед выполнением.'
          ),
        ],
      };
    }

    const preflight = this.buildPreflight(record.preview);
    if (!preflight.ok) {
      return {
        ok: false,
        locked: this.locked,
        diagnostics: preflight.diagnostics.map(redactDiagnostic),
      };
    }

    const result = await this.executeMerge({
      session: this.session,
      preflight,
    });
    const executionDiagnostics = result.diagnostics.map(redactDiagnostic);
    const ok = result.failed.length === 0;
    if (!ok) {
      const backupPaths = result.backupPaths.length > 0
        ? result.backupPaths
        : result.failed.map((failure) => failure.backupPath).filter(isDefined);
      return {
        ok: false,
        locked: this.locked,
        diagnostics: executionDiagnostics,
        result: {
          ...result,
          backupPaths,
        },
      };
    }

    const refreshResult = await this.refresh();
    if (!refreshResult.ok) {
      return {
        ok: true,
        result,
        payload: this.payload,
        locked: true,
        diagnostics: [
          ...executionDiagnostics,
          ...refreshResult.diagnostics,
        ],
      };
    }

    return {
      ok: true,
      result,
      payload: this.payload,
      locked: this.locked,
      diagnostics: executionDiagnostics,
    };
  }

  async refresh(): Promise<WorkspaceRefreshResult> {
    const unavailable = this.disposed
      ? diagnostic('CONFIG_COMPARE_WORKSPACE_DISPOSED', 'Workspace сравнения закрыт.')
      : undefined;
    if (unavailable) {
      return { ok: false, payload: this.payload, locked: true, diagnostics: [unavailable] };
    }

    this.invalidateVolatileState();
    if (!this.refreshWorkspace) {
      this.locked = true;
      return {
        ok: false,
        payload: this.payload,
        locked: true,
        diagnostics: [
          diagnostic(
            'CONFIG_COMPARE_REFRESH_UNAVAILABLE',
            'Refresh workspace сравнения недоступен в этом контексте.'
          ),
        ],
      };
    }

    try {
      const refreshed = await this.refreshWorkspace();
      this.session = refreshed.session;
      this.projection = refreshed.projection;
      this.candidateFactories = new Map(refreshed.candidateFactories);
      this.locked = false;
      return {
        ok: true,
        payload: this.payload,
        locked: false,
        diagnostics: [],
      };
    } catch (error) {
      this.locked = true;
      return {
        ok: false,
        payload: this.payload,
        locked: true,
        diagnostics: [
          diagnostic(
            'CONFIG_COMPARE_REFRESH_FAILED',
            error instanceof Error ? error.message : String(error)
          ),
        ],
      };
    }
  }

  dispose(): void {
    this.disposed = true;
    this.locked = true;
    this.invalidateVolatileState();
  }

  private buildPreflight(preview: MergePreview): PreflightResult {
    const backupPlan = this.createBackupPlan(preview);
    return this.validatePreflight({
      session: this.session,
      previewId: preview.previewId,
      approvedPreviewId: preview.previewId,
      currentTargetHashes: currentTargetHashes(preview.operations),
      backupPlan,
      rollbackPlan: this.createRollbackPlan(preview, backupPlan),
    });
  }

  private createBackupPlan(preview: MergePreview): BackupPlan {
    return {
      previewId: preview.previewId,
      strategy: 'copyBeforeWrite',
      items: preview.operations
        .filter((operation) => operation.targetUri && operation.expectedOldHash)
        .map((operation) => ({
          operationId: operation.operationId,
          targetUri: operation.targetUri!,
          backupUri: pathToFileURL(
            path.join(this.backupRootPath, preview.previewId, randomBackupBasename())
          ).toString(),
          expectedOldHash: operation.expectedOldHash!,
        })),
    };
  }

  private createRollbackPlan(preview: MergePreview, backupPlan: BackupPlan): RollbackPlan {
    return {
      previewId: preview.previewId,
      strategy: 'restoreBackups',
      items: backupPlan.items.map((item) => ({
        operationId: item.operationId,
        targetUri: item.targetUri,
        backupUri: item.backupUri,
        restoreHash: item.expectedOldHash,
      })),
    };
  }

  private redactPreview(preview: MergePreview): WorkspacePreviewDto {
    return {
      previewId: preview.previewId,
      summary: preview.summary,
      operationCount: preview.operations.length,
      items: preview.operations.map((operation) => {
        const node = findNode(this.projection.root, operation.nodeId);
        return {
          nodeId: operation.nodeId,
          label: node?.label ?? operation.nodeId,
          kind: node?.kind ?? 'unknown',
          status: node?.status ?? 'changed',
        };
      }),
      diagnostics: preview.diagnostics.map(redactDiagnostic),
    };
  }

  private unavailableDiagnostic(): CompareMessage | undefined {
    if (this.disposed) {
      return diagnostic('CONFIG_COMPARE_WORKSPACE_DISPOSED', 'Workspace сравнения закрыт.');
    }
    if (this.locked) {
      return diagnostic('CONFIG_COMPARE_WORKSPACE_LOCKED', 'Workspace сравнения заблокирован.');
    }

    return undefined;
  }

  private invalidateVolatileState(): void {
    this.previewRecords.clear();
    this.candidateFactories.clear();
  }

  private nextPreviewId(): string {
    this.previewCounter += 1;
    return `preview-${this.previewCounter}`;
  }
}

function currentSnapshotIds(session: CompareSession): Readonly<Partial<Record<CompareSide, string>>> {
  const snapshotIds: Partial<Record<CompareSide, string>> = {};
  for (const source of session.state.sources) {
    if (source.snapshotId) {
      snapshotIds[source.side] = source.snapshotId;
    }
  }

  return snapshotIds;
}

function currentTargetHashes(
  operations: readonly Pick<MergeCandidate, 'targetUri' | 'expectedOldHash'>[]
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    operations
      .filter((operation) => operation.targetUri && operation.expectedOldHash)
      .map((operation) => [operation.targetUri!, operation.expectedOldHash!])
  );
}

function findNode(node: CompareTreeNode, id: string): CompareTreeNode | undefined {
  if (node.id === id) {
    return node;
  }
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function redactDiagnostic(message: CompareMessage): CompareMessage {
  return {
    severity: message.severity,
    code: message.code,
    phase: message.phase,
    sourceId: message.sourceId,
    nodeId: message.nodeId,
    blocking: message.blocking,
    suggestedAction: redactSuggestedAction(message.suggestedAction, message.path),
  };
}

function randomBackupBasename(): string {
  return `${randomUUID()}.bak`;
}

function redactSuggestedAction(
  suggestedAction: string | undefined,
  sensitivePath: string | undefined
): string | undefined {
  if (!suggestedAction) {
    return undefined;
  }

  if (sensitivePath && containsSensitivePath(suggestedAction, sensitivePath)) {
    return 'Проверьте диагностику сравнения и пересоздайте preview перед повтором.';
  }

  return suggestedAction;
}

function containsSensitivePath(value: string, sensitivePath: string): boolean {
  return sensitivePathVariants(sensitivePath).some((variant) => value.includes(variant));
}

function sensitivePathVariants(sensitivePath: string): string[] {
  const variants = new Set<string>([sensitivePath]);
  variants.add(sensitivePath.replace(/\\/g, '/'));
  variants.add(sensitivePath.replace(/\//g, '\\'));

  try {
    const filePath = fileURLToPath(sensitivePath);
    variants.add(filePath);
    variants.add(filePath.replace(/\\/g, '/'));
    variants.add(filePath.replace(/\//g, '\\'));
  } catch {
    // Non-file paths are already covered by raw slash/backslash variants.
  }

  return [...variants].filter((variant) => variant.length > 0);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function diagnostic(code: string, suggestedAction: string, nodeId?: string): CompareMessage {
  return {
    severity: 'error',
    code,
    phase: 'preview',
    sourceId: LEFT_SOURCE_ID,
    nodeId,
    blocking: true,
    suggestedAction,
  };
}
