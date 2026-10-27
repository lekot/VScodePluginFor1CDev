import * as path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import type { ConfigurationMutationEngine } from '../services/configurationSession/ConfigurationMutationEngine';
import type { ConfigurationId } from '../services/configurationSession/types';

import { compareCodeUnits } from '../utils/compareCodeUnits';
import type { CompareTreeNode, CompareTreeStats } from './compareTreeTypes';
import type { CompareTreeProjection } from './projection/compareTreeProjection';
import { CompareSession } from './domain/compareSession';
import type { CompareMessage, CompareSide } from './domain/compareContracts';
import {
  createMergePreview,
  MISSING_TARGET_HASH,
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
import { isCanonicalWitnessRelativePath } from './merge/capturedFileWrite';

const LEFT_SOURCE_ID = 'left-source';
export type CompareJoinStrategy = 'left' | 'right' | 'full';

export interface ConfigCompareWebviewPayload {
  root: CompareTreeNode;
  stats: CompareTreeStats;
  sourceRoots: {
    left: string;
    right: string;
  };
  locked: boolean;
  strategy?: CompareJoinStrategy;
  comparisonInfo?: ConfigurationCompareInfo;
}

export interface ConfigurationCompareInfo {
  mode: 'extension';
  targetLabel: string;
  sourceLabel: string;
  limitations: readonly string[];
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
  destructive?: boolean;
  previewPath?: string;
  previewEffect?: 'create' | 'replace' | 'delete';
}

export interface WorkspacePreviewDto {
  previewId: string;
  summary: string;
  operationCount: number;
  destructiveCount: number;
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

export interface WorkspaceExecutionOptions {
  destructiveConfirmed?: boolean;
}

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

export type WorkspaceStrategyResult =
  | {
      ok: true;
      payload: ConfigCompareWebviewPayload;
      diagnostics: [];
    }
  | {
      ok: false;
      payload: ConfigCompareWebviewPayload;
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

export type WorkspaceSelectionMaterializer = (
  nodeIds: readonly string[]
) => Promise<
  | { ok: true; candidates: readonly MergeCandidate[] }
  | { ok: false; diagnostics: CompareMessage[] }
>;

export interface ConfigurationCompareWorkspaceState {
  session: CompareSession;
  projection: CompareTreeProjection;
  candidateFactories: ReadonlyMap<string, ExecutableCandidateFactory>;
  materializeSelection?: WorkspaceSelectionMaterializer;
  mergeableNodeIds?: readonly string[];
  comparisonInfo?: ConfigurationCompareInfo;
}

export interface ConfigurationCompareWorkspaceInput extends ConfigurationCompareWorkspaceState {
  leftRootPath: string;
  rightRootPath: string;
  createdAt?: Date;
  backupRootPath: string;
  mutationEngine?: ConfigurationMutationEngine;
  configurationId?: ConfigurationId;
  refreshWorkspace?: (strategy: CompareJoinStrategy) => Promise<ConfigurationCompareWorkspaceState>;
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
  private readonly mutationEngine?: ConfigurationMutationEngine;
  private readonly configurationId?: ConfigurationId;
  private readonly refreshWorkspace?: (strategy: CompareJoinStrategy) => Promise<ConfigurationCompareWorkspaceState>;
  private readonly createPreview: typeof createMergePreview;
  private readonly validatePreflight: typeof validateMergePreflight;
  private readonly executeMerge: (input: MergeExecutorInput) => Promise<MergeExecutionResult>;
  private readonly previewRecords = new Map<string, PreviewRecord>();
  private candidateFactories: Map<string, ExecutableCandidateFactory>;
  private materializeSelection?: WorkspaceSelectionMaterializer;
  private mergeableNodeIds: string[] = [];
  private comparisonInfo?: ConfigurationCompareInfo;
  private selectionRevision = 0;
  private previewCounter = 0;
  private disposed = false;
  private locked = false;
  private strategy: CompareJoinStrategy = 'right';

  constructor(input: ConfigurationCompareWorkspaceInput) {
    this.session = input.session;
    this.projection = input.projection;
    this.leftRootPath = input.leftRootPath;
    this.rightRootPath = input.rightRootPath;
    this.createdAt = input.createdAt ?? new Date();
    this.backupRootPath = input.backupRootPath;
    this.mutationEngine = input.mutationEngine;
    this.configurationId = input.configurationId;
    this.refreshWorkspace = input.refreshWorkspace;
    this.createPreview = input.createPreview ?? createMergePreview;
    this.validatePreflight = input.validatePreflight ?? validateMergePreflight;
    this.executeMerge = input.executeMerge ?? executeBslMergePreview;
    this.candidateFactories = new Map();
    this.applyWorkspaceState(input);
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
      strategy: this.strategy,
      comparisonInfo: this.comparisonInfo,
    };
  }

  selectNodeIds(nodeIds: readonly string[]): WorkspaceSelectionState {
    this.selectionRevision += 1;
    const mergeableNodeIds = new Set(this.availableMergeableNodeIds());
    const executableNodeIds = nodeIds.filter((nodeId) => mergeableNodeIds.has(nodeId));
    const diagnostics =
      executableNodeIds.length > 0 && executableNodeIds.length === nodeIds.length
        ? []
        : [
            diagnostic(
              'CONFIG_COMPARE_SINGLE_EXECUTABLE_REQUIRED',
              'Выберите один или несколько исполняемых узлов сравнения перед построением preview.'
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
    return this.disposed ? [] : this.availableMergeableNodeIds().sort(compareCodeUnits);
  }

  async setStrategy(strategy: CompareJoinStrategy): Promise<WorkspaceStrategyResult> {
    const unavailable = this.unavailableDiagnostic();
    if (unavailable) {
      return { ok: false, payload: this.payload, diagnostics: [unavailable] };
    }

    this.strategy = strategy;
    const refreshResult = await this.refresh();
    return refreshResult.ok
      ? { ok: true, payload: refreshResult.payload, diagnostics: [] }
      : { ok: false, payload: refreshResult.payload, diagnostics: refreshResult.diagnostics };
  }

  async createPreviewForNodeIds(nodeIds: readonly string[]): Promise<WorkspacePreviewResult> {
    const unavailable = this.unavailableDiagnostic();
    if (unavailable) {
      return { ok: false, diagnostics: [unavailable] };
    }

    if (nodeIds.length === 0) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            'CONFIG_COMPARE_SINGLE_EXECUTABLE_REQUIRED',
            'Выберите один или несколько исполняемых узлов сравнения перед построением preview.'
          ),
        ],
      };
    }

    const mergeableNodeIds = new Set(this.availableMergeableNodeIds());
    const unknownNodeIds = nodeIds.filter((nodeId) => !mergeableNodeIds.has(nodeId));
    if (unknownNodeIds.length > 0) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            nodeIds.length > 1
              ? 'CONFIG_COMPARE_SINGLE_EXECUTABLE_REQUIRED'
              : 'CONFIG_COMPARE_UNKNOWN_SELECTION',
            nodeIds.length > 1
              ? 'Выберите только исполняемые узлы сравнения перед построением preview.'
              : 'Selected compare node is not registered as an executable host-side merge candidate.',
            unknownNodeIds[0]
          ),
        ],
      };
    }

    const session = this.session;
    const materializationRevision = ++this.selectionRevision;
    let candidates: MergeCandidate[];
    if (this.materializeSelection) {
      const result = await this.materializeSelection(nodeIds);
      const stale = this.materializationContextDiagnostic(session, materializationRevision);
      if (stale) {
        return { ok: false, diagnostics: [stale] };
      }
      if (!result.ok) {
        return { ok: false, diagnostics: result.diagnostics.map(redactDiagnostic) };
      }
      candidates = [...result.candidates];
      if (candidates.length === 0) {
        return {
          ok: false,
          diagnostics: [
            diagnostic(
              'CONFIG_COMPARE_EMPTY_SELECTION',
              'Для выбранных объектов не создано операций preview.'
            ),
          ],
        };
      }
    } else {
      const materialized = await this.materializeLegacyCandidates(nodeIds);
      const stale = this.materializationContextDiagnostic(session, materializationRevision);
      if (stale) {
        return { ok: false, diagnostics: [stale] };
      }
      if (!materialized.ok) {
        return { ok: false, diagnostics: materialized.diagnostics };
      }
      candidates = materialized.candidates;
    }

    const previewId = this.nextPreviewId();
    const validation = this.createPreview({
      session,
      previewId,
      targetSourceId: LEFT_SOURCE_ID,
      snapshotIds: currentSnapshotIds(session),
      createdAt: this.createdAt.toISOString(),
      candidates,
      currentTargetHashes: currentTargetHashes(candidates),
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

  async executeApprovedPreview(
    previewId: string,
    options: WorkspaceExecutionOptions = {}
  ): Promise<WorkspaceExecutionResult> {
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
    if (previewHasDestructiveOperations(record.preview) && options.destructiveConfirmed !== true) {
      return {
        ok: false,
        locked: this.locked,
        diagnostics: [
          diagnostic(
            'CONFIG_COMPARE_DESTRUCTIVE_CONFIRMATION_REQUIRED',
            'Merge содержит destructive-операции. Подтвердите выполнение повторно.'
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
      mutationEngine: this.mutationEngine,
      configurationId: this.configurationId,
    });
    const executionDiagnostics = result.diagnostics.map(redactDiagnostic);
    const ok = result.receipt
      ? result.receipt.status === 'committed'
      : result.failed.length === 0;
    if (!ok) {
      const mutationStatus = result.receipt?.status ?? result.mutationFailure?.status;
      if (mutationStatus === 'recoveryRequired' || mutationStatus === 'inDoubt') {
        this.locked = true;
        this.invalidateVolatileState();
      }
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

    this.previewRecords.clear();
    this.locked = true;
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
      const refreshed = await this.refreshWorkspace(this.strategy);
      if (this.disposed) {
        refreshed.session.dispose();
        return {
          ok: false,
          payload: this.payload,
          locked: true,
          diagnostics: [
            diagnostic('CONFIG_COMPARE_WORKSPACE_DISPOSED', 'Workspace СЃСЂР°РІРЅРµРЅРёСЏ Р·Р°РєСЂС‹С‚.'),
          ],
        };
      }
      const previousSession = this.session;
      this.applyWorkspaceState(refreshed);
      previousSession.dispose();
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
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.locked = true;
    this.invalidateVolatileState();
    this.session.dispose();
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
    const items = preview.operations.map((operation) => {
      const node = findNode(this.projection.root, operation.nodeId);
      const previewPath = safeRelativePreviewPath(operation.previewPath);
      return {
        nodeId: operation.nodeId,
        label: node?.label ?? operation.nodeId,
        kind: node?.kind ?? 'unknown',
        status: node?.status ?? 'changed',
        ...(previewOperationIsDestructive(operation, node?.destructive) ? { destructive: true } : {}),
        ...(previewPath ? { previewPath } : {}),
        ...(operation.previewEffect ? { previewEffect: operation.previewEffect } : {}),
      };
    });

    return {
      previewId: preview.previewId,
      summary: preview.summary,
      operationCount: preview.operations.length,
      destructiveCount: items.filter((item) => item.destructive).length,
      items,
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
    this.materializeSelection = undefined;
    this.mergeableNodeIds = [];
  }

  private availableMergeableNodeIds(): string[] {
    return this.materializeSelection
      ? [...this.mergeableNodeIds]
      : [...this.candidateFactories.keys()];
  }

  private applyWorkspaceState(state: ConfigurationCompareWorkspaceState): void {
    this.selectionRevision += 1;
    this.session = state.session;
    this.projection = state.projection;
    this.candidateFactories = new Map(state.candidateFactories);
    this.materializeSelection = state.materializeSelection;
    this.mergeableNodeIds = state.materializeSelection
      ? [...new Set(state.mergeableNodeIds ?? [])]
      : [...this.candidateFactories.keys()];
    this.comparisonInfo = state.comparisonInfo;
  }

  private async materializeLegacyCandidates(
    nodeIds: readonly string[]
  ): Promise<{ ok: true; candidates: MergeCandidate[] } | { ok: false; diagnostics: CompareMessage[] }> {
    const firstNodeId = nodeIds[0];
    const firstFactory = firstNodeId ? this.candidateFactories.get(firstNodeId) : undefined;
    if (!firstNodeId || !firstFactory) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            'CONFIG_COMPARE_UNKNOWN_SELECTION',
            'Выбранный узел сравнения не зарегистрирован как исполняемый host-side кандидат merge.',
            firstNodeId
          ),
        ],
      };
    }

    const firstResult = await firstFactory();
    if (!firstResult.ok) {
      return { ok: false, diagnostics: firstResult.diagnostics.map(redactDiagnostic) };
    }

    const candidates: MergeCandidate[] = [firstResult.candidate];
    const diagnostics: CompareMessage[] = [];
    for (const nodeId of nodeIds.slice(1)) {
      const factory = this.candidateFactories.get(nodeId);
      if (!factory) {
        diagnostics.push(
          diagnostic(
            'CONFIG_COMPARE_UNKNOWN_SELECTION',
            'Selected compare node is not registered as an executable host-side merge candidate.',
            nodeId
          )
        );
        continue;
      }
      const result = await factory();
      if (result.ok) {
        candidates.push(result.candidate);
      } else {
        diagnostics.push(...result.diagnostics.map(redactDiagnostic));
      }
    }
    return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, candidates };
  }

  private materializationContextDiagnostic(
    session: CompareSession,
    selectionRevision: number
  ): CompareMessage | undefined {
    const unavailable = this.unavailableDiagnostic();
    if (unavailable) {
      return unavailable;
    }
    if (this.session !== session || this.selectionRevision !== selectionRevision) {
      return diagnostic(
        'CONFIG_COMPARE_SELECTION_STALE',
        'Выбор или состояние сравнения изменились во время построения preview. Повторите выбор.'
      );
    }
    return undefined;
  }

  private nextPreviewId(): string {
    this.previewCounter += 1;
    return `preview-${this.previewCounter}`;
  }
}

function currentSnapshotIds(session: CompareSession): Readonly<Partial<Record<CompareSide, string>>> {
  const snapshotIds: Partial<Record<CompareSide, string>> = {};
  for (const source of session.state.sources) {
    if (source.role !== 'base' && source.snapshotId) {
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

function previewHasDestructiveOperations(preview: MergePreview): boolean {
  return preview.operations.some((operation) => previewOperationIsDestructive(operation));
}

function previewOperationIsDestructive(
  operation: MergePreview['operations'][number],
  legacyNodeDestructive = false
): boolean {
  if (operation.kind === 'fileWrite') {
    return (
      operation.previewEffect === 'replace' ||
      operation.previewEffect === 'delete' ||
      Boolean(operation.expectedOldHash && operation.expectedOldHash !== MISSING_TARGET_HASH)
    );
  }
  if (operation.kind === 'fileDelete') {
    return true;
  }
  if (operation.previewEffect === 'replace' || operation.previewEffect === 'delete') {
    return true;
  }
  return (
    operation.fileOperation?.destructive === true ||
    legacyNodeDestructive ||
    operation.kind === 'xmlNodeDelete' ||
    operation.kind === 'folderDelete' ||
    operation.kind === 'bslRoutineDelete'
  );
}

function safeRelativePreviewPath(value: string | undefined): string | undefined {
  if (!value || !isCanonicalWitnessRelativePath(value, 'file')) {
    return undefined;
  }
  return value.replace(/\\/g, '/');
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
