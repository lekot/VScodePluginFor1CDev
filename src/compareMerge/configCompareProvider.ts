import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

import { escapeJsonForScript } from '../utils/escapeJsonForScript';
import { Logger } from '../utils/logger';
import type { CompareTreeNode } from './compareTreeTypes';
import type { CompareMessage } from './domain/compareContracts';
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
}

type ConfigCompareWorkspaceLike = Pick<
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
  setStrategy?: (strategy: CompareJoinStrategy) => WorkspaceStrategyResult | Promise<WorkspaceStrategyResult>;
};

interface ControllerState {
  selectedNodeIds: string[];
  executableNodeIds: string[];
  canCreatePreview: boolean;
  diagnostics: CompareMessage[];
  preview?: ConfigComparePreviewDto;
  busy: boolean;
}

export function renderConfigCompareWebviewHtml(input: ConfigCompareWebviewRenderInput): string {
  const nonce = input.nonce ?? createNonce();
  const payload = toWebviewPayload(
    input.payload,
    input.executableNodeIds ?? [],
    input.title ?? 'Сравнение конфигураций'
  );
  let html = input.htmlPath
    ? fs.readFileSync(input.htmlPath, 'utf8')
    : readConfigCompareWebviewTemplate();
  html = html.replace(/\$\{webview\.cspSource\}/g, input.webview.cspSource);
  html = html.replace(/\$\{nonce\}/g, nonce);
  html = html.replace(
    '// __CONFIG_COMPARE_DATA_PLACEHOLDER__',
    `window.__configCompareData = ${escapeJsonForScript(JSON.stringify(payload))};`
  );
  return html;
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
  panel: Pick<vscode.WebviewPanel, 'webview' | 'onDidDispose'>,
  workspace: ConfigCompareWorkspaceLike,
  title = 'Сравнение конфигураций'
): vscode.Disposable {
  const state: ControllerState = {
    selectedNodeIds: [],
    executableNodeIds: [],
    canCreatePreview: false,
    diagnostics: [],
    busy: false,
  };

  panel.webview.html = renderConfigCompareWebviewHtml({
    webview: panel.webview,
    payload: workspace.payload,
    executableNodeIds: workspace.listMergeableNodeIds?.() ?? [],
    title,
  });

  const messageSubscription = panel.webview.onDidReceiveMessage(async (rawMessage: unknown) => {
    const message = parseWebviewMessage(rawMessage);
    if (!message) {
      Logger.warn('Ignored invalid configuration compare webview message', rawMessage);
      return;
    }

    try {
      await handleWebviewMessage(panel.webview, workspace, title, state, message);
    } catch (error) {
      Logger.error('Configuration compare webview message failed', error);
      await postMessage(panel.webview, {
        type: 'mergeError',
        message: 'Действие сравнения конфигураций не выполнено.',
        diagnostics: [],
        locked: workspace.payload.locked,
      });
    }
  });

  const disposeSubscription = panel.onDidDispose(() => {
    messageSubscription.dispose();
    workspace.dispose();
  });

  return {
    dispose: () => {
      messageSubscription.dispose();
      disposeSubscription.dispose();
    },
  };
}

export function createNonce(): string {
  return randomBytes(24).toString('base64url');
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
  const result = await workspace.executeApprovedPreview(previewId);
  state.busy = false;
  if (!result.ok) {
    state.diagnostics = result.diagnostics;
    await postError(
      webview,
      'Не удалось выполнить merge.',
      result.diagnostics,
      result.locked,
      result.result?.backupPaths
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

async function postState(
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
  backupPaths?: readonly string[]
): Promise<void> {
  await postMessage(webview, {
    type: 'mergeError',
    message,
    diagnostics: [...diagnostics],
    locked,
    backupPaths: backupPaths ? [...backupPaths] : undefined,
  });
}

async function postMessage(
  webview: Pick<vscode.Webview, 'postMessage'>,
  message: ConfigCompareHostToWebviewMessage
): Promise<void> {
  await webview.postMessage(message);
}

function toWebviewPayload(
  payload: ConfigCompareWebviewPayload,
  executableNodeIds: readonly string[],
  title: string,
  lockedOverride?: boolean
): ConfigCompareWebviewPayloadDto {
  return {
    title,
    root: redactTreeNode(payload.root),
    stats: payload.stats,
    locked: lockedOverride ?? payload.locked,
    strategy: payload.strategy ?? 'right',
    executableNodeIds: [...executableNodeIds],
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
    conflict: node.conflict,
    mergeState: node.mergeState
      ? {
          state: node.mergeState.state,
          reason: node.mergeState.reason,
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

function toPreviewDto(
  preview: WorkspacePreviewDto,
  approved: boolean,
  root: CompareTreeNode
): ConfigComparePreviewDto {
  const items = preview.items.map((item) => ({
    ...item,
    destructive: findTreeNode(root, item.nodeId)?.destructive === true ? true : undefined,
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

function parseWebviewMessage(message: unknown): ConfigCompareWebviewToHostMessage | undefined {
  if (!isRecord(message) || typeof message.type !== 'string') {
    return undefined;
  }

  switch (message.type) {
    case 'ready':
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-\${nonce}'; script-src 'nonce-\${nonce}';">
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
