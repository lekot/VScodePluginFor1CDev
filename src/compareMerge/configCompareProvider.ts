import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { escapeJsonForScript } from '../utils/escapeJsonForScript';
import { Logger } from '../utils/logger';
import { renderSecureWebviewHtml } from '../utils/webviewSecurity';
import type { MutationFailureProjection } from '../services/configurationSession/mutationReceiptError';
import type { CompareTreeNode } from './compareTreeTypes';
import type { CompareMessage } from './domain/compareContracts';
import type { CompareBuildOptions, CompareBuildProgress } from './compareProgress';
import type { CompareTreeProjection } from './projection/compareTreeProjection';
import { buildCompareDisplayTree } from './projection/compareDisplayTree';
import type {
  ConfigCompareAppliedOperationDto,
  ConfigCompareHostToWebviewMessage,
  ConfigComparePreviewDto,
  ConfigCompareWebviewPayloadDto,
  ConfigCompareWebviewToHostMessage,
} from './configCompareMessages';
import type {
  ConfigCompareWebviewPayload,
  ConfigurationCompareWorkspace,
  WorkspacePreviewDto,
  WorkspaceRefreshResult,
  WorkspaceSelectionState,
  WorkspaceStrategyResult,
  CompareJoinStrategy,
} from './configurationCompareWorkspace';

export interface ConfigCompareWebviewRenderInput {
  webview: Pick<vscode.Webview, 'cspSource'>;
  payload: ConfigCompareWebviewPayload;
  executableNodeIds?: readonly string[];
  title?: string;
  nonce?: string;
  htmlPath?: string;
  initialLoadState?: Omit<ConfigCompareLoadStateMessage, 'type'>;
}

export interface ConfigCompareLoadStateMessage {
  type: 'loadState';
  generation: number;
  status: 'loading' | 'ready' | 'cancelled' | 'error';
  phase?: CompareBuildProgress['phase'];
  completed?: number;
  total?: number;
  partial?: boolean;
  payload?: ConfigCompareWebviewPayloadDto;
  error?: string;
  retryAvailable?: boolean;
}

export type ConfigCompareWorkspaceLike = Pick<
  ConfigurationCompareWorkspace,
  | 'payload'
  | 'selectNodeIds'
  | 'createPreviewForNodeIds'
  | 'approvePreview'
  | 'executeApprovedPreview'
  | 'refresh'
  | 'dispose'
> & {
  listMergeableNodeIds?: () => string[];
  setStrategy?: (
    strategy: CompareJoinStrategy,
    options?: CompareBuildOptions
  ) => WorkspaceStrategyResult | Promise<WorkspaceStrategyResult>;
};

export interface BindConfigurationCompareWebviewOptions {
  renderHtml?: boolean;
  alreadyReady?: boolean;
  generation?: number;
}

interface ControllerState {
  selectedNodeIds: string[];
  executableNodeIds: string[];
  canCreatePreview: boolean;
  diagnostics: CompareMessage[];
  preview?: ConfigComparePreviewDto;
  busy: boolean;
  locked?: boolean;
}

export function renderConfigCompareWebviewHtml(input: ConfigCompareWebviewRenderInput): string {
  const payload = toWebviewPayload(
    input.payload,
    input.executableNodeIds ?? [],
    input.title ?? 'Сравнение конфигураций'
  );
  const initialLoadState = input.initialLoadState ?? {
    generation: 0,
    status: 'ready' as const,
  };
  const template = input.htmlPath
    ? fs.readFileSync(input.htmlPath, 'utf8')
    : readConfigCompareWebviewTemplate();
  return renderSecureWebviewHtml(template, {
    webview: input.webview,
    nonce: input.nonce,
    substitutions: {
      '// __CONFIG_COMPARE_DATA_PLACEHOLDER__':
        `window.__configCompareData = ${escapeJsonForScript(JSON.stringify(payload))};`,
      '// __CONFIG_COMPARE_LOAD_PLACEHOLDER__':
        `window.__configCompareLoadState = ${escapeJsonForScript(JSON.stringify(initialLoadState))};`,
    },
  });
}

export function showConfigurationCompare(
  context: vscode.ExtensionContext,
  workspace: ConfigCompareWorkspaceLike,
  title = 'Сравнение конфигураций'
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    '1c-config-compare',
    title,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [context.extensionUri],
    }
  );

  bindConfigurationCompareWebview(panel, workspace, title);
  return panel;
}

export function bindConfigurationCompareWebview(
  panel: Pick<vscode.WebviewPanel, 'webview' | 'onDidDispose' | 'dispose'>,
  workspace: ConfigCompareWorkspaceLike,
  title = 'Сравнение конфигураций',
  options: BindConfigurationCompareWebviewOptions = {}
): vscode.Disposable {
  const state: ControllerState = {
    selectedNodeIds: [],
    executableNodeIds: [],
    canCreatePreview: false,
    diagnostics: [],
    busy: false,
    locked: workspace.payload.locked,
  };
  let operationGeneration = options.generation ?? 0;
  let operationSource: vscode.CancellationTokenSource | undefined;
  let queuedProgress: CompareBuildProgress | undefined;
  let activePartialProjection: CompareTreeProjection | undefined;
  let activePartialPayload: ConfigCompareWebviewPayloadDto | undefined;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let retryOperation: (() => Promise<void>) | undefined;

  const publishLoadState = async (message: ConfigCompareLoadStateMessage): Promise<void> => {
    try {
      await panel.webview.postMessage(message);
    } catch (error) {
      Logger.warn('Configuration compare webview no longer accepts messages', error);
      operationSource?.cancel();
    }
  };

  const publishProgress = (generation: number, source: vscode.CancellationTokenSource): void => {
    if (generation !== operationGeneration || source.token.isCancellationRequested) {
      return;
    }
    progressTimer = undefined;
    const progress = queuedProgress;
    queuedProgress = undefined;
    if (!progress) {
      return;
    }
    if (progress.projection) {
      activePartialPayload = toWebviewPayload({
        ...workspace.payload,
        root: progress.projection.root,
        stats: progress.projection.stats,
        locked: true,
      }, [], title, true);
    }
    const payload = activePartialPayload ?? toWebviewPayload(workspace.payload, [], title, true);
    void publishLoadState({
      type: 'loadState',
      generation,
      status: 'loading',
      phase: progress.phase,
      completed: progress.completed,
      total: progress.total,
      partial: true,
      payload,
    });
  };

  const runBuildOperation = async (
    run: (buildOptions: CompareBuildOptions) => Promise<WorkspaceRefreshResult | WorkspaceStrategyResult>
  ): Promise<void> => {
    const previousSelection = [...state.selectedNodeIds];
    operationSource?.cancel();
    operationSource?.dispose();
    if (progressTimer !== undefined) {clearTimeout(progressTimer);}
    progressTimer = undefined;
    queuedProgress = undefined;
    activePartialProjection = undefined;
    activePartialPayload = undefined;
    const source = new vscode.CancellationTokenSource();
    operationSource = source;
    const generation = ++operationGeneration;
    state.busy = true;
    state.preview = undefined;
    state.canCreatePreview = false;
    retryOperation = () => runBuildOperation(run);
    await publishLoadState({
      type: 'loadState',
      generation,
      status: 'loading',
      phase: 'detecting',
      partial: true,
      payload: toWebviewPayload(workspace.payload, [], title, true),
    });
    const report = (progress: CompareBuildProgress): void => {
      if (generation !== operationGeneration || source.token.isCancellationRequested) {return;}
      if (progress.projection) {
        activePartialProjection = progress.projection;
      }
      queuedProgress = activePartialProjection && !progress.projection
        ? { ...progress, projection: activePartialProjection }
        : progress;
      if (progressTimer === undefined) {
        progressTimer = setTimeout(() => publishProgress(generation, source), 60);
      }
    };
    try {
      const result = await run({ cancellation: source.token, onProgress: report });
      if (generation !== operationGeneration || source.token.isCancellationRequested) {return;}
      if (progressTimer !== undefined) {clearTimeout(progressTimer);}
      progressTimer = undefined;
      queuedProgress = undefined;
      state.busy = false;
      state.diagnostics = result.diagnostics;
      if (!result.ok) {
        state.locked = true;
        await publishLoadState({
          type: 'loadState', generation, status: 'error',
          partial: Boolean(activePartialPayload),
          payload: activePartialPayload ?? toWebviewPayload(workspace.payload, workspace.listMergeableNodeIds?.() ?? [], title),
          error: result.diagnostics.map((item: CompareMessage) => item.suggestedAction ?? item.code).join('\n') || 'Не удалось построить сравнение.',
          retryAvailable: true,
        });
        return;
      }
      state.locked = workspace.payload.locked;
      const allExecutableNodeIds = workspace.listMergeableNodeIds?.() ?? [];
      state.executableNodeIds = allExecutableNodeIds;
      const executable = new Set(allExecutableNodeIds);
      const retainedSelection = previousSelection.filter((nodeId) => executable.has(nodeId));
      if (retainedSelection.length > 0) {
        applySelection(state, workspace.selectNodeIds(retainedSelection));
      } else {
        state.selectedNodeIds = [];
        state.executableNodeIds = [];
        state.canCreatePreview = false;
      }
      await publishLoadState({
        type: 'loadState', generation, status: 'ready',
        payload: toWebviewPayload(workspace.payload, allExecutableNodeIds, title),
      });
      activePartialProjection = undefined;
      activePartialPayload = undefined;
      await postState(panel.webview, workspace, title, state);
    } catch (error) {
      if (generation !== operationGeneration || source.token.isCancellationRequested) {return;}
      if (progressTimer !== undefined) {clearTimeout(progressTimer);}
      progressTimer = undefined;
      queuedProgress = undefined;
      state.busy = false;
      state.locked = true;
      await publishLoadState({
        type: 'loadState', generation, status: 'error',
        partial: Boolean(activePartialPayload),
        payload: activePartialPayload ?? toWebviewPayload(workspace.payload, workspace.listMergeableNodeIds?.() ?? [], title),
        error: safeErrorMessage(error),
        retryAvailable: true,
      });
    } finally {
      if (operationSource === source) {
        operationSource.dispose();
        operationSource = undefined;
      }
    }
  };

  const cancelBuildOperation = async (): Promise<void> => {
    const source = operationSource;
    if (!source) {return;}
    source.cancel();
    if (progressTimer !== undefined) {clearTimeout(progressTimer);}
    progressTimer = undefined;
    queuedProgress = undefined;
    state.busy = false;
    await publishLoadState({
      type: 'loadState',
      generation: operationGeneration,
      status: 'cancelled',
      partial: Boolean(activePartialPayload),
      payload: activePartialPayload ?? toWebviewPayload(workspace.payload, [], title, true),
      retryAvailable: Boolean(retryOperation),
    });
    source.dispose();
    if (operationSource === source) {operationSource = undefined;}
  };

  if (options.renderHtml !== false) {
    panel.webview.html = renderConfigCompareWebviewHtml({
      webview: panel.webview,
      payload: workspace.payload,
      executableNodeIds: workspace.listMergeableNodeIds?.() ?? [],
      title,
    });
  }

  const messageSubscription = panel.webview.onDidReceiveMessage(async (rawMessage: unknown) => {
    const message = parseWebviewMessage(rawMessage);
    if (!message) {
      Logger.warn('Ignored invalid configuration compare webview message', rawMessage);
      return;
    }

    if (
      state.busy &&
      !operationSource &&
      (message.type === 'refresh' || message.type === 'setStrategy' || message.type === 'retry')
    ) {
      await rejectBusyMessage(panel.webview, workspace, title, state);
      return;
    }

    if (message.type === 'cancel' && operationSource) {
      await cancelBuildOperation();
      return;
    }
    if (message.type === 'retry' && retryOperation) {
      await retryOperation();
      return;
    }
    if (message.type === 'close') {
      panel.dispose();
      return;
    }

    try {
      if (message.type === 'refresh') {
        await runBuildOperation((buildOptions) => workspace.refresh(buildOptions));
      } else if (message.type === 'setStrategy') {
        await runBuildOperation((buildOptions) => workspace.setStrategy
          ? Promise.resolve(workspace.setStrategy(message.strategy, buildOptions))
          : Promise.resolve({ ok: false, payload: workspace.payload, diagnostics: [] }));
      } else {
        await handleWebviewMessage(panel.webview, workspace, title, state, message);
      }
    } catch (error) {
      Logger.error('Configuration compare webview message failed', error);
      state.busy = false;
      await postError(
        panel.webview,
        'Действие сравнения конфигураций не выполнено.',
        [],
        workspace.payload.locked
      );
      await postState(panel.webview, workspace, title, state);
    }
  });

  const disposeSubscription = panel.onDidDispose(() => {
    operationSource?.cancel();
    operationSource?.dispose();
    operationSource = undefined;
    if (progressTimer !== undefined) {clearTimeout(progressTimer);}
    messageSubscription.dispose();
    workspace.dispose();
  });

  if (options.alreadyReady) {
    void postState(panel.webview, workspace, title, state);
  }

  return {
    dispose: () => {
      operationSource?.cancel();
      operationSource?.dispose();
      operationSource = undefined;
      if (progressTimer !== undefined) {clearTimeout(progressTimer);}
      messageSubscription.dispose();
      disposeSubscription.dispose();
    },
  };
}

async function handleWebviewMessage(
  webview: Pick<vscode.Webview, 'postMessage'>,
  workspace: ConfigCompareWorkspaceLike,
  title: string,
  state: ControllerState,
  message: ConfigCompareWebviewToHostMessage
): Promise<void> {
  if (state.busy && message.type !== 'ready') {
    await rejectBusyMessage(webview, workspace, title, state);
    return;
  }

  switch (message.type) {
    case 'ready':
      await postState(webview, workspace, title, state);
      return;
    case 'setStrategy':
      await setStrategy(webview, workspace, title, state, message.strategy);
      return;
    case 'selectionChanged':
      applySelection(state, workspace.selectNodeIds(message.nodeIds));
      state.preview = undefined;
      await postState(webview, workspace, title, state);
      return;
    case 'createPreview':
      state.selectedNodeIds = [...message.nodeIds];
      state.busy = true;
      state.preview = undefined;
      await postState(webview, workspace, title, state);
      await createPreview(webview, workspace, title, state, message.nodeIds);
      return;
    case 'approvePreview':
      await approvePreview(webview, workspace, title, state, message.previewId);
      return;
    case 'executeMerge':
      await executeMerge(webview, workspace, title, state, message.previewId, message.destructiveConfirmed === true);
      return;
    case 'refresh':
      await refresh(webview, workspace, title, state);
      return;
    case 'cancel':
    case 'retry':
    case 'close':
      return;
    default:
      assertNever(message);
  }
}

async function setStrategy(
  webview: Pick<vscode.Webview, 'postMessage'>,
  workspace: ConfigCompareWorkspaceLike,
  title: string,
  state: ControllerState,
  strategy: CompareJoinStrategy
): Promise<void> {
  state.busy = true;
  await postState(webview, workspace, title, state);
  state.selectedNodeIds = [];
  state.executableNodeIds = [];
  state.canCreatePreview = false;
  state.preview = undefined;
  if (workspace.setStrategy) {
    const result = await workspace.setStrategy(strategy);
    state.diagnostics = result.diagnostics;
    if (!result.ok) {
      await postError(webview, 'Не удалось изменить стратегию сравнения.', result.diagnostics, workspace.payload.locked);
    }
  }
  state.busy = false;
  await postState(webview, workspace, title, state);
}

async function createPreview(
  webview: Pick<vscode.Webview, 'postMessage'>,
  workspace: ConfigCompareWorkspaceLike,
  title: string,
  state: ControllerState,
  nodeIds: readonly string[]
): Promise<void> {
  const result = await workspace.createPreviewForNodeIds(nodeIds);
  state.busy = false;
  if (!result.ok) {
    state.diagnostics = result.diagnostics;
    await postError(webview, 'Не удалось построить preview.', result.diagnostics, workspace.payload.locked);
    await postState(webview, workspace, title, state);
    return;
  }

  state.preview = toPreviewDto(result.preview, false, workspace.payload.root);
  state.diagnostics = [];
  await postMessage(webview, { type: 'previewReady', ...state.preview });
  await postState(webview, workspace, title, state);
}

async function approvePreview(
  webview: Pick<vscode.Webview, 'postMessage'>,
  workspace: ConfigCompareWorkspaceLike,
  title: string,
  state: ControllerState,
  previewId: string
): Promise<void> {
  state.busy = true;
  await postState(webview, workspace, title, state);
  const result = workspace.approvePreview(previewId);
  state.busy = false;
  if (!result.ok) {
    state.diagnostics = result.diagnostics;
    await postError(webview, 'Не удалось подтвердить preview.', result.diagnostics, workspace.payload.locked);
    await postState(webview, workspace, title, state);
    return;
  }

  state.preview = toPreviewDto(result.preview, true, workspace.payload.root);
  state.diagnostics = [];
  await postMessage(webview, { type: 'previewReady', ...state.preview });
  await postState(webview, workspace, title, state);
}

async function executeMerge(
  webview: Pick<vscode.Webview, 'postMessage'>,
  workspace: ConfigCompareWorkspaceLike,
  title: string,
  state: ControllerState,
  previewId: string,
  destructiveConfirmed: boolean
): Promise<void> {
  if (!isCurrentApprovedPreview(state.preview, previewId)) {
    await postError(
      webview,
      'Preview больше не активен. Постройте и подтвердите preview заново.',
      [],
      workspace.payload.locked
    );
    await postState(webview, workspace, title, state);
    return;
  }

  if (previewRequiresDestructiveConfirmation(state.preview, previewId) && !destructiveConfirmed) {
    await postError(
      webview,
      'Merge содержит destructive-операции: удаление или перезапись файлов. Подтвердите выполнение повторно.',
      [],
      workspace.payload.locked
    );
    await postState(webview, workspace, title, state);
    return;
  }

  state.busy = true;
  await postState(webview, workspace, title, state);
  const result = await workspace.executeApprovedPreview(previewId, { destructiveConfirmed });
  state.busy = false;
  if (!result.ok) {
    state.diagnostics = result.diagnostics;
    await postError(
      webview,
      'Не удалось выполнить merge.',
      result.diagnostics,
      result.locked,
      result.result?.backupPaths,
      result.result?.mutationFailure
    );
    await postState(webview, workspace, title, state);
    return;
  }

  state.selectedNodeIds = [];
  state.executableNodeIds = [];
  state.canCreatePreview = false;
  state.preview = undefined;
  state.diagnostics = result.diagnostics;
  await postMessage(webview, {
    type: 'mergeSuccess',
    applied: result.result.applied.map(redactAppliedOperation),
    backupPaths: [...result.result.backupPaths],
    payload: toWebviewPayload(
      result.payload,
      workspace.listMergeableNodeIds?.() ?? [],
      title,
      result.locked
    ),
    locked: result.locked,
    diagnostics: result.diagnostics,
  });
  await postState(webview, workspace, title, state);
}

async function refresh(
  webview: Pick<vscode.Webview, 'postMessage'>,
  workspace: ConfigCompareWorkspaceLike,
  title: string,
  state: ControllerState
): Promise<void> {
  state.busy = true;
  await postState(webview, workspace, title, state);
  const result = await workspace.refresh();
  state.busy = false;
  state.selectedNodeIds = [];
  state.executableNodeIds = [];
  state.canCreatePreview = false;
  state.preview = undefined;
  state.diagnostics = result.diagnostics;
  if (!result.ok) {
    await postError(webview, 'Не удалось обновить состояние сравнения.', result.diagnostics, result.locked);
  }
  await postState(webview, workspace, title, state);
}

async function rejectBusyMessage(
  webview: Pick<vscode.Webview, 'postMessage'>,
  workspace: ConfigCompareWorkspaceLike,
  title: string,
  state: ControllerState
): Promise<void> {
  await postError(
    webview,
    'Операция сравнения уже выполняется. Дождитесь завершения текущего действия.',
    [],
    workspace.payload.locked
  );
  await postState(webview, workspace, title, state);
}

function applySelection(state: ControllerState, selection: WorkspaceSelectionState): void {
  state.selectedNodeIds = selection.selectedNodeIds;
  state.executableNodeIds = selection.executableNodeIds;
  state.canCreatePreview = selection.canCreatePreview;
  state.diagnostics = selection.diagnostics;
}

export async function postState(
  webview: Pick<vscode.Webview, 'postMessage'>,
  workspace: ConfigCompareWorkspaceLike,
  title: string,
  state: ControllerState
): Promise<void> {
  const locked = workspace.payload.locked;
  await postMessage(webview, {
    type: 'state',
    payload: toWebviewPayload(workspace.payload, workspace.listMergeableNodeIds?.() ?? [], title),
    selectedNodeIds: state.selectedNodeIds,
    executableNodeIds: state.executableNodeIds,
    canCreatePreview: state.canCreatePreview && !locked && !state.busy,
    busy: state.busy,
    locked,
    diagnostics: state.diagnostics,
    preview: state.preview,
  });
}

async function postError(
  webview: Pick<vscode.Webview, 'postMessage'>,
  message: string,
  diagnostics: readonly CompareMessage[],
  locked: boolean,
  backupPaths?: readonly string[],
  mutationFailure?: MutationFailureProjection
): Promise<void> {
  await postMessage(webview, {
    type: 'mergeError',
    message,
    diagnostics: [...diagnostics],
    locked,
    backupPaths: backupPaths ? [...backupPaths] : undefined,
    mutationFailure,
  });
}

async function postMessage(
  webview: Pick<vscode.Webview, 'postMessage'>,
  message: ConfigCompareHostToWebviewMessage
): Promise<void> {
  await webview.postMessage(message);
}

export function toWebviewPayload(
  payload: ConfigCompareWebviewPayload,
  executableNodeIds: readonly string[],
  title: string,
  lockedOverride?: boolean
): ConfigCompareWebviewPayloadDto {
  const safeRoot = redactTreeNode(payload.root);
  return {
    title,
    targetLabel: safeRootLabel(payload.sourceRoots.left),
    sourceLabel: safeRootLabel(payload.sourceRoots.right),
    root: buildCompareDisplayTree(safeRoot).root,
    stats: payload.stats,
    locked: lockedOverride ?? payload.locked,
    strategy: payload.strategy ?? 'right',
    executableNodeIds: [...executableNodeIds],
    comparisonInfo: payload.comparisonInfo
      ? {
          ...payload.comparisonInfo,
          targetLabel: redactCompareDisplayLabel(payload.comparisonInfo.targetLabel),
          sourceLabel: redactCompareDisplayLabel(payload.comparisonInfo.sourceLabel),
          limitations: [...payload.comparisonInfo.limitations],
        }
      : undefined,
  };
}

function redactTreeNode(node: CompareTreeNode): CompareTreeNode {
  return {
    id: node.id,
    label: node.label,
    kind: node.kind,
    status: node.status,
    leftValue: redactTreeValue(node.leftValue),
    rightValue: redactTreeValue(node.rightValue),
    mergeable: node.mergeable,
    destructive: node.destructive,
    conflict: node.conflict
      ? { ...node.conflict, message: redactSafeText(node.conflict.message) ?? node.conflict.message }
      : undefined,
    mergeState: node.mergeState
      ? {
          state: node.mergeState.state,
          reason: redactSafeText(node.mergeState.reason),
        }
      : undefined,
    presentation: node.presentation
      ? {
          ownerKey: node.presentation.ownerKey,
          ownerAliases: node.presentation.ownerAliases ? [...node.presentation.ownerAliases] : undefined,
          metadataType: node.presentation.metadataType,
          moduleKind: node.presentation.moduleKind,
          qualifiedName: node.presentation.qualifiedName,
          identityConflict: node.presentation.identityConflict,
          ambiguousIdentitySet: node.presentation.ambiguousIdentitySet,
          identities: node.presentation.identities?.map((identity) => ({
            side: identity.side,
            qualifiedName: identity.qualifiedName,
            uuid: identity.uuid,
            filePath: redactIdentityPath(identity.filePath),
            ownership: identity.ownership,
            sourceUuid: identity.sourceUuid,
          })),
        }
      : undefined,
    children: node.children.map(redactTreeNode),
  };
}

function redactTreeValue(value: string | undefined): string | undefined {
  if (
    !value ||
    /^sha256[:\w-]*/i.test(value) ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    /^\/(?!\/)[^\s]*/.test(value)
  ) {
    return undefined;
  }

  return value;
}
function safeRootLabel(value: string | undefined): string {
  if (!value) {
    return 'Конфигурация';
  }
  const basename = path.win32.basename(value.replace(/\//g, '\\')) || path.posix.basename(value);
  return basename && basename !== '.' && basename !== '\\' ? basename : 'Конфигурация';
}
function redactSafeText(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }
  return value.replace(/(?:[A-Za-z]:[\\/]|(?<![\w:])\/)[^\s"'<>]*/g, (match) => {
    const basename = safeRootLabel(match);
    return basename === 'Конфигурация' ? '[путь]' : `…/${basename}`;
  });
}
export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSafeText(message) ?? 'Неизвестная ошибка сравнения.';
}
export function createEmptyComparePayload(target: string, source: string): ConfigCompareWebviewPayload {
  return {
    root: {
      id: 'configCompare',
      label: 'Configuration compare',
      kind: 'configCompare',
      status: 'equal',
      children: [],
    },
    stats: { total: 0, different: 0, mergeable: 0 },
    sourceRoots: { left: target, right: source },
    locked: true,
    strategy: 'right',
  };
}
function toPreviewDto(
  preview: WorkspacePreviewDto,
  approved: boolean,
  root: CompareTreeNode
): ConfigComparePreviewDto {
  const items = preview.items.map((item) => ({
    ...item,
    previewPath: redactPreviewPath(item.previewPath),
    destructive: isPreviewItemDestructive(item, root) ? true : undefined,
  }));
  return {
    previewId: preview.previewId,
    summary: preview.summary,
    operationCount: preview.operationCount,
    items,
    destructiveCount: items.filter((item) => item.destructive === true).length,
    diagnostics: [...preview.diagnostics],
    approved,
  };
}

function isPreviewItemDestructive(
  item: WorkspacePreviewDto['items'][number],
  root: CompareTreeNode
): boolean {
  if (item.previewEffect === 'create') {
    return false;
  }
  return (
    item.previewEffect === 'replace' ||
    item.previewEffect === 'delete' ||
    item.destructive === true ||
    findTreeNode(root, item.nodeId)?.destructive === true
  );
}

function redactCompareDisplayLabel(value: string): string {
  return value &&
    !path.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    !path.posix.isAbsolute(value)
    ? value
    : 'Конфигурация';
}

function redactPreviewPath(value: string | undefined): string | undefined {
  if (
    !value ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.posix.isAbsolute(value)
  ) {
    return undefined;
  }
  const normalized = value.replace(/\\/g, '/');
  return normalized.split('/').some((segment) => segment === '..' || segment === '.')
    ? undefined
    : normalized;
}

function redactIdentityPath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (!path.isAbsolute(value) && !path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)) {
    const normalized = value.replace(/\\/g, '/');
    if (!normalized.split('/').some((segment) => segment === '..' || segment === '.')) {
      return normalized;
    }
  }
  return safeRootLabel(value);
}

function previewRequiresDestructiveConfirmation(
  preview: ConfigComparePreviewDto | undefined,
  previewId: string
): boolean {
  return preview?.previewId === previewId && preview.destructiveCount > 0;
}

function isCurrentApprovedPreview(
  preview: ConfigComparePreviewDto | undefined,
  previewId: string
): boolean {
  return preview?.previewId === previewId && preview.approved === true;
}

function findTreeNode(node: CompareTreeNode, nodeId: string): CompareTreeNode | undefined {
  if (node.id === nodeId) {
    return node;
  }
  for (const child of node.children) {
    const found = findTreeNode(child, nodeId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function redactAppliedOperation(input: {
  operationId: string;
  kind: string;
  code?: string;
  message?: string;
}): ConfigCompareAppliedOperationDto {
  return {
    operationId: input.operationId,
    kind: input.kind,
    code: input.code,
    message: input.message,
  };
}

export function parseWebviewMessage(message: unknown): ConfigCompareWebviewToHostMessage | undefined {
  if (!isRecord(message) || typeof message.type !== 'string') {
    return undefined;
  }

  switch (message.type) {
    case 'ready':
    case 'cancel':
    case 'retry':
    case 'close':
    case 'refresh':
      return hasOnlyKeys(message, ['type']) ? { type: message.type } : undefined;
    case 'setStrategy':
      return hasOnlyKeys(message, ['type', 'strategy']) && isCompareJoinStrategy(message.strategy)
        ? { type: 'setStrategy', strategy: message.strategy }
        : undefined;
    case 'selectionChanged':
    case 'createPreview':
      return hasOnlyKeys(message, ['type', 'nodeIds']) && isStringArray(message.nodeIds)
        ? { type: message.type, nodeIds: message.nodeIds }
        : undefined;
    case 'approvePreview':
      return hasOnlyKeys(message, ['type', 'previewId']) && typeof message.previewId === 'string'
        ? { type: message.type, previewId: message.previewId }
        : undefined;
    case 'executeMerge':
      return isExecuteMergeMessage(message)
        ? {
            type: 'executeMerge',
            previewId: message.previewId,
            destructiveConfirmed: message.destructiveConfirmed,
          }
        : undefined;
    default:
      return undefined;
  }
}
function isExecuteMergeMessage(
  message: Record<string, unknown>
): message is { type: 'executeMerge'; previewId: string; destructiveConfirmed?: boolean } {
  return (
    hasOnlyAllowedKeys(message, ['type', 'previewId', 'destructiveConfirmed']) &&
    message.type === 'executeMerge' &&
    typeof message.previewId === 'string' &&
    (message.destructiveConfirmed === undefined || typeof message.destructiveConfirmed === 'boolean')
  );
}
function isCompareJoinStrategy(value: unknown): value is CompareJoinStrategy {
  return value === 'left' || value === 'right' || value === 'full';
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key)) && Object.keys(value).length === keys.length;
}
function hasOnlyAllowedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key));
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
function readConfigCompareWebviewTemplate(): string {
  const htmlPath = resolveConfigCompareWebviewHtmlPath();
  return htmlPath ? fs.readFileSync(htmlPath, 'utf8') : DEFAULT_CONFIG_COMPARE_WEBVIEW_HTML;
}
function resolveConfigCompareWebviewHtmlPath(): string | undefined {
  const candidates = [
    path.join(__dirname, 'configCompareWebview.html'),
    path.join(__dirname, '..', '..', 'src', 'compareMerge', 'configCompareWebview.html'),
    path.join(__dirname, '..', '..', '..', 'src', 'compareMerge', 'configCompareWebview.html'),
    path.join(process.cwd(), 'src', 'compareMerge', 'configCompareWebview.html'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}
function assertNever(value: never): never {
  throw new Error(`Unexpected configuration compare message: ${String(value)}`);
}

const DEFAULT_CONFIG_COMPARE_WEBVIEW_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="\${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Сравнение конфигураций</title>
</head>
<body>
  <main id="app"></main>
  <script nonce="\${nonce}">
    // __CONFIG_COMPARE_DATA_PLACEHOLDER__
  </script>
</body>
</html>`;
