// src/bindings/deployApplicationService.ts
// Unified Deploy Application Service (Architecture Roadmap #267, Issue #255).
// Centralizes target resolution, support preflight, Git repository containment,
// execution orchestration, and typed domain outcomes across UI and Agent surfaces.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BindingManager } from './bindingManager';
import { InfobaseStorageService } from '../infobases/infobaseStorageService';
import {
  DeployService,
  listDeployTargetLabels,
  resolveConfigurationXmlDirectory,
  resolveDeployTargetsForBinding,
  type DeployItemErrorCode,
  type DeployItemResult,
  type DeployRunSummary,
  type DeploySupportContext,
} from './deployService';
import type { ConfigurationBinding } from './models/configurationBinding';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';
import { MetadataType, type TreeNode } from '../models/treeNode';
import type { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import {
  detectChangedConfigFiles,
  findDeepestContainingRepository,
  type GitRepository,
  type IncrementalChangeDetectorDeps,
} from '../services/ibcmd/incrementalChangeDetector';
import { validateDeployRelativeFiles } from '../services/ibcmd/deployPathValidator';
import { runInfobaseConfigExportStatus } from '../infobases/infobaseConfigCommands';
import { createProcessOutputLineReporter } from '../services/process/processOutputLineReporter';
import type { ProcessTreeTerminationOutcome } from '../services/ibcmd/processTreeTermination';
import { findBinding } from '../agent/agentBindingResolver';
import { findWorkspaceFolderForPath } from '../agent/agentWorkspaceContext';
import { detectIbcmdExtensionNameFromConfigRelativePath, normalizeConfigRelativePath } from './bindingPathUtils';
import { CONFIGURATION_XML } from '../constants/fileNames';

// ─── Types & Interfaces ──────────────────────────────────────────────────────

export type DeployTargetInput =
  | { kind: 'path'; path?: string; allowFuzzyMatch?: boolean }
  | { kind: 'coords'; workspaceFolderName: string; configRelativePath: string; ibcmdExtensionName?: string }
  | { kind: 'node'; node: TreeNode; treeDataProvider: MetadataTreeDataProvider };

export interface ResolvedDeployContext {
  readonly configRoot: string;
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly workspaceFolderRoot: string;
  readonly binding: ConfigurationBinding;
  readonly catalog: InfobaseEntry[];
  readonly deployTargets: InfobaseEntry[];
  readonly skippedTargets: DeployItemResult[];
  readonly previewLabels: string[];
}

export type DeployPlanResult =
  | { readonly ok: true; readonly context: ResolvedDeployContext }
  | { readonly ok: false; readonly error: string; readonly code?: string };

export interface DeployExecutionOptions {
  readonly token?: vscode.CancellationToken;
  readonly progress?: vscode.Progress<{ message?: string; increment?: number }>;
  readonly onOutput?: (chunk: string) => void;
  readonly reportStage?: (stage: string) => void;
}

export type DeployOutcomeStatus = 'success' | 'partial' | 'inDoubt' | 'cancelled' | 'error';

export interface DeployResultData {
  summary: {
    success: number;
    error: number;
    inDoubt: number;
    skipped: number;
    hasPartial: boolean;
  };
  results: Array<{
    infobase: string;
    status: DeployItemResult['status'];
    message: string;
    errorCode?: string;
    skippedFiles?: readonly string[];
    effectPossible?: boolean;
    termination?: ProcessTreeTerminationOutcome;
  }>;
}

export interface DeployOutcome {
  readonly success: boolean;
  readonly status: DeployOutcomeStatus;
  readonly code?: string;
  readonly error?: string;
  readonly message: string;
  readonly summary: DeployRunSummary;
  readonly data: DeployResultData;
}

export interface ExportStatusOutcome {
  readonly success: boolean;
  readonly status: 'success' | 'cancelled' | 'inDoubt' | 'error';
  readonly message: string;
  readonly code?: string;
  readonly error?: string;
  readonly effectPossible?: boolean;
  readonly termination?: ProcessTreeTerminationOutcome;
}

export interface DeployApplicationServiceDeps {
  readonly bindingManager: BindingManager;
  readonly infobaseStorage: InfobaseStorageService;
  readonly getConfigPath?: () => string | null;
  readonly resolveSupportContext?: (
    configRoot: string,
    workspaceFolderRoot: string,
    binding: ConfigurationBinding,
  ) => Promise<DeploySupportContext | undefined>;
  readonly deployService?: DeployService;
  readonly gitDeps?: IncrementalChangeDetectorDeps;
}

// ─── Service Implementation ──────────────────────────────────────────────────

export class DeployApplicationService {
  private readonly deployService: DeployService;

  constructor(private readonly deps: DeployApplicationServiceDeps) {
    this.deployService = deps.deployService ?? new DeployService();
  }

  // ─── 1. Target and Context Resolution ─────────────────────────────────────

  async prepareDeploy(target: DeployTargetInput): Promise<DeployPlanResult> {
    try {
      let workspaceFolderName: string | undefined;
      let configRelativePath: string | undefined;
      let ibcmdExtensionName: string | undefined;
      let matchedBinding: ConfigurationBinding | undefined;
      let targetWorkspaceFolder: vscode.WorkspaceFolder | undefined;

      if (target.kind === 'node') {
        const resolvedTarget = resolveConfigRootFromAnyNode(target.node, target.treeDataProvider);
        if (!resolvedTarget) {
          return {
            ok: false,
            error: 'Не удалось сопоставить выгрузку с workspace. Выберите узел внутри конфигурации с привязанной базой.',
            code: 'TARGET_NOT_RESOLVED',
          };
        }
        workspaceFolderName = resolvedTarget.workspaceFolderName;
        configRelativePath = resolvedTarget.configRelativePath;
        ibcmdExtensionName = resolvedTarget.ibcmdExtensionName;
      } else if (target.kind === 'coords') {
        workspaceFolderName = target.workspaceFolderName;
        configRelativePath = target.configRelativePath;
        ibcmdExtensionName = target.ibcmdExtensionName;
      } else if (target.kind === 'path') {
        const resolvedPath = target.path ? path.resolve(target.path) : this.deps.getConfigPath?.();
        if (!resolvedPath) {
          return {
            ok: false,
            error: 'Путь к конфигурации не задан. Укажите configPath или откройте конфигурацию в дереве.',
            code: 'CONFIG_PATH_UNRESOLVED',
          };
        }

        const ws = findWorkspaceFolderForPath(resolvedPath);
        if (!ws) {
          return {
            ok: false,
            error: 'Не найдена папка workspace для конфигурации.',
            code: 'WORKSPACE_NOT_FOUND',
          };
        }
        targetWorkspaceFolder = ws;
        workspaceFolderName = ws.name;

        // Walk up from resolvedPath to workspaceFolder root to find nearest Configuration.xml
        let currentDir = fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()
          ? resolvedPath
          : path.dirname(resolvedPath);
        while (currentDir.length >= ws.uri.fsPath.length) {
          const candidate = path.join(currentDir, CONFIGURATION_XML);
          if (fs.existsSync(candidate)) {
            const rel = normalizeConfigRelativePath(
              path.relative(ws.uri.fsPath, candidate).replace(/\\/g, '/'),
            );
            const extName = detectIbcmdExtensionNameFromConfigRelativePath(rel);
            configRelativePath = rel;
            ibcmdExtensionName = extName;
            let direct: ConfigurationBinding | undefined;
            if (typeof this.deps.bindingManager.get === 'function') {
              direct = await this.deps.bindingManager.get(ws.name, rel, extName);
            } else if (typeof this.deps.bindingManager.listAll === 'function') {
              const all = await this.deps.bindingManager.listAll();
              direct = all.find(
                (b) =>
                  b.workspaceFolder === ws.name &&
                  b.configRelativePath === rel &&
                  (extName ? b.ibcmdExtensionName === extName : true),
              );
            }
            if (direct) {
              matchedBinding = direct;
            }
            break;
          }
          const parent = path.dirname(currentDir);
          if (parent === currentDir) {
            break;
          }
          currentDir = parent;
        }

        // If not found directly, optionally check local bindings with fuzzy match
        if (!matchedBinding && target.allowFuzzyMatch) {
          const allBindings = await this.deps.bindingManager.listAll();
          const localBindings = allBindings.filter((b) => b.workspaceFolder === ws.name);
          const found = findBinding(resolvedPath, localBindings);
          if (found) {
            matchedBinding = found;
            configRelativePath = found.configRelativePath;
            ibcmdExtensionName = found.ibcmdExtensionName;
          }
        }
      }

      // Find workspace folder
      const folders = vscode.workspace.workspaceFolders ?? [];
      const workspaceFolder =
        targetWorkspaceFolder ?? folders.find((f) => f.name === workspaceFolderName);
      if (!workspaceFolder) {
        return {
          ok: false,
          error: `Папка workspace не найдена: «${workspaceFolderName ?? ''}».`,
          code: 'WORKSPACE_NOT_FOUND',
        };
      }

      // Resolve binding if not resolved yet
      if (!matchedBinding) {
        if (!configRelativePath) {
          return {
            ok: false,
            error: 'Для конфигурации не задан относительный путь.',
            code: 'NO_CONFIG_PATH',
          };
        }
        if (typeof this.deps.bindingManager.get === 'function') {
          matchedBinding = await this.deps.bindingManager.get(
            workspaceFolder.name,
            configRelativePath,
            ibcmdExtensionName,
          );
        } else if (typeof this.deps.bindingManager.listAll === 'function') {
          const all = await this.deps.bindingManager.listAll();
          matchedBinding = all.find(
            (b) =>
              b.workspaceFolder === workspaceFolder.name &&
              b.configRelativePath === configRelativePath &&
              (ibcmdExtensionName ? b.ibcmdExtensionName === ibcmdExtensionName : true),
          );
        }
      }

      if (!matchedBinding) {
        return {
          ok: false,
          error: 'Для конфигурации не найдена привязка базы. Привяжите базу через «Привязать базы…».',
          code: 'NO_BINDING',
        };
      }

      if (matchedBinding.infobaseIds.length === 0) {
        return {
          ok: false,
          error: 'Для конфигурации нет привязанных баз.',
          code: 'NO_TARGET_INFOBASE',
        };
      }

      // Load catalog and resolve targets
      let catalog: InfobaseEntry[];
      try {
        catalog = await this.deps.infobaseStorage.load();
      } catch {
        return {
          ok: false,
          error: 'Не удалось загрузить каталог информационных баз.',
          code: 'CATALOG_LOAD_FAILED',
        };
      }

      const catalogById = new Map(catalog.map((e) => [e.id, e] as const));
      const { entries, skipped } = resolveDeployTargetsForBinding(matchedBinding, catalogById);
      if (entries.length === 0 && skipped.length > 0) {
        return {
          ok: false,
          error: 'Нет подходящих баз для раскатки (все пропущены).',
          code: 'ALL_TARGETS_SKIPPED',
        };
      }
      if (entries.length === 0) {
        return {
          ok: false,
          error: 'Нет баз для раскатки.',
          code: 'NO_TARGET_INFOBASE',
        };
      }

      const xmlResolved = resolveConfigurationXmlDirectory(
        workspaceFolder.uri.fsPath,
        matchedBinding.configRelativePath,
      );
      if (!xmlResolved.ok) {
        return {
          ok: false,
          error: xmlResolved.message,
          code: 'CONFIG_XML_UNRESOLVED',
        };
      }

      const previewLabels = listDeployTargetLabels(matchedBinding, catalog);

      return {
        ok: true,
        context: {
          configRoot: xmlResolved.sourceDir,
          workspaceFolder,
          workspaceFolderRoot: workspaceFolder.uri.fsPath,
          binding: matchedBinding,
          catalog,
          deployTargets: entries,
          skippedTargets: skipped,
          previewLabels,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'UNEXPECTED_ERROR',
      };
    }
  }

  // ─── 2. Git Detection ─────────────────────────────────────────────────────

  async detectChangedFiles(
    context: ResolvedDeployContext,
  ): Promise<{ ok: true; relativePaths: string[] } | { ok: false; error: string }> {
    const gitDeps = this.resolveGitDeps(context.configRoot);
    const detected = await detectChangedConfigFiles(context.configRoot, gitDeps);
    if ('error' in detected) {
      return { ok: false, error: detected.error };
    }
    return { ok: true, relativePaths: [...detected.relativePaths] };
  }

  private resolveGitDeps(configRoot: string): IncrementalChangeDetectorDeps {
    if (this.deps.gitDeps) {
      return this.deps.gitDeps;
    }
    return {
      getGitRepository: () => {
        const gitExt = vscode.extensions.getExtension<{
          getAPI(version: number): { repositories: GitRepository[] };
        }>('vscode.git');
        const gitApi = gitExt?.exports?.getAPI(1);
        if (!gitApi) {
          return undefined;
        }
        return findDeepestContainingRepository(gitApi.repositories, configRoot);
      },
    };
  }

  // ─── 3. Executions ────────────────────────────────────────────────────────

  async executeDeployBinding(
    context: ResolvedDeployContext,
    options: DeployExecutionOptions = {},
  ): Promise<DeployOutcome> {
    const cancellation = createCancellationScope(options.token);
    const processOutput = createProcessOutputLineReporter(
      options.reportStage ?? (options.onOutput ? undefined : undefined),
    );
    const onOutputHandler = options.onOutput ?? processOutput.accept;
    const progress = options.progress ?? createAdapterProgress(options.reportStage);

    try {
      const support = await this.deps.resolveSupportContext?.(
        context.configRoot,
        context.workspaceFolderRoot,
        context.binding,
      );

      const summary = await this.deployService.deployBinding({
        binding: context.binding,
        workspaceFolderRoot: context.workspaceFolderRoot,
        storage: this.deps.infobaseStorage,
        catalog: context.catalog,
        progress,
        token: cancellation.token,
        support,
        onOutput: onOutputHandler,
      });

      return createDeployOutcome(summary);
    } finally {
      processOutput.flush();
      cancellation.dispose();
    }
  }

  async executeDeployChangedFiles(
    context: ResolvedDeployContext,
    relativeFiles: string[],
    options: DeployExecutionOptions = {},
  ): Promise<DeployOutcome> {
    if (!relativeFiles || relativeFiles.length === 0) {
      const emptySummary: DeployRunSummary = {
        results: [],
        successCount: 0,
        errorCount: 0,
        inDoubtCount: 0,
        skippedCount: 0,
        hasPartial: false,
        cancelledMidChain: false,
      };
      return createDeployOutcome(emptySummary, 'Нет изменённых файлов.');
    }

    const validation = await validateDeployRelativeFiles(context.configRoot, relativeFiles);
    if (!validation.ok) {
      return createValidationFailedOutcome(validation.error);
    }

    const cancellation = createCancellationScope(options.token);
    const processOutput = createProcessOutputLineReporter(options.reportStage);
    const onOutputHandler = options.onOutput ?? processOutput.accept;
    const progress = options.progress ?? createAdapterProgress(options.reportStage);

    try {
      const support = await this.deps.resolveSupportContext?.(
        context.configRoot,
        context.workspaceFolderRoot,
        context.binding,
      );

      const summary = await this.deployService.deployChangedFiles({
        binding: context.binding,
        workspaceFolderRoot: context.workspaceFolderRoot,
        storage: this.deps.infobaseStorage,
        catalog: context.catalog,
        relativeFiles,
        progress,
        token: cancellation.token,
        support,
        onOutput: onOutputHandler,
      });

      return createDeployOutcome(summary);
    } finally {
      processOutput.flush();
      cancellation.dispose();
    }
  }

  async executeDeploySelectedObjects(
    context: ResolvedDeployContext,
    selectedNodes: readonly TreeNode[],
    options: DeployExecutionOptions = {},
  ): Promise<DeployOutcome> {
    const cancellation = createCancellationScope(options.token);
    const processOutput = createProcessOutputLineReporter(options.reportStage);
    const onOutputHandler = options.onOutput ?? processOutput.accept;
    const progress = options.progress ?? createAdapterProgress(options.reportStage);

    try {
      const support = await this.deps.resolveSupportContext?.(
        context.configRoot,
        context.workspaceFolderRoot,
        context.binding,
      );

      const summary = await this.deployService.deploySelectedObjects({
        binding: context.binding,
        workspaceFolderRoot: context.workspaceFolderRoot,
        storage: this.deps.infobaseStorage,
        catalog: context.catalog,
        selectedNodes,
        progress,
        token: cancellation.token,
        support,
        onOutput: onOutputHandler,
      });

      return createDeployOutcome(summary);
    } finally {
      processOutput.flush();
      cancellation.dispose();
    }
  }

  async executePullSelectedObjects(
    context: ResolvedDeployContext,
    selectedNodes: readonly TreeNode[],
    options: DeployExecutionOptions & { entry?: InfobaseEntry } = {},
  ): Promise<DeployOutcome> {
    const cancellation = createCancellationScope(options.token);
    const processOutput = createProcessOutputLineReporter(options.reportStage);
    const onOutputHandler = options.onOutput ?? processOutput.accept;
    const progress = options.progress ?? createAdapterProgress(options.reportStage);

    const targetEntry = options.entry ?? context.deployTargets[0];
    if (!targetEntry) {
      return createValidationFailedOutcome('Нет доступных баз для выгрузки.');
    }

    try {
      const summary = await this.deployService.pullSelectedObjects({
        binding: context.binding,
        workspaceFolderRoot: context.workspaceFolderRoot,
        storage: this.deps.infobaseStorage,
        entry: targetEntry,
        selectedNodes,
        progress,
        token: cancellation.token,
        onOutput: onOutputHandler,
      });

      return createDeployOutcome(summary, undefined, false);
    } finally {
      processOutput.flush();
      cancellation.dispose();
    }
  }

  // ─── 4. High-Level Facade Methods ─────────────────────────────────────────

  async deploy(
    target: DeployTargetInput,
    options: DeployExecutionOptions = {},
  ): Promise<DeployOutcome> {
    const plan = await this.prepareDeploy(target);
    if (!plan.ok) {
      return createTargetFailedOutcome(plan.error, plan.code);
    }
    return this.executeDeployBinding(plan.context, options);
  }

  async deployChanged(
    target: DeployTargetInput,
    options: DeployExecutionOptions = {},
  ): Promise<DeployOutcome> {
    const plan = await this.prepareDeploy(target);
    if (!plan.ok) {
      return createTargetFailedOutcome(plan.error, plan.code);
    }
    const changes = await this.detectChangedFiles(plan.context);
    if (!changes.ok) {
      return createValidationFailedOutcome(changes.error);
    }
    return this.executeDeployChangedFiles(plan.context, changes.relativePaths, options);
  }

  async deployFiles(
    target: DeployTargetInput,
    files: string[],
    options: DeployExecutionOptions = {},
  ): Promise<DeployOutcome> {
    if (!files || files.length === 0) {
      return createValidationFailedOutcome('Список файлов не задан.');
    }
    const plan = await this.prepareDeploy(target);
    if (!plan.ok) {
      return createTargetFailedOutcome(plan.error, plan.code);
    }
    return this.executeDeployChangedFiles(plan.context, files, options);
  }

  async pullObjects(
    target: DeployTargetInput,
    objectIds: string[],
    options: DeployExecutionOptions & { infobaseName?: string } = {},
  ): Promise<DeployOutcome> {
    if (!objectIds || objectIds.length === 0) {
      return createValidationFailedOutcome('Список objectIds не задан.');
    }
    const plan = await this.prepareDeploy(target);
    if (!plan.ok) {
      return createTargetFailedOutcome(plan.error, plan.code);
    }

    let selectedEntry: InfobaseEntry | undefined;
    if (options.infobaseName) {
      const lower = options.infobaseName.toLowerCase();
      selectedEntry = plan.context.deployTargets.find((e) => e.name.toLowerCase() === lower);
      if (!selectedEntry) {
        return createValidationFailedOutcome(
          `База с именем «${options.infobaseName}» не найдена среди привязанных.`,
        );
      }
    } else {
      selectedEntry = plan.context.deployTargets[0];
    }

    const nodes: TreeNode[] = objectIds.map((id) => {
      const dotIdx = id.indexOf('.');
      const type = dotIdx >= 0 ? id.substring(0, dotIdx) : id;
      const name = dotIdx >= 0 ? id.substring(dotIdx + 1) : '';
      return { id, name, type: type as MetadataType, properties: {} };
    });

    return this.executePullSelectedObjects(plan.context, nodes, { ...options, entry: selectedEntry });
  }

  async executeExportStatus(
    context: ResolvedDeployContext,
    options: DeployExecutionOptions = {},
  ): Promise<ExportStatusOutcome> {
    const configDumpInfoPath = path.join(context.configRoot, 'ConfigDumpInfo.xml');
    if (!fs.existsSync(configDumpInfoPath)) {
      const err = `Файл ConfigDumpInfo.xml не найден в каталоге конфигурации: ${context.configRoot}`;
      return {
        success: false,
        status: 'error',
        message: err,
        code: 'CONFIG_DUMP_INFO_MISSING',
        error: err,
      };
    }

    const entry = context.deployTargets[0];
    if (!entry) {
      return {
        success: false,
        status: 'error',
        message: 'Нет баз для проверки статуса.',
        code: 'NO_TARGET_INFOBASE',
        error: 'Нет баз для проверки статуса.',
      };
    }

    const cancellation = createCancellationScope(options.token);
    const processOutput = createProcessOutputLineReporter(options.reportStage);

    try {
      const result = await runInfobaseConfigExportStatus({
        entry,
        configDumpInfoPath,
        storage: this.deps.infobaseStorage,
        token: cancellation.token,
        ibcmdExtensionName: context.binding.ibcmdExtensionName,
        onOutput: processOutput.accept,
      });

      return {
        success: result.status === 'success',
        status: result.status,
        message: result.userMessage,
        code: result.status === 'cancelled' ? 'REQUEST_CANCELLED' : undefined,
        error: result.status !== 'success' ? result.userMessage : undefined,
        effectPossible: result.effectPossible,
        termination: result.termination,
      };
    } finally {
      processOutput.flush();
      cancellation.dispose();
    }
  }

  async exportStatus(
    target: DeployTargetInput,
    options: DeployExecutionOptions = {},
  ): Promise<ExportStatusOutcome> {
    const plan = await this.prepareDeploy(target);
    if (!plan.ok) {
      return {
        success: false,
        status: 'error',
        message: plan.error,
        code: plan.code,
        error: plan.error,
      };
    }
    return this.executeExportStatus(plan.context, options);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createCancellationScope(token?: vscode.CancellationToken): {
  readonly token: vscode.CancellationToken;
  dispose(): void;
} {
  if (token) {
    return { token, dispose: () => undefined };
  }
  const source = new vscode.CancellationTokenSource();
  return { token: source.token, dispose: () => source.dispose() };
}

function createAdapterProgress(reportStage?: (message: string) => void): vscode.Progress<{ message?: string }> {
  return {
    report: ({ message }) => {
      if (message) {
        reportStage?.(message);
      }
    },
  };
}

export function projectDeployRunSummary(
  summary: DeployRunSummary,
  includeSkippedFiles = true,
): DeployResultData {
  return {
    summary: {
      success: summary.successCount,
      error: summary.errorCount,
      inDoubt: summary.inDoubtCount,
      skipped: summary.skippedCount,
      hasPartial: summary.hasPartial,
    },
    results: summary.results.map((result) => ({
      infobase: result.name || result.infobaseId,
      status: result.status,
      message: result.message,
      errorCode: result.errorCode,
      ...(includeSkippedFiles ? { skippedFiles: result.skippedFiles } : {}),
      effectPossible: result.effectPossible,
      termination: result.termination,
    })),
  };
}

export function formatDeployRunSummary(summary: Pick<DeployRunSummary, 'successCount' | 'errorCount' | 'inDoubtCount' | 'skippedCount' | 'hasPartial' | 'cancelledMidChain'>): {
  message: string;
  fullySuccessful: boolean;
} {
  const tail = summary.cancelledMidChain ? ' Часть баз пропущена (отмена).' : '';
  const parts: string[] = [`${summary.successCount} успешно`];
  if (summary.errorCount > 0) {
    parts.push(`${summary.errorCount} с ошибками`);
  }
  if (summary.inDoubtCount > 0) {
    parts.push(`${summary.inDoubtCount} с неопределённым результатом`);
  }
  if (summary.skippedCount > 0) {
    parts.push(`${summary.skippedCount} пропущено`);
  }
  return {
    message: `Раскатка завершена: ${parts.join(', ')}.${tail}`,
    fullySuccessful:
      summary.errorCount === 0 &&
      summary.inDoubtCount === 0 &&
      !summary.cancelledMidChain &&
      !summary.hasPartial,
  };
}

export function createDeployOutcome(
  summary: DeployRunSummary,
  overrideError?: string,
  includeSkippedFiles = true,
): DeployOutcome {
  const presentation = formatDeployRunSummary(summary);
  const fullySuccessful = overrideError ? false : presentation.fullySuccessful;

  let status: DeployOutcomeStatus = 'success';
  if (summary.inDoubtCount > 0) {
    status = 'inDoubt';
  } else if (summary.errorCount > 0) {
    status = 'error';
  } else if (summary.cancelledMidChain) {
    status = 'cancelled';
  } else if (summary.hasPartial) {
    status = 'partial';
  }

  let code: string | undefined;
  if (summary.inDoubtCount > 0) {
    code = 'DEPLOY_OPERATION_IN_DOUBT';
  } else if (summary.cancelledMidChain && summary.errorCount === 0) {
    code = 'REQUEST_CANCELLED';
  } else {
    code = summary.results.find((r) => r.errorCode)?.errorCode;
  }

  let error = overrideError;
  if (!error) {
    if (summary.inDoubtCount > 0) {
      error =
        summary.errorCount > 0
          ? `Раскатка завершена с неопределённым результатом: ${summary.inDoubtCount}; подтверждённых ошибок: ${summary.errorCount}`
          : `Раскатка завершена с неопределённым результатом: ${summary.inDoubtCount}`;
    } else if (summary.errorCount > 0) {
      error = `Раскатка завершена с ошибками: ${summary.errorCount}`;
    } else if (summary.cancelledMidChain) {
      error = 'Раскатка отменена до завершения всех целей.';
    } else if (summary.hasPartial) {
      error = 'Раскатка выполнена частично: часть запрошенных файлов пропущена.';
    }
  }

  return {
    success: fullySuccessful,
    status,
    code,
    error,
    message: presentation.message,
    summary,
    data: projectDeployRunSummary(summary, includeSkippedFiles),
  };
}

function createTargetFailedOutcome(error: string, code?: string): DeployOutcome {
  const summary: DeployRunSummary = {
    results: [{ infobaseId: '', name: '', status: 'error', message: error, errorCode: code as DeployItemErrorCode }],
    successCount: 0,
    errorCount: 1,
    inDoubtCount: 0,
    skippedCount: 0,
    hasPartial: false,
    cancelledMidChain: false,
  };
  return {
    success: false,
    status: 'error',
    code,
    error,
    message: error,
    summary,
    data: projectDeployRunSummary(summary),
  };
}

function createValidationFailedOutcome(error: string): DeployOutcome {
  return createTargetFailedOutcome(error, 'VALIDATION_FAILED');
}

/**
 * Resolves the binding target by walking up the tree from any node to the nearest
 * Configuration or Extension ancestor.
 */
export function resolveConfigRootFromAnyNode(
  node: TreeNode,
  treeDataProvider: MetadataTreeDataProvider,
): { workspaceFolderName: string; configRelativePath: string; ibcmdExtensionName?: string } | undefined {
  let current: TreeNode | undefined = node;
  while (current) {
    if (current.type === MetadataType.Configuration || current.type === MetadataType.Extension) {
      const target = resolveBindingTargetFromMetadataTreeNode(current, treeDataProvider);
      if (target) {
        return target;
      }
    }
    current = current.parent as TreeNode | undefined;
  }
  return undefined;
}

export function resolveBindingTargetFromMetadataTreeNode(
  node: TreeNode,
  tree: MetadataTreeDataProvider,
): { workspaceFolderName: string; configRelativePath: string; ibcmdExtensionName?: string } | undefined {
  if (node.type === MetadataType.Configuration) {
    const configDir = tree.getConfigPathForNode(node);
    if (!configDir) {
      return undefined;
    }
    const configXmlFs = path.join(configDir, CONFIGURATION_XML);
    const uri = vscode.Uri.file(configXmlFs);
    const wf = vscode.workspace.getWorkspaceFolder(uri);
    if (!wf) {
      return undefined;
    }
    const rel = path.relative(wf.uri.fsPath, configXmlFs).replace(/\\/g, '/');
    const configRelativePath = normalizeConfigRelativePath(rel);
    const ibcmdExtensionName = detectIbcmdExtensionNameFromConfigRelativePath(configRelativePath);
    return { workspaceFolderName: wf.name, configRelativePath, ibcmdExtensionName };
  }

  if (node.type === MetadataType.Extension) {
    const props = node.properties as Record<string, unknown> | undefined;
    if (props?.isExtension !== true) {
      return undefined;
    }
    const dir = node.filePath?.trim();
    if (!dir) {
      return undefined;
    }
    const configXmlFs = path.join(dir, CONFIGURATION_XML);
    if (!fs.existsSync(configXmlFs)) {
      return undefined;
    }
    const uri = vscode.Uri.file(configXmlFs);
    const wf = vscode.workspace.getWorkspaceFolder(uri);
    if (!wf) {
      return undefined;
    }
    const rel = path.relative(wf.uri.fsPath, configXmlFs).replace(/\\/g, '/');
    const configRelativePath = normalizeConfigRelativePath(rel);
    const ibcmdExtensionName = detectIbcmdExtensionNameFromConfigRelativePath(configRelativePath);
    return { workspaceFolderName: wf.name, configRelativePath, ibcmdExtensionName };
  }

  return undefined;
}
