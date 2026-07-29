/**
 * WOW plan §2D #39–42 — последовательная раскатка выгрузки в привязанные ИБ (ibcmd config import).
 * WOW plan §2E #44–45 — режимы раскатки: copy (снимок во временный каталог), block (readonly дерева конфигурации).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { normalizeConfigRelativePath } from './bindingPathUtils';
import type { ConfigurationBinding } from './models/configurationBinding';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';
import type { InfobaseStorageService } from '../infobases/infobaseStorageService';
import {
  appendIbcmdOutputLine,
  runInfobaseConfigImportFromDirectory,
  runInfobaseConfigIncrementalImport,
  runInfobaseConfigExportObjects,
} from '../infobases/infobaseConfigCommands';
import { runInfobaseConfigurationOperation } from '../infobases/infobaseConfigurationOperationQueue';
import { resolveInfobaseCanonicalIdentity } from '../infobases/infobaseCanonicalIdentity';
import { getIbcmdService } from '../services/ibcmd/ibcmdServiceSingleton';
import { collectFilesForSelection, resolveIbcmdObjectId } from '../services/ibcmd/objectFileCollector';
import { detectDeployGuards } from './deployPreflightGuards';
import { expandBslSiblings } from './bslExpansion';
import { checkRecentDeploy, recordDeploy } from './deployDedupCache';
import { runIbcmdXmlImportPreflight } from '../services/ibcmdXmlPreflightService';
import {
  DeployLockedObjectsPlanner,
  type DeploySupportPlannerRequest,
  type DeploySupportPreflight,
  type DeploySupportPreflightErrorCode,
  filterOutLockedObjectFiles,
} from './deployLockedObjectsFilter';
import { MESSAGES } from '../constants/messages';
import type { TreeNode } from '../models/treeNode';
import type { ConfigurationId } from '../services/configurationSession/types';
import type { SupportApplicationFacade } from '../support/supportApplicationServiceRegistry';
import type { MasterSupportState, SupportStatusResult } from '../support/supportTypes';
import {
  assertExistingPathWithinRootSync,
  PathBoundaryError,
  validateWorkspaceRelativePath,
} from '../services/configurationSession/pathBoundary';

export type DeployItemStatus = 'success' | 'error' | 'skipped';

export interface DeployItemResult {
  readonly infobaseId: string;
  readonly name: string;
  readonly status: DeployItemStatus;
  readonly message: string;
  readonly errorCode?: DeploySupportErrorCode;
  readonly skippedFiles?: readonly string[];
}

export interface DeployRunSummary {
  readonly results: DeployItemResult[];
  readonly successCount: number;
  readonly errorCount: number;
  /** Предпролётные пропуски, веб-базы, отмена и т.п. */
  readonly skippedCount: number;
  /** At least one target omitted concrete requested files from its result. */
  readonly hasPartial: boolean;
  /** Пользователь отменил во время цепочки — дальнейшие базы не запускались. */
  readonly cancelledMidChain: boolean;
}

export interface DeployProgressSink {
  report(value: { message?: string; increment?: number }): void;
}

export type DeploySupportErrorCode =
  | DeploySupportPreflightErrorCode
  | 'SUPPORT_DEPLOY_TARGET_NOT_REPLICATED'
  | 'SUPPORT_BINDING_INVALID'
  | 'SUPPORT_TARGET_UNSUPPORTED'
  | 'SUPPORT_FILE_MISSING'
  | 'SUPPORT_NOT_MANAGED'
  | 'SUPPORT_REPLICATION_FAILED'
  | 'SUPPORT_REPLICATION_INCOMPLETE'
  | 'SUPPORT_TARGET_SELECTION_REJECTED';

/** Exact support facade/identity pair supplied by UI and Agent composition roots. */
export interface DeploySupportContext {
  readonly configurationId: ConfigurationId;
  readonly facade: Pick<SupportApplicationFacade, 'getStatus' | 'getMasterStatus' | 'sync'>;
}

export type DeployMode = 'copy' | 'block';

/** Режим из настроек `1cMetadataTree.deploy.mode` (по умолчанию copy, дизайн §16.5). */
export function readDeployMode(): DeployMode {
  const v = vscode.workspace.getConfiguration('1cMetadataTree').get<string>('deploy.mode', 'copy');
  return v === 'block' ? 'block' : 'copy';
}

/** Optional XML precheck gate before deploy import (default off). */
export function readDeployPrecheckXmlBeforeImportSetting(): boolean {
  return vscode.workspace.getConfiguration('1cMetadataTree').get<boolean>('deploy.precheckXmlBeforeImport') === true;
}

/**
 * VS Code 1.88+: `files.readonlyInclude` для временной блокировки редактирования (дизайн §16.5).
 */
export function vscodeSupportsDeployReadonlyLock(): boolean {
  const m = /^(\d+)\.(\d+)/.exec(vscode.version);
  if (!m) {
    return false;
  }
  const major = parseInt(m[1]!, 10);
  const minor = parseInt(m[2]!, 10);
  return major > 1 || (major === 1 && minor >= 88);
}

/**
 * Glob относительно корня workspace folder: дерево выгрузки (папка с Configuration.xml).
 * Если Configuration.xml в корне папки — `**` (вся папка workspace).
 */
export function configurationTreeReadonlyGlob(configRelativePath: string): string {
  const norm = normalizeConfigRelativePath(configRelativePath);
  const dir = path.posix.dirname(norm);
  if (!dir || dir === '.') {
    return '**';
  }
  return `${dir}/**`;
}

async function applyReadonlyIncludeForDeploy(
  workspaceFolderRoot: string,
  globPattern: string,
): Promise<{ dispose: () => Promise<void> } | undefined> {
  if (!vscodeSupportsDeployReadonlyLock()) {
    return undefined;
  }
  const scope = vscode.Uri.file(workspaceFolderRoot);
  const cfg = vscode.workspace.getConfiguration('files', scope);
  const before = cfg.get<Record<string, boolean> | undefined>('readonlyInclude');
  const merged: Record<string, boolean> = { ...(before ?? {}), [globPattern]: true };
  try {
    await cfg.update('readonlyInclude', merged, vscode.ConfigurationTarget.WorkspaceFolder);
  } catch {
    return undefined;
  }
  return {
    async dispose() {
      try {
        await cfg.update('readonlyInclude', before, vscode.ConfigurationTarget.WorkspaceFolder);
      } catch {
        /* не мешаем завершению раскатки */
      }
    },
  };
}

const DEPLOY_SNAPSHOT_COPY_CONCURRENCY = 8;

export class DeploySnapshotCancelledError extends Error {
  readonly code = 'DEPLOY_SNAPSHOT_CANCELLED';

  constructor() {
    super('Deploy snapshot creation cancelled');
    this.name = 'DeploySnapshotCancelledError';
  }
}

export interface DeploySnapshotOptions {
  readonly concurrency?: number;
  /** Test seam; production uses fs.promises.copyFile. */
  readonly copyFile?: (source: string, destination: string) => Promise<void>;
}

interface DeploySnapshotPlan {
  readonly directories: Array<{ source: string; relativePath: string }>;
  readonly files: Array<{ source: string; relativePath: string }>;
  readonly symlinks: Array<{ source: string; relativePath: string }>;
}

function throwIfSnapshotCancelled(token: Pick<vscode.CancellationToken, 'isCancellationRequested'>): void {
  if (token.isCancellationRequested) {
    throw new DeploySnapshotCancelledError();
  }
}

async function buildDeploySnapshotPlan(
  sourceDir: string,
  token: Pick<vscode.CancellationToken, 'isCancellationRequested'>,
): Promise<DeploySnapshotPlan> {
  const directories: DeploySnapshotPlan['directories'] = [];
  const files: DeploySnapshotPlan['files'] = [];
  const symlinks: DeploySnapshotPlan['symlinks'] = [];
  const pending = [{ source: sourceDir, relativePath: '' }];

  while (pending.length > 0) {
    throwIfSnapshotCancelled(token);
    const current = pending.pop()!;
    const stat = await fs.promises.lstat(current.source);
    if (stat.isSymbolicLink()) {
      symlinks.push(current);
      continue;
    }
    if (stat.isDirectory()) {
      directories.push(current);
      const entries = await fs.promises.readdir(current.source, { withFileTypes: true });
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index]!;
        pending.push({
          source: path.join(current.source, entry.name),
          relativePath: path.join(current.relativePath, entry.name),
        });
      }
      continue;
    }
    if (stat.isFile()) {
      files.push(current);
    }
  }

  return { directories, files, symlinks };
}

async function mapDeploySnapshotLimit<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.min(Math.floor(concurrency), items.length || 1));
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  async function run(): Promise<void> {
    while (nextIndex < items.length && !failed) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        await worker(items[index]!);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, run));
  if (failed) {
    throw firstError;
  }
}

/** Async, bounded and cancellation-aware deploy snapshot. */
export async function createConfigurationSnapshot(
  sourceDir: string,
  token: Pick<vscode.CancellationToken, 'isCancellationRequested'>,
  options: DeploySnapshotOptions = {},
): Promise<string> {
  const plan = await buildDeploySnapshotPlan(sourceDir, token);
  throwIfSnapshotCancelled(token);

  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), '1cv-deploy-snap-'));
  const destination = path.join(parent, 'cfg');
  try {
    for (const directory of plan.directories) {
      throwIfSnapshotCancelled(token);
      await fs.promises.mkdir(path.join(destination, directory.relativePath), { recursive: true });
    }
    for (const link of plan.symlinks) {
      throwIfSnapshotCancelled(token);
      const target = await fs.promises.readlink(link.source);
      await fs.promises.symlink(target, path.join(destination, link.relativePath));
    }
    const copyFile = options.copyFile ?? fs.promises.copyFile.bind(fs.promises);
    await mapDeploySnapshotLimit(
      plan.files,
      options.concurrency ?? DEPLOY_SNAPSHOT_COPY_CONCURRENCY,
      async (file) => {
        throwIfSnapshotCancelled(token);
        await copyFile(file.source, path.join(destination, file.relativePath));
        throwIfSnapshotCancelled(token);
      },
    );
    return destination;
  } catch (error) {
    await fs.promises.rm(parent, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Резолв каталога выгрузки: родительский каталог Configuration.xml (как в интерактивном import).
 */
export function resolveConfigurationXmlDirectory(
  workspaceFolderRoot: string,
  configRelativePath: string,
): { ok: true; sourceDir: string; configXml: string } | { ok: false; message: string } {
  if (!configRelativePath.trim()) {
    return { ok: false, message: 'Не задан относительный путь к Configuration.xml.' };
  }
  let rel: string;
  try {
    rel = validateWorkspaceRelativePath(configRelativePath);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const configXml = path.resolve(workspaceFolderRoot, rel);
  const base = path.basename(configXml);
  if (base.toLowerCase() !== 'configuration.xml') {
    return {
      ok: false,
      message: 'Ожидался путь к файлу Configuration.xml в привязке.',
    };
  }
  try {
    if (!fs.existsSync(configXml)) {
      return {
        ok: false,
        message: `Файл конфигурации не найден: ${configXml}`,
      };
    }
    const contained = assertExistingPathWithinRootSync(workspaceFolderRoot, configXml);
    return {
      ok: true,
      sourceDir: path.dirname(contained.canonicalTarget),
      configXml: contained.canonicalTarget,
    };
  } catch (error) {
    const detail = error instanceof PathBoundaryError ? error.message : `Не удалось проверить путь: ${configXml}`;
    return { ok: false, message: detail };
  }
}

/** Подписи целей для диалога подтверждения (порядок = порядок раскатки). */
export function listDeployTargetLabels(binding: ConfigurationBinding, catalog: readonly InfobaseEntry[]): string[] {
  const catalogById = new Map(catalog.map((e) => [e.id, e] as const));
  const orderedIds = binding.infobaseIds;
  const activeIds =
    binding.massDeployment === true ? orderedIds : orderedIds.length > 0 ? [orderedIds[0]!] : [];
  const lines: string[] = [];
  for (const id of activeIds) {
    const entry = catalogById.get(id);
    if (!entry) {
      lines.push(`• (${id}) — не найдена в каталоге`);
    } else if (entry.type === 'web') {
      lines.push(`• ${entry.name} — веб-база, будет пропущена`);
    } else {
      lines.push(`• ${entry.name}`);
    }
  }
  return lines;
}

/** Список ИБ для ibcmd import с учётом massDeployment и фильтра веб-баз (для UI и DeployService). */
export function resolveDeployTargetsForBinding(
  binding: ConfigurationBinding,
  catalogById: ReadonlyMap<string, InfobaseEntry>,
): { entries: InfobaseEntry[]; skipped: DeployItemResult[] } {
  const skipped: DeployItemResult[] = [];
  const orderedIds = binding.infobaseIds;
  const activeIds =
    binding.massDeployment === true ? orderedIds : orderedIds.length > 0 ? [orderedIds[0]!] : [];

  const entries: InfobaseEntry[] = [];
  for (const id of activeIds) {
    const entry = catalogById.get(id);
    if (!entry) {
      skipped.push({
        infobaseId: id,
        name: id,
        status: 'skipped',
        message: 'База не найдена в каталоге Infobase Manager.',
      });
      continue;
    }
    if (entry.type === 'web') {
      skipped.push({
        infobaseId: id,
        name: entry.name,
        status: 'skipped',
        message: 'Веб-база: загрузка конфигурации через ibcmd не поддерживается.',
      });
      continue;
    }
    entries.push(entry);
  }
  return { entries, skipped };
}

export interface DeploySelectedObjectsParams {
  binding: ConfigurationBinding;
  workspaceFolderRoot: string;
  storage: InfobaseStorageService;
  catalog: readonly InfobaseEntry[];
  selectedNodes: readonly TreeNode[];
  progress: DeployProgressSink;
  token: vscode.CancellationToken;
  support?: DeploySupportContext;
}

export interface DeployChangedFilesParams {
  binding: ConfigurationBinding;
  workspaceFolderRoot: string;
  storage: InfobaseStorageService;
  catalog: readonly InfobaseEntry[];
  relativeFiles: readonly string[];
  progress: DeployProgressSink;
  token: vscode.CancellationToken;
  support?: DeploySupportContext;
}

export interface PullSelectedObjectsParams {
  binding: ConfigurationBinding;
  workspaceFolderRoot: string;
  storage: InfobaseStorageService;
  entry: InfobaseEntry;
  selectedNodes: readonly TreeNode[];
  progress: DeployProgressSink;
  token: vscode.CancellationToken;
}

export class DeployService {
  constructor(
    private readonly deps: {
      runXmlPreflight?: typeof runIbcmdXmlImportPreflight;
      runIncrementalImport?: typeof runInfobaseConfigIncrementalImport;
    } = {},
  ) {}

  /**
   * Последовательная раскатка: ошибка на одной базе не прерывает остальные (design §12.5).
   * Отмена — после текущей ibcmd пропускает оставшиеся цели.
   */
  async deployBinding(params: {
    binding: ConfigurationBinding;
    workspaceFolderRoot: string;
    storage: InfobaseStorageService;
    catalog: readonly InfobaseEntry[];
    progress: DeployProgressSink;
    token: vscode.CancellationToken;
    support?: DeploySupportContext;
  }): Promise<DeployRunSummary> {
    const catalogById = new Map(params.catalog.map((e) => [e.id, e] as const));
    const resolved = resolveConfigurationXmlDirectory(params.workspaceFolderRoot, params.binding.configRelativePath);
    if (!resolved.ok) {
      const s = summarizeDeployRun(
        [
          {
            infobaseId: '',
            name: '',
            status: 'error',
            message: resolved.message,
          },
        ],
        false,
      );
      appendDeployRunSummaryLine(s);
      return s;
    }

    const supportPreflight = await planDeploySupport(params.support, 'full', []);
    if (isDeploySupportRejected(supportPreflight)) {
      return rejectDeployBeforeIbcmd(supportPreflight);
    }

    const ibcmd = getIbcmdService();
    if ((await ibcmd.resolveExecutablePathAsync()).kind !== 'resolved') {
      const s = summarizeDeployRun(
        [
          {
            infobaseId: '',
            name: '',
            status: 'error',
            message:
              'Исполняемый файл ibcmd не найден. Укажите путь в настройках или переменную IBCMD_PATH.',
          },
        ],
        false,
      );
      appendDeployRunSummaryLine(s);
      return s;
    }

    const { entries, skipped } = resolveDeployTargetsForBinding(params.binding, catalogById);
    const results: DeployItemResult[] = [...skipped];
    const total = entries.length;
    if (total === 0) {
      const s = summarizeDeployRun(results, false);
      appendDeployRunSummaryLine(s);
      return s;
    }

    const mode = readDeployMode();
    const readonlyGlob = configurationTreeReadonlyGlob(params.binding.configRelativePath);
    const readonlyGuard =
      mode === 'block'
        ? await applyReadonlyIncludeForDeploy(params.workspaceFolderRoot, readonlyGlob)
        : undefined;

    if (mode === 'block') {
      if (readonlyGuard) {
        appendIbcmdOutputLine(
          '[раскатка] Режим block: для дерева конфигурации включён только просмотр (files.readonlyInclude) до конца раскатки.',
        );
      } else {
        appendIbcmdOutputLine(
          '[раскатка] Режим block: блокировка через настройки редактора недоступна (нужен VS Code 1.88+). Раскатка продолжится без readonly.',
        );
      }
    }

    let snapshotDir: string | undefined;
    let sourceDir = resolved.sourceDir;

    try {
      if (mode === 'copy') {
        appendIbcmdOutputLine('[раскатка] Режим copy: создаётся снимок папки конфигурации во временный каталог…');
        try {
          snapshotDir = await createConfigurationSnapshot(resolved.sourceDir, params.token);
          sourceDir = snapshotDir;
        } catch (e) {
          if (e instanceof DeploySnapshotCancelledError) {
            for (const entry of entries) {
              results.push({
                infobaseId: entry.id,
                name: entry.name,
                status: 'skipped',
                message: 'Пропущено: отмена пользователя во время создания снимка.',
              });
            }
            const cancelled = summarizeDeployRun(results, true);
            appendDeployRunSummaryLine(cancelled);
            return cancelled;
          }
          const msg = e instanceof Error ? e.message : String(e);
          const s = summarizeDeployRun(
            [
              {
                infobaseId: '',
                name: '',
                status: 'error',
                message: `Не удалось создать копию выгрузки для раскатки: ${msg}`,
              },
            ],
            false,
          );
          appendDeployRunSummaryLine(s);
          return s;
        }
      }

      let cancelledMidChain = false;
      const increment = total > 0 ? 100 / total : 0;

      for (let i = 0; i < entries.length; i++) {
        if (params.token.isCancellationRequested) {
          cancelledMidChain = true;
          for (let j = i; j < entries.length; j++) {
            const e = entries[j]!;
            results.push({
              infobaseId: e.id,
              name: e.name,
              status: 'skipped',
              message: 'Пропущено: отмена пользователя.',
            });
          }
          break;
        }

        const entry = entries[i]!;
        const preflightAndImport = await runInfobaseConfigurationOperation(entry, async () => {
          const supportGate = await synchronizePendingSupportForTarget(
            params.support,
            entry,
            false,
            supportPreflight,
          );
        if (!supportGate.accepted) {
          return supportGate;
        }
        if (readDeployPrecheckXmlBeforeImportSetting()) {
          const preflight = await (this.deps.runXmlPreflight ?? runIbcmdXmlImportPreflight)({
            entry,
            storage: params.storage,
            absoluteSourceDir: sourceDir,
            ibcmdExtensionName: params.binding.ibcmdExtensionName,
          });
          if (!preflight.ok) {
            appendIbcmdOutputLine(
              `[раскатка] ${entry.name}: preflight XML не пройден (${preflight.durationMs} мс) — ${preflight.message}`,
            );
            results.push({
              infobaseId: entry.id,
              name: entry.name,
              status: 'error',
              message: `Preflight XML не пройден: ${preflight.message}`,
            });
            for (let j = i + 1; j < entries.length; j++) {
              const e = entries[j]!;
              results.push({
                infobaseId: e.id,
                name: e.name,
                status: 'skipped',
                message: 'Пропущено: preflight XML завершился ошибкой на предыдущей базе.',
              });
            }
            const s = summarizeDeployRun(results, false);
            appendDeployRunSummaryLine(s);
            return s;
          }
          appendIbcmdOutputLine(
            `[раскатка] ${entry.name}: preflight XML ok (${preflight.durationMs} мс).`,
          );
        }
        params.progress.report({
          message: `Раскатка: ${entry.name} (${i + 1}/${total})`,
          increment,
        });

        return runInfobaseConfigImportFromDirectory({
            storage: params.storage,
            entry,
            absoluteSourceDir: sourceDir,
            token: params.token,
            logContext: 'раскатка',
            ibcmdExtensionName: params.binding.ibcmdExtensionName,
          });
        });
        if (isSupportGateFailure(preflightAndImport)) {
          results.push(targetSupportGateFailure(entry, preflightAndImport));
          continue;
        }
        if ('successCount' in preflightAndImport) {
          return preflightAndImport;
        }
        const interpreted = preflightAndImport;

        if (interpreted.status === 'cancelled') {
          cancelledMidChain = true;
          appendIbcmdOutputLine(`[раскатка] ${entry.name}: отменено — ${interpreted.userMessage}`);
          results.push({
            infobaseId: entry.id,
            name: entry.name,
            status: 'skipped',
            message: interpreted.userMessage,
          });
          for (let j = i + 1; j < entries.length; j++) {
            const e = entries[j]!;
            results.push({
              infobaseId: e.id,
              name: e.name,
              status: 'skipped',
              message: 'Пропущено: отмена.',
            });
          }
          break;
        }

        if (interpreted.status === 'success') {
          appendIbcmdOutputLine(`[раскатка] ${entry.name}: успех — ${interpreted.userMessage}`);
          results.push({
            infobaseId: entry.id,
            name: entry.name,
            status: 'success',
            message: interpreted.userMessage,
          });
        } else {
          appendIbcmdOutputLine(`[раскатка] ${entry.name}: ошибка — ${interpreted.userMessage}`);
          results.push({
            infobaseId: entry.id,
            name: entry.name,
            status: 'error',
            message: interpreted.userMessage,
          });
        }
      }

      const s = summarizeDeployRun(results, cancelledMidChain);
      appendDeployRunSummaryLine(s);
      return s;
    } finally {
      if (snapshotDir) {
        const parent = path.dirname(snapshotDir);
        try {
          await fs.promises.rm(parent, { recursive: true, force: true });
        } catch {
          /* временный каталог не критичен */
        }
      }
      await readonlyGuard?.dispose();
    }
  }

  /**
   * Инкрементальная раскатка: загружает только файлы выбранных объектов метаданных.
   * Не создаёт снимок, не применяет readonly-guard — список файлов уже определён.
   */
  async deploySelectedObjects(params: DeploySelectedObjectsParams): Promise<DeployRunSummary> {
    const catalogById = new Map(params.catalog.map((e) => [e.id, e] as const));
    const resolved = resolveConfigurationXmlDirectory(params.workspaceFolderRoot, params.binding.configRelativePath);
    if (!resolved.ok) {
      const s = summarizeDeployRun([{ infobaseId: '', name: '', status: 'error', message: resolved.message }], false);
      appendDeployRunSummaryLine(s);
      return s;
    }
    const configRoot = resolved.sourceDir;

    const ibcmd = getIbcmdService();
    if ((await ibcmd.resolveExecutablePathAsync()).kind !== 'resolved') {
      const s = summarizeDeployRun(
        [{ infobaseId: '', name: '', status: 'error', message: 'Исполняемый файл ibcmd не найден. Укажите путь в настройках или переменную IBCMD_PATH.' }],
        false,
      );
      appendDeployRunSummaryLine(s);
      return s;
    }

    const relativeFiles = collectFilesForSelection(params.selectedNodes, configRoot);
    if (relativeFiles.length === 0) {
      const s = summarizeDeployRun(
        [{ infobaseId: '', name: '', status: 'error', message: 'Не найдено файлов для выбранных объектов.' }],
        false,
      );
      appendDeployRunSummaryLine(s);
      return s;
    }

    // BSL expansion: for .bsl files add descriptor XML + all sibling files in object dir.
    const withSiblings = expandBslSiblings(relativeFiles, configRoot);
    appendIbcmdOutputLine(`[bsl-expansion] было ${relativeFiles.length} файлов, стало ${withSiblings.length}`);
    const supportPreflight = await planDeploySupport(params.support, 'files', withSiblings);
    if (isDeploySupportRejected(supportPreflight)) {
      return rejectDeployBeforeIbcmd(supportPreflight);
    }
    const deployFiles = supportPreflight?.relativeFiles ?? withSiblings;
    appendSupportFilePlan(supportPreflight);

    // Preflight guards: detect Configuration.xml inclusion and missing files.
    const guards = detectDeployGuards(deployFiles, configRoot);
    appendIbcmdOutputLine(`[preflight] hasConfigurationXml=${guards.hasConfigurationXml}, missingFiles=${guards.missingFiles.length}`);

    if (guards.hasConfigurationXml || guards.missingFiles.length > 0) {
      const parts: string[] = [];
      if (guards.hasConfigurationXml) {
        parts.push('В список попал Configuration.xml. Partial import не поддерживает корневой дескриптор — требуется полная раскатка.');
      }
      if (guards.missingFiles.length > 0) {
        const names = guards.missingFiles.slice(0, 10).map((f) => path.basename(f)).join(', ');
        parts.push(`Некоторые выбранные файлы отсутствуют на диске. Partial import не поддерживает удаления — требуется полная раскатка или пересмотр выбора. Отсутствует: ${names}.`);
      }
      await vscode.window.showWarningMessage(parts.join('\n'), { modal: true }, 'Отмена');
      const s = summarizeDeployRun(
        [{ infobaseId: '', name: '', status: 'skipped', message: 'Раскатка отменена из-за ограничений partial import.' }],
        false,
      );
      appendDeployRunSummaryLine(s);
      return s;
    }

    const hasStructuralFiles = deployFiles.some((f) => f.endsWith('.xml'));

    appendIbcmdOutputLine(`[раскатка выбранных] Найдено файлов: ${deployFiles.length}`);
    for (const f of deployFiles) {
      appendIbcmdOutputLine(`  ${f}`);
    }

    const bindingId = path.resolve(params.workspaceFolderRoot, params.binding.configRelativePath).toLowerCase();

    const { entries, skipped } = resolveDeployTargetsForBinding(params.binding, catalogById);
    const results: DeployItemResult[] = [...skipped];
    const total = entries.length;
    if (total === 0) {
      const s = summarizeDeployRun(results, false);
      appendDeployRunSummaryLine(s);
      return s;
    }

    let cancelledMidChain = false;
    const increment = total > 0 ? 100 / total : 0;

    for (let i = 0; i < entries.length; i++) {
      if (params.token.isCancellationRequested) {
        cancelledMidChain = true;
        for (let j = i; j < entries.length; j++) {
          const e = entries[j]!;
          results.push({ infobaseId: e.id, name: e.name, status: 'skipped', message: 'Пропущено: отмена пользователя.' });
        }
        break;
      }

      const entry = entries[i]!;
      params.progress.report({ message: `Раскатка выбранных: ${entry.name} (${i + 1}/${total})`, increment });

      const doImport = this.deps.runIncrementalImport ?? runInfobaseConfigIncrementalImport;
      const supportAndImport = await runInfobaseConfigurationOperation(entry, async () => {
        const supportGate = await synchronizePendingSupportForTarget(
          params.support,
          entry,
          supportPreflight?.kind === 'ready' && supportPreflight.supportFileRouted,
          supportPreflight,
        );
        if (!supportGate.accepted) {
          return supportGate;
        }
        if (deployFiles.length === 0) {
          return { kind: 'skippedBySupport' as const };
        }
        const dedupResult = checkRecentDeploy(
          { bindingId, infobaseId: entry.id },
          { relativeFiles: deployFiles },
          Date.now(),
        );
        if (dedupResult.isDuplicate) {
          return { kind: 'duplicate' as const, ageMs: dedupResult.ageMs };
        }

        let candidateFiles = deployFiles;
        let importedFiles: readonly string[] = [];
        let reactiveSkippedFiles: readonly string[] = [];
        let reactiveLockObserved = false;
        let interpreted = await doImport({
          storage: params.storage,
          entry,
          configRoot,
          relativeFiles: candidateFiles,
          token: params.token,
          logContext: 'выбранные объекты',
          ibcmdExtensionName: params.binding.ibcmdExtensionName,
        });

        if (interpreted.status === 'error' && interpreted.lockedObjects && interpreted.lockedObjects.length > 0) {
          reactiveLockObserved = true;
          const locked = interpreted.lockedObjects;
          const { kept, filtered } = filterOutLockedObjectFiles(candidateFiles, locked);
          candidateFiles = kept;
          reactiveSkippedFiles = filtered;
          const lockedNames = locked.map((o) => o.fullName).join(', ');
          appendIbcmdOutputLine(
            `[support-mode:fallback] Внешний drift: ${lockedNames}. Отфильтровано файлов: ${filtered.length}; оставлено: ${kept.length}.`,
          );
          if (kept.length === 0) {
            void vscode.window.showWarningMessage(MESSAGES.LOCKED_OBJECTS_ALL_FILTERED);
          } else {
            void vscode.window.showWarningMessage(
              `Состояние поддержки в ИБ изменилось после preflight. Пропущены: ${lockedNames}.`,
            );
            interpreted = await doImport({
              storage: params.storage,
              entry,
              configRoot,
              relativeFiles: kept,
              token: params.token,
              logContext: 'выбранные объекты (без залоченных)',
              ibcmdExtensionName: params.binding.ibcmdExtensionName,
            });
          }
        }

        // Fallback: if import failed and we have structural (.xml) files,
        // offer to retry with Configuration.xml included.
        if (
          interpreted.status === 'error'
          && hasStructuralFiles
          && !reactiveLockObserved
          && !(interpreted.lockedObjects && interpreted.lockedObjects.length > 0)
        ) {
          const retryFiles = stableUniqueFiles(['Configuration.xml', ...candidateFiles]);
          const retrySupportGate = await gateConfigurationXmlRetry(
            params.support,
            entry,
            supportPreflight,
            retryFiles,
          );
          if (!retrySupportGate.accepted) {
            return retrySupportGate;
          }
          const retry = await vscode.window.showWarningMessage(
            `Раскатка в «${entry.name}» не удалась. Повторить с Configuration.xml? ` +
              '(будут применены ВСЕ структурные изменения конфигурации)',
            'Повторить с Configuration.xml',
            'Пропустить',
          );
          if (retry === 'Повторить с Configuration.xml') {
            appendIbcmdOutputLine(`[раскатка выбранных] Повтор с Configuration.xml...`);
            interpreted = await doImport({
              storage: params.storage,
              entry,
              configRoot,
              relativeFiles: retryFiles,
              token: params.token,
              logContext: 'выбранные объекты + Configuration.xml',
              ibcmdExtensionName: params.binding.ibcmdExtensionName,
            });
            candidateFiles = retryFiles;
          }
        }
        if (interpreted.status === 'success') {
          importedFiles = candidateFiles;
        }
        return {
          kind: 'import' as const,
          interpreted,
          importedFiles,
          skippedFiles: reactiveSkippedFiles,
        };
      });
      if (isSupportGateFailure(supportAndImport)) {
        results.push(targetSupportGateFailure(entry, supportAndImport));
        continue;
      }
      if ('kind' in supportAndImport && supportAndImport.kind === 'skippedBySupport') {
        results.push({
          infobaseId: entry.id,
          name: entry.name,
          status: 'skipped',
          message: supportSkipMessage(supportPreflight),
          skippedFiles: supportPreflight?.skippedLockedFiles,
        });
        continue;
      }
      if (supportAndImport.kind === 'duplicate') {
        appendIbcmdOutputLine(
          `[dedup] пропуск ${supportAndImport.ageMs} ms назад уже раскатывали тот же набор на ${entry.name}`,
        );
        results.push({
          infobaseId: entry.id,
          name: entry.name,
          status: 'skipped',
          message: `Пропущено: тот же набор файлов уже раскатывался ${supportAndImport.ageMs} мс назад.`,
          skippedFiles: supportPreflight?.skippedLockedFiles,
        });
        continue;
      }
      const interpreted = supportAndImport.interpreted;
      const skippedFiles = stableUniqueFiles([
        ...(supportPreflight?.skippedLockedFiles ?? []),
        ...supportAndImport.skippedFiles,
      ]);

      if (interpreted.status === 'cancelled') {
        cancelledMidChain = true;
        appendIbcmdOutputLine(`[раскатка выбранных] ${entry.name}: отменено — ${interpreted.userMessage}`);
        results.push({
          infobaseId: entry.id,
          name: entry.name,
          status: 'skipped',
          message: interpreted.userMessage,
          skippedFiles,
        });
        for (let j = i + 1; j < entries.length; j++) {
          const e = entries[j]!;
          results.push({ infobaseId: e.id, name: e.name, status: 'skipped', message: 'Пропущено: отмена.' });
        }
        break;
      }

      if (interpreted.status === 'success') {
        recordDeploy(
          { bindingId, infobaseId: entry.id },
          { relativeFiles: supportAndImport.importedFiles },
          Date.now(),
        );
        appendIbcmdOutputLine(`[раскатка выбранных] ${entry.name}: успех — ${interpreted.userMessage}`);
        const partial = skippedFiles.length > 0;
        results.push({
          infobaseId: entry.id,
          name: entry.name,
          status: partial ? 'skipped' : 'success',
          message: partial
            ? partialDeployMessage(interpreted.userMessage, skippedFiles.length)
            : interpreted.userMessage,
          skippedFiles,
        });
      } else {
        appendIbcmdOutputLine(`[раскатка выбранных] ${entry.name}: ошибка — ${interpreted.userMessage}`);
        results.push({
          infobaseId: entry.id,
          name: entry.name,
          status: 'error',
          message: interpreted.userMessage,
          skippedFiles,
        });
      }
    }

    const s = summarizeDeployRun(results, cancelledMidChain);
    appendDeployRunSummaryLine(s);
    return s;
  }

  /**
   * Инкрементальная раскатка изменённых файлов (например, по данным git).
   * Список relative-путей уже вычислен вызывающей стороной (detectChangedConfigFiles).
   */
  async deployChangedFiles(params: DeployChangedFilesParams): Promise<DeployRunSummary> {
    if (params.relativeFiles.length === 0) {
      const s = summarizeDeployRun(
        [{ infobaseId: '', name: '', status: 'error', message: 'Список изменённых файлов пуст.' }],
        false,
      );
      appendDeployRunSummaryLine(s);
      return s;
    }

    const catalogById = new Map(params.catalog.map((e) => [e.id, e] as const));
    const resolved = resolveConfigurationXmlDirectory(params.workspaceFolderRoot, params.binding.configRelativePath);
    if (!resolved.ok) {
      const s = summarizeDeployRun([{ infobaseId: '', name: '', status: 'error', message: resolved.message }], false);
      appendDeployRunSummaryLine(s);
      return s;
    }
    const configRoot = resolved.sourceDir;
    const supportPreflight = await planDeploySupport(params.support, 'files', params.relativeFiles);
    if (isDeploySupportRejected(supportPreflight)) {
      return rejectDeployBeforeIbcmd(supportPreflight);
    }
    const deployFiles = supportPreflight?.relativeFiles ?? params.relativeFiles;
    appendSupportFilePlan(supportPreflight);

    const ibcmd = getIbcmdService();
    if ((await ibcmd.resolveExecutablePathAsync()).kind !== 'resolved') {
      const s = summarizeDeployRun(
        [{ infobaseId: '', name: '', status: 'error', message: 'Исполняемый файл ibcmd не найден. Укажите путь в настройках или переменную IBCMD_PATH.' }],
        false,
      );
      appendDeployRunSummaryLine(s);
      return s;
    }

    appendIbcmdOutputLine(`[раскатка изменённых] Файлов к загрузке: ${deployFiles.length}`);
    for (const f of deployFiles) {
      appendIbcmdOutputLine(`  ${f}`);
    }

    const { entries, skipped } = resolveDeployTargetsForBinding(params.binding, catalogById);
    const results: DeployItemResult[] = [...skipped];
    const total = entries.length;
    if (total === 0) {
      const s = summarizeDeployRun(results, false);
      appendDeployRunSummaryLine(s);
      return s;
    }

    let cancelledMidChain = false;
    const increment = total > 0 ? 100 / total : 0;

    for (let i = 0; i < entries.length; i++) {
      if (params.token.isCancellationRequested) {
        cancelledMidChain = true;
        for (let j = i; j < entries.length; j++) {
          const e = entries[j]!;
          results.push({ infobaseId: e.id, name: e.name, status: 'skipped', message: 'Пропущено: отмена пользователя.' });
        }
        break;
      }

      const entry = entries[i]!;
      params.progress.report({ message: `Раскатка изменённых: ${entry.name} (${i + 1}/${total})`, increment });

      const supportAndImport = await runInfobaseConfigurationOperation(entry, async () => {
        const supportGate = await synchronizePendingSupportForTarget(
          params.support,
          entry,
          supportPreflight?.kind === 'ready' && supportPreflight.supportFileRouted,
          supportPreflight,
        );
        if (!supportGate.accepted) {
          return supportGate;
        }
        if (deployFiles.length === 0) {
          return { kind: 'skippedBySupport' as const };
        }
        let candidateFiles = deployFiles;
        let importedFiles: readonly string[] = [];
        let reactiveSkippedFiles: readonly string[] = [];
        let interpreted = await runInfobaseConfigIncrementalImport({
          storage: params.storage,
          entry,
          configRoot,
          relativeFiles: candidateFiles,
          token: params.token,
          logContext: 'изменённые файлы',
          ibcmdExtensionName: params.binding.ibcmdExtensionName,
        });
        if (interpreted.status === 'error' && interpreted.lockedObjects?.length) {
          const filtered = filterOutLockedObjectFiles(candidateFiles, interpreted.lockedObjects);
          candidateFiles = filtered.kept;
          reactiveSkippedFiles = filtered.filtered;
          appendIbcmdOutputLine(
            `[support-mode:fallback] Внешний drift: отфильтровано ${filtered.filtered.length}, оставлено ${filtered.kept.length}.`,
          );
          if (filtered.kept.length > 0) {
            interpreted = await runInfobaseConfigIncrementalImport({
              storage: params.storage,
              entry,
              configRoot,
              relativeFiles: filtered.kept,
              token: params.token,
              logContext: 'изменённые файлы (drift fallback)',
              ibcmdExtensionName: params.binding.ibcmdExtensionName,
            });
          }
        }
        if (interpreted.status === 'success') {
          importedFiles = candidateFiles;
        }
        return {
          kind: 'import' as const,
          interpreted,
          importedFiles,
          skippedFiles: reactiveSkippedFiles,
        };
      });
      if (isSupportGateFailure(supportAndImport)) {
        results.push(targetSupportGateFailure(entry, supportAndImport));
        continue;
      }
      if ('kind' in supportAndImport && supportAndImport.kind === 'skippedBySupport') {
        results.push({
          infobaseId: entry.id,
          name: entry.name,
          status: 'skipped',
          message: supportSkipMessage(supportPreflight),
          skippedFiles: supportPreflight?.skippedLockedFiles,
        });
        continue;
      }
      const interpreted = supportAndImport.interpreted;
      const skippedFiles = stableUniqueFiles([
        ...(supportPreflight?.skippedLockedFiles ?? []),
        ...supportAndImport.skippedFiles,
      ]);

      if (interpreted.status === 'cancelled') {
        cancelledMidChain = true;
        appendIbcmdOutputLine(`[раскатка изменённых] ${entry.name}: отменено — ${interpreted.userMessage}`);
        results.push({
          infobaseId: entry.id,
          name: entry.name,
          status: 'skipped',
          message: interpreted.userMessage,
          skippedFiles,
        });
        for (let j = i + 1; j < entries.length; j++) {
          const e = entries[j]!;
          results.push({ infobaseId: e.id, name: e.name, status: 'skipped', message: 'Пропущено: отмена.' });
        }
        break;
      }

      if (interpreted.status === 'success') {
        appendIbcmdOutputLine(`[раскатка изменённых] ${entry.name}: успех — ${interpreted.userMessage}`);
        const partial = skippedFiles.length > 0;
        results.push({
          infobaseId: entry.id,
          name: entry.name,
          status: partial ? 'skipped' : 'success',
          message: partial
            ? partialDeployMessage(interpreted.userMessage, skippedFiles.length)
            : interpreted.userMessage,
          skippedFiles,
        });
      } else {
        appendIbcmdOutputLine(`[раскатка изменённых] ${entry.name}: ошибка — ${interpreted.userMessage}`);
        results.push({
          infobaseId: entry.id,
          name: entry.name,
          status: 'error',
          message: interpreted.userMessage,
          skippedFiles,
        });
      }
    }

    const s = summarizeDeployRun(results, cancelledMidChain);
    appendDeployRunSummaryLine(s);
    return s;
  }

  /**
   * Выгрузка отдельных объектов метаданных из базы в файлы конфигурации.
   * Использует `ibcmd infobase config export objects`.
   * Общую очередь конфигурации целевой ИБ захватывает вызывающая сторона.
   */
  async pullSelectedObjects(params: PullSelectedObjectsParams): Promise<DeployRunSummary> {
    const resolved = resolveConfigurationXmlDirectory(params.workspaceFolderRoot, params.binding.configRelativePath);
    if (!resolved.ok) {
      const s = summarizeDeployRun([{ infobaseId: '', name: '', status: 'error', message: resolved.message }], false);
      appendDeployRunSummaryLine(s);
      return s;
    }
    const configRoot = resolved.sourceDir;

    const ibcmd = getIbcmdService();
    if ((await ibcmd.resolveExecutablePathAsync()).kind !== 'resolved') {
      const s = summarizeDeployRun(
        [{ infobaseId: '', name: '', status: 'error', message: 'Исполняемый файл ibcmd не найден. Укажите путь в настройках или переменную IBCMD_PATH.' }],
        false,
      );
      appendDeployRunSummaryLine(s);
      return s;
    }

    const seen = new Set<string>();
    const objectIds: string[] = [];
    for (const node of params.selectedNodes) {
      const id = resolveIbcmdObjectId(node);
      if (id !== undefined) {
        const key = id.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          objectIds.push(id);
        }
      }
    }

    if (objectIds.length === 0) {
      const s = summarizeDeployRun(
        [{ infobaseId: '', name: '', status: 'error', message: 'Не найдено объектов для выгрузки.' }],
        false,
      );
      appendDeployRunSummaryLine(s);
      return s;
    }

    appendIbcmdOutputLine(`[выгрузка объектов] Объектов: ${objectIds.length}`);
    for (const id of objectIds) {
      appendIbcmdOutputLine(`  ${id}`);
    }

    params.progress.report({ message: `Выгрузка объектов из: ${params.entry.name}`, increment: 0 });

    const interpreted = await runInfobaseConfigExportObjects({
      storage: params.storage,
      entry: params.entry,
      configRoot,
      objectIds,
      token: params.token,
      logContext: 'выгрузка',
      ibcmdExtensionName: params.binding.ibcmdExtensionName,
    });

    const results: DeployItemResult[] = [];
    if (interpreted.status === 'cancelled') {
      appendIbcmdOutputLine(`[выгрузка объектов] ${params.entry.name}: отменено — ${interpreted.userMessage}`);
      results.push({ infobaseId: params.entry.id, name: params.entry.name, status: 'skipped', message: interpreted.userMessage });
      const s = summarizeDeployRun(results, true);
      appendDeployRunSummaryLine(s);
      return s;
    }

    if (interpreted.status === 'success') {
      appendIbcmdOutputLine(`[выгрузка объектов] ${params.entry.name}: успех — ${interpreted.userMessage}`);
      results.push({ infobaseId: params.entry.id, name: params.entry.name, status: 'success', message: interpreted.userMessage });
    } else {
      appendIbcmdOutputLine(`[выгрузка объектов] ${params.entry.name}: ошибка — ${interpreted.userMessage}`);
      results.push({ infobaseId: params.entry.id, name: params.entry.name, status: 'error', message: interpreted.userMessage });
    }

    const s = summarizeDeployRun(results, false);
    appendDeployRunSummaryLine(s);
    return s;
  }
}

type TargetSupportGate =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly errorCode: DeploySupportErrorCode;
      readonly message: string;
    };

async function planDeploySupport(
  support: DeploySupportContext | undefined,
  mode: DeploySupportPlannerRequest['mode'],
  relativeFiles: readonly string[],
): Promise<DeploySupportPreflight | undefined> {
  if (!support) {
    return undefined;
  }
  return new DeployLockedObjectsPlanner(support.facade).plan({
    configurationId: support.configurationId,
    mode,
    relativeFiles,
  });
}

async function gateConfigurationXmlRetry(
  support: DeploySupportContext | undefined,
  entry: InfobaseEntry,
  plannedPreflight: DeploySupportPreflight | undefined,
  retryFiles: readonly string[],
): Promise<TargetSupportGate> {
  if (!support) {
    return { accepted: true };
  }
  const freshPreflight = await planDeploySupport(support, 'files', retryFiles);
  if (!freshPreflight) {
    return supportGateFailure(
      'SUPPORT_OPERATION_FAILED',
      'Не удалось сформировать свежий support-план для повтора с Configuration.xml.',
    );
  }
  if (isDeploySupportRejected(freshPreflight)) {
    return supportGateFailure(
      freshPreflight.errorCode,
      `Повтор с Configuration.xml запрещён: support replan отклонён. ${freshPreflight.diagnostics.join(' ')}`,
    );
  }
  if (
    plannedPreflight?.kind === 'ready'
    && (
      freshPreflight.kind !== 'ready'
      || freshPreflight.generationId !== plannedPreflight.generationId
    )
  ) {
    return supportGateFailure(
      'SUPPORT_OPERATION_FAILED',
      'Повтор с Configuration.xml запрещён: generation master поддержки изменилась; сформируйте план раскатки повторно.',
    );
  }
  if (freshPreflight.kind === 'ready' && freshPreflight.lockedSupportSubjectIds.length > 0) {
    return supportGateFailure(
      'SUPPORT_OPERATION_FAILED',
      'Повтор с Configuration.xml запрещён: свежий support-план содержит заблокированные объекты.',
    );
  }
  return synchronizePendingSupportForTarget(
    support,
    entry,
    false,
    freshPreflight,
  );
}

/**
 * Called only from an outer shared target queue lease. The facade sync uses an
 * `ids` selection containing that exact canonical key; the queue's
 * AsyncLocalStorage reentrancy therefore keeps support apply and ibcmd under
 * one lease without reacquisition or all-target expansion.
 */
async function synchronizePendingSupportForTarget(
  support: DeploySupportContext | undefined,
  entry: InfobaseEntry,
  forceSync: boolean,
  expectedPreflight: DeploySupportPreflight | undefined,
): Promise<TargetSupportGate> {
  if (!support) {
    return { accepted: true };
  }
  if (!expectedPreflight || isDeploySupportRejected(expectedPreflight)) {
    return supportGateFailure(
      'SUPPORT_OPERATION_FAILED',
      'Раскатка запрещена: отсутствует согласованный immutable support-план.',
    );
  }

  let masterStatus;
  try {
    masterStatus = await support.facade.getMasterStatus({
      configurationId: support.configurationId,
    });
  } catch {
    return supportGateFailure(
      'SUPPORT_OPERATION_FAILED',
      'Не удалось получить master-состояние поддержки перед раскаткой.',
    );
  }
  if (masterStatus.status !== 'available') {
    return supportGateFailure(
      'SUPPORT_OPERATION_FAILED',
      `Master-состояние поддержки недоступно: ${masterStatus.errorCode}.`,
    );
  }
  if (!samePlannedMaster(expectedPreflight, masterStatus.master)) {
    return supportGateFailure(
      'SUPPORT_OPERATION_FAILED',
      'Состояние master поддержки изменилось после deploy preflight; сформируйте план раскатки повторно.',
    );
  }
  if (masterStatus.master.kind === 'unknown') {
    return supportGateFailure(
      masterStatus.master.errorCode,
      `Раскатка запрещена: состояние ParentConfigurations.bin неизвестно (${masterStatus.master.errorCode}).`,
    );
  }
  if (masterStatus.master.kind === 'unmanaged') {
    return { accepted: true };
  }
  const plannedGenerationId = masterStatus.master.snapshot.generationId;

  let identity;
  try {
    identity = await resolveInfobaseCanonicalIdentity(entry);
  } catch {
    return supportGateFailure(
      'SUPPORT_REPLICATION_FAILED',
      'Не удалось вычислить canonical identity целевой ИБ для support/deploy lease.',
    );
  }
  if (!forceSync && !isTargetSupportPending(expectedPreflight.status, identity.canonicalTargetId)) {
    return { accepted: true };
  }

  let syncOutcome;
  try {
    syncOutcome = await support.facade.sync({
      configurationId: support.configurationId,
      targets: { kind: 'ids', targetIds: [identity.canonicalTargetId] },
      verification: 'fast',
    });
  } catch {
    return supportGateFailure(
      'SUPPORT_REPLICATION_FAILED',
      'Синхронизация поддержки перед раскаткой завершилась с ошибкой.',
    );
  }
  if (syncOutcome.status !== 'synchronized') {
    const code = supportSyncErrorCode(syncOutcome);
    return supportGateFailure(
      code,
      `Поддержка не синхронизирована с целевой ИБ: ${code}.`,
    );
  }
  if (syncOutcome.preflight.scope !== 'replicated' || syncOutcome.run.scope !== 'replicated') {
    return supportGateFailure(
      'SUPPORT_DEPLOY_TARGET_NOT_REPLICATED',
      'Support sync неожиданно завершился в masterOnly scope; раскатка в целевую ИБ запрещена.',
    );
  }
  const target = syncOutcome.run.targets.find(
    (item) => item.canonicalTargetId === identity.canonicalTargetId,
  );
  if (
    syncOutcome.master.generationId !== plannedGenerationId
    || syncOutcome.run.desiredGenerationId !== plannedGenerationId
    || !target
    || target.desiredGenerationId !== plannedGenerationId
    || !(
      (target.state === 'applied' && target.acknowledgedGenerationId === plannedGenerationId)
      || (target.state === 'verified' && target.verifiedGenerationId === plannedGenerationId)
    )
  ) {
    return supportGateFailure(
      'SUPPORT_REPLICATION_INCOMPLETE',
      'Support sync не подтвердил planned generation на master/run/target; сформируйте план раскатки повторно.',
    );
  }
  return { accepted: true };
}

function supportSyncErrorCode(
  outcome: Exclude<
    Awaited<ReturnType<SupportApplicationFacade['sync']>>,
    { readonly status: 'synchronized' }
  >,
): DeploySupportErrorCode {
  if (outcome.status === 'incomplete' || outcome.status === 'operationRejected') {
    return outcome.errorCode;
  }
  if (outcome.status === 'preflightRejected') {
    return outcome.preflight.errorCode;
  }
  return outcome.errorCode;
}

function samePlannedMaster(
  expected: Exclude<DeploySupportPreflight, RejectedDeploySupportPreflight>,
  actual: MasterSupportState,
): boolean {
  if (expected.kind === 'unmanaged') {
    return actual.kind === 'unmanaged'
      && actual.reason === expected.reason
      && expected.status.master.kind === 'unmanaged'
      && expected.status.master.reason === expected.reason;
  }
  return actual.kind === 'ready'
    && actual.snapshot.generationId === expected.generationId
    && expected.status.master.kind === 'ready'
    && expected.status.master.snapshot.generationId === expected.generationId;
}

function isTargetSupportPending(
  status: SupportStatusResult,
  canonicalTargetId: string,
): boolean {
  if (status.master.kind !== 'ready') {
    return false;
  }
  const generationId = status.master.snapshot.generationId;
  const run = status.lastRun;
  if (
    !run
    || run.desiredGenerationId !== generationId
    || run.scope !== 'replicated'
  ) {
    return true;
  }
  const target = run.targets.find((item) => item.canonicalTargetId === canonicalTargetId);
  if (!target) {
    return true;
  }
  return !(
    target.desiredGenerationId === generationId
    && (
      (target.state === 'applied' && target.acknowledgedGenerationId === generationId)
      || (target.state === 'verified' && target.verifiedGenerationId === generationId)
    )
  );
}

function supportGateFailure(
  errorCode: DeploySupportErrorCode,
  message: string,
): TargetSupportGate {
  return { accepted: false, errorCode, message };
}

function isSupportGateFailure(
  value: unknown,
): value is Extract<TargetSupportGate, { readonly accepted: false }> {
  return typeof value === 'object'
    && value !== null
    && 'accepted' in value
    && (value as { readonly accepted?: unknown }).accepted === false;
}

function targetSupportGateFailure(
  entry: InfobaseEntry,
  gate: Extract<TargetSupportGate, { readonly accepted: false }>,
): DeployItemResult {
  appendIbcmdOutputLine(`[support-preflight] ${entry.name}: ${gate.message}`);
  return {
    infobaseId: entry.id,
    name: entry.name,
    status: 'error',
    message: gate.message,
    errorCode: gate.errorCode,
  };
}

type RejectedDeploySupportPreflight = Extract<
  DeploySupportPreflight,
  { readonly kind: 'unknown' | 'fullDeployUnsafe' }
>;

function isDeploySupportRejected(
  preflight: DeploySupportPreflight | undefined,
): preflight is RejectedDeploySupportPreflight {
  return preflight?.kind === 'unknown' || preflight?.kind === 'fullDeployUnsafe';
}

function rejectDeployBeforeIbcmd(
  preflight: RejectedDeploySupportPreflight,
): DeployRunSummary {
  const message = `Раскатка отклонена до запуска ibcmd: ${preflight.errorCode}. ${preflight.diagnostics.join(' ')}`;
  const summary = summarizeDeployRun(
    [{
      infobaseId: '',
      name: '',
      status: 'error',
      message,
      errorCode: preflight.errorCode,
    }],
    false,
  );
  appendIbcmdOutputLine(`[support-preflight] ${message}`);
  appendDeployRunSummaryLine(summary);
  return summary;
}

function appendSupportFilePlan(preflight: DeploySupportPreflight | undefined): void {
  if (!preflight || isDeploySupportRejected(preflight)) {
    return;
  }
  if (preflight.supportFileRouted) {
    appendIbcmdOutputLine(
      '[support-preflight] Ext/ParentConfigurations.bin исключён из ibcmd import files и маршрутизирован через support facade.',
    );
  }
  if (preflight.skippedLockedFiles.length > 0) {
    appendIbcmdOutputLine(
      `[support-preflight] Заблокированные master-файлы пропущены: ${preflight.skippedLockedFiles.length}.`,
    );
  }
}

function supportSkipMessage(preflight: DeploySupportPreflight | undefined): string {
  if (!preflight || isDeploySupportRejected(preflight)) {
    return 'Файлы для раскатки отсутствуют.';
  }
  const parts: string[] = [];
  if (preflight.skippedLockedFiles.length > 0) {
    parts.push(`заблокировано поддержкой: ${preflight.skippedLockedFiles.length}`);
  }
  if (preflight.supportFileRouted) {
    parts.push('ParentConfigurations.bin обработан support facade');
  }
  return `ibcmd не запускался (${parts.join('; ') || 'после preflight файлов не осталось'}).`;
}

function stableUniqueFiles(files: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const file of files) {
    const key = file.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/').toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(file);
    }
  }
  return result;
}

function partialDeployMessage(message: string, skippedFileCount: number): string {
  return `Частично применено: ${message} Пропущено файлов: ${skippedFileCount}.`;
}

function summarizeDeployRun(results: DeployItemResult[], cancelledMidChain: boolean): DeployRunSummary {
  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  let hasPartial = false;
  for (const r of results) {
    if ((r.skippedFiles?.length ?? 0) > 0) {
      hasPartial = true;
    }
    if (r.status === 'success') {
      successCount += 1;
    } else if (r.status === 'error') {
      errorCount += 1;
    } else {
      skippedCount += 1;
    }
  }
  return { results, successCount, errorCount, skippedCount, hasPartial, cancelledMidChain };
}

/** Итог раскатки в Output (дизайн UC-12 §12.5). */
function appendDeployRunSummaryLine(summary: DeployRunSummary): void {
  const tail = summary.cancelledMidChain ? ' Часть баз пропущена (отмена).' : '';
  const parts: string[] = [`${summary.successCount} успешно`];
  if (summary.errorCount > 0) {
    parts.push(`${summary.errorCount} с ошибками`);
  }
  if (summary.skippedCount > 0) {
    parts.push(`${summary.skippedCount} пропущено`);
  }
  appendIbcmdOutputLine(`[раскатка] Итого: ${parts.join(', ')}.${tail}`);
}
