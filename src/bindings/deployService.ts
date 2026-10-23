/**
 * WOW plan §2D #39–42 — последовательная раскатка выгрузки в привязанные ИБ (ibcmd config import).
 * WOW plan §2E #44–45 — режимы раскатки: copy (снимок во временный каталог), block (readonly дерева конфигурации).
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { configurationPathKey } from '../utils/configurationPathIdentity';
import type { ConfigurationBinding } from './models/configurationBinding';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';
import type { InfobaseStorageService } from '../infobases/infobaseStorageService';
import { appendIbcmdOutputLine, runInfobaseConfigImportFromDirectory, runInfobaseConfigIncrementalImport, runInfobaseConfigExportObjects } from '../infobases/infobaseConfigCommands';
import { InfobaseConfigurationOperationCancelledError, runInfobaseConfigurationOperation } from '../infobases/infobaseConfigurationOperationQueue';
import { runConfigurationMutation as defaultRunConfigurationMutation, isConfigurationMutationGatewayConfigured } from '../services/configurationSession/configurationMutationGateway';
import { getIbcmdService } from '../services/ibcmd/ibcmdServiceSingleton';
import { collectFilesForSelection, resolveIbcmdObjectId } from '../services/ibcmd/objectFileCollector';
import { detectDeployGuards } from './deployPreflightGuards';
import { validateDeployRelativeFiles } from '../services/ibcmd/deployPathValidator';
import { expandBslSiblings } from './bslExpansion';
import { checkRecentDeploy, computeFilesContentSignature, recordDeploy } from './deployDedupCache';
import { runIbcmdXmlImportPreflight } from '../services/ibcmdXmlPreflightService';
import { filterOutLockedObjectFiles } from './deployLockedObjectsFilter';
import { MESSAGES } from '../constants/messages';
import {
  readDeployMode,
  readDeployPrecheckXmlBeforeImportSetting,
  configurationTreeReadonlyGlob,
  applyReadonlyIncludeForDeploy,
} from './deployReadonlyLease';
import {
  createConfigurationSnapshot,
  cleanupConfigurationSnapshot,
  DeploySnapshotCancelledError,
} from './deploySnapshot';
import { resolveConfigurationXmlDirectory, resolveDeployTargetsForBinding } from './deployResolution';
import {
  appendSupportFilePlan,
  gateConfigurationXmlRetry,
  isDeploySupportRejected,
  isSupportGateFailure,
  planDeploySupport,
  supportSkipMessage,
  synchronizePendingSupportForTarget,
} from './deploySupportGate';
import {
  appendDeployRunSummaryLine,
  appendSkippedAfterUncertainOperation,
  partialDeployMessage,
  rejectDeployBeforeIbcmd,
  stableUniqueFiles,
  summarizeDeployRun,
  targetSupportGateFailure,
  toInDoubtDeployItem,
} from './deployResultProjection';
import type {
  DeployChangedFilesParams,
  DeployItemResult,
  DeployProgressSink,
  DeployRunSummary,
  DeploySelectedObjectsParams,
  DeployServiceDeps,
  DeploySupportContext,
  PullSelectedObjectsParams,
} from './deployContracts';

export type {
  DeployChangedFilesParams,
  DeployItemErrorCode,
  DeployItemResult,
  DeployItemStatus,
  DeployMode,
  DeployProgressSink,
  DeployRunSummary,
  DeploySelectedObjectsParams,
  DeployServiceDeps,
  DeploySupportContext,
  DeploySupportErrorCode,
  PullSelectedObjectsParams,
} from './deployContracts';
export {
  applyReadonlyIncludeForDeploy,
  configurationTreeReadonlyGlob,
  readDeployMode,
  readDeployPrecheckXmlBeforeImportSetting,
  resetReadonlyIncludeDeployLocksForTests,
  vscodeSupportsDeployReadonlyLock,
} from './deployReadonlyLease';
export { DeploySnapshotCancelledError, createConfigurationSnapshot } from './deploySnapshot';
export type { DeploySnapshotOptions } from './deploySnapshot';
export {
  listDeployTargetLabels,
  resolveConfigurationXmlDirectory,
  resolveDeployTargetsForBinding,
} from './deployResolution';

export class DeployService {
  constructor(private readonly deps: DeployServiceDeps = {}) {}

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
    onOutput?: (chunk: string) => void;
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
            token: params.token,
          });
          if (!preflight.ok) {
            if (preflight.code === 'CANCELLED') {
              return {
                status: 'cancelled' as const,
                exitCode: null,
                userMessage: preflight.message,
                logExcerpt: '',
              };
            }
            const inDoubt = preflight.code === 'IN_DOUBT';
            appendIbcmdOutputLine(
              `[раскатка] ${entry.name}: ${inDoubt ? 'результат preflight XML неопределён' : 'preflight XML не пройден'} (${preflight.durationMs} мс) — ${preflight.message}`,
            );
            results.push({
              infobaseId: entry.id,
              name: entry.name,
              status: inDoubt ? 'inDoubt' : 'error',
              message: inDoubt
                ? `Результат preflight XML неопределён: ${preflight.message}`
                : `Preflight XML не пройден: ${preflight.message}`,
              ...(inDoubt
                ? {
                    errorCode: 'DEPLOY_OPERATION_IN_DOUBT' as const,
                    effectPossible: true,
                    ...(preflight.termination ? { termination: preflight.termination } : {}),
                  }
                : {}),
            });
            for (let j = i + 1; j < entries.length; j++) {
              const e = entries[j]!;
              results.push({
                infobaseId: e.id,
                name: e.name,
                status: 'skipped',
                message: inDoubt
                  ? 'Пропущено: результат preflight XML неопределён на предыдущей базе.'
                  : 'Пропущено: preflight XML завершился ошибкой на предыдущей базе.',
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
            onOutput: params.onOutput,
          });
        }, params.token).catch((error: unknown) => {
          if (!(error instanceof InfobaseConfigurationOperationCancelledError)) {
            throw error;
          }
          return {
            status: 'cancelled' as const,
            exitCode: null,
            userMessage: 'Пропущено: отмена до начала операции.',
            logExcerpt: '',
          };
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

        if (interpreted.status === 'inDoubt') {
          appendIbcmdOutputLine(`[раскатка] ${entry.name}: результат неопределён — ${interpreted.userMessage}`);
          results.push(toInDoubtDeployItem(entry, interpreted));
          appendSkippedAfterUncertainOperation(results, entries, i);
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
        await cleanupConfigurationSnapshot(snapshotDir);
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

    const validation = await validateDeployRelativeFiles(configRoot, deployFiles);
    if (!validation.ok) {
      const s = summarizeDeployRun(
        [{ infobaseId: '', name: '', status: 'error', message: validation.error ?? 'Файл выходит за границы конфигурации.' }],
        false,
      );
      appendDeployRunSummaryLine(s);
      return s;
    }

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

    const bindingId = configurationPathKey(path.resolve(params.workspaceFolderRoot, params.binding.configRelativePath));

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
        const contentSignature = await computeFilesContentSignature(configRoot, deployFiles);
        const dedupResult = checkRecentDeploy(
          { bindingId, infobaseId: entry.id },
          { relativeFiles: deployFiles, contentSignature },
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
          onOutput: params.onOutput,
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
              onOutput: params.onOutput,
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
              onOutput: params.onOutput,
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

      if (interpreted.status === 'inDoubt') {
        appendIbcmdOutputLine(`[раскатка выбранных] ${entry.name}: результат неопределён — ${interpreted.userMessage}`);
        results.push(toInDoubtDeployItem(entry, interpreted, skippedFiles));
        appendSkippedAfterUncertainOperation(results, entries, i);
        break;
      }

      if (interpreted.status === 'success') {
        const contentSignature = await computeFilesContentSignature(configRoot, supportAndImport.importedFiles);
        recordDeploy(
          { bindingId, infobaseId: entry.id },
          { relativeFiles: supportAndImport.importedFiles, contentSignature },
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

    const validation = await validateDeployRelativeFiles(configRoot, deployFiles);
    if (!validation.ok) {
      const s = summarizeDeployRun(
        [{ infobaseId: '', name: '', status: 'error', message: validation.error ?? 'Файл выходит за границы конфигурации.' }],
        false,
      );
      appendDeployRunSummaryLine(s);
      return s;
    }

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
              onOutput: params.onOutput,
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
              onOutput: params.onOutput,
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

      if (interpreted.status === 'inDoubt') {
        appendIbcmdOutputLine(`[раскатка изменённых] ${entry.name}: результат неопределён — ${interpreted.userMessage}`);
        results.push(toInDoubtDeployItem(entry, interpreted, skippedFiles));
        appendSkippedAfterUncertainOperation(results, entries, i);
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

    const exportObjectsFn = this.deps.runConfigurationExportObjects ?? runInfobaseConfigExportObjects;
    const runMutation = params.runConfigurationMutation ?? this.deps.runConfigurationMutation ?? (
      isConfigurationMutationGatewayConfigured() ? defaultRunConfigurationMutation : async <T>(_p: string, _k: string, op: () => Promise<T>) => op()
    );

    const interpreted = await runMutation(configRoot, 'infobase.pullSelectedObjects', async () =>
      exportObjectsFn({
        storage: params.storage,
        entry: params.entry,
        configRoot,
        objectIds,
        token: params.token,
        logContext: 'выгрузка',
        ibcmdExtensionName: params.binding.ibcmdExtensionName,
        onOutput: params.onOutput,
      }),
    );

    const results: DeployItemResult[] = [];
    if (interpreted.status === 'cancelled') {
      appendIbcmdOutputLine(`[выгрузка объектов] ${params.entry.name}: отменено — ${interpreted.userMessage}`);
      results.push({ infobaseId: params.entry.id, name: params.entry.name, status: 'skipped', message: interpreted.userMessage });
      const s = summarizeDeployRun(results, true);
      appendDeployRunSummaryLine(s);
      return s;
    }

    if (interpreted.status === 'inDoubt') {
      appendIbcmdOutputLine(`[выгрузка объектов] ${params.entry.name}: результат неопределён — ${interpreted.userMessage}`);
      results.push(toInDoubtDeployItem(params.entry, interpreted));
      const s = summarizeDeployRun(results, false);
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
