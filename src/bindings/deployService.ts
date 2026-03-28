/**
 * WOW plan §2D #39–42 — последовательная раскатка выгрузки в привязанные ИБ (ibcmd config import).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConfigurationBinding } from './models/configurationBinding';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';
import type { InfobaseStorageService } from '../infobases/infobaseStorageService';
import {
  appendIbcmdOutputLine,
  runInfobaseConfigImportFromDirectory,
  serializeInfobaseConfigIbcmdOp,
} from '../infobases/infobaseConfigCommands';
import { getIbcmdService } from '../services/ibcmd/ibcmdServiceSingleton';

export type DeployItemStatus = 'success' | 'error' | 'skipped';

export interface DeployItemResult {
  readonly infobaseId: string;
  readonly name: string;
  readonly status: DeployItemStatus;
  readonly message: string;
}

export interface DeployRunSummary {
  readonly results: DeployItemResult[];
  readonly successCount: number;
  readonly errorCount: number;
  /** Предпролётные пропуски, веб-базы, отмена и т.п. */
  readonly skippedCount: number;
  /** Пользователь отменил во время цепочки — дальнейшие базы не запускались. */
  readonly cancelledMidChain: boolean;
}

export interface DeployProgressSink {
  report(value: { message?: string; increment?: number }): void;
}

/**
 * Резолв каталога выгрузки: родительский каталог Configuration.xml (как в интерактивном import).
 */
export function resolveConfigurationXmlDirectory(
  workspaceFolderRoot: string,
  configRelativePath: string,
): { ok: true; sourceDir: string; configXml: string } | { ok: false; message: string } {
  const rel = configRelativePath.replace(/\\/g, '/').trim();
  if (!rel) {
    return { ok: false, message: 'Не задан относительный путь к Configuration.xml.' };
  }
  const configXml = path.resolve(workspaceFolderRoot, rel);
  const base = path.basename(configXml);
  if (base.toLowerCase() !== 'configuration.xml') {
    return {
      ok: false,
      message: 'Ожидался путь к файлу Configuration.xml в привязке.',
    };
  }
  const dir = path.dirname(configXml);
  try {
    if (!fs.existsSync(configXml)) {
      return {
        ok: false,
        message: `Файл конфигурации не найден: ${configXml}`,
      };
    }
  } catch {
    return { ok: false, message: `Не удалось проверить путь: ${configXml}` };
  }
  return { ok: true, sourceDir: dir, configXml };
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

export class DeployService {
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

    const ibcmd = getIbcmdService();
    if (ibcmd.resolveExecutablePath().kind !== 'resolved') {
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
    let cancelledMidChain = false;

    const total = entries.length;
    if (total === 0) {
      const s = summarizeDeployRun(results, false);
      appendDeployRunSummaryLine(s);
      return s;
    }

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
      params.progress.report({
        message: `Раскатка: ${entry.name} (${i + 1}/${total})`,
        increment,
      });

      const interpreted = await serializeInfobaseConfigIbcmdOp(() =>
        runInfobaseConfigImportFromDirectory({
          storage: params.storage,
          entry,
          absoluteSourceDir: resolved.sourceDir,
          token: params.token,
          logContext: 'раскатка',
        }),
      );

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
  }
}

function summarizeDeployRun(results: DeployItemResult[], cancelledMidChain: boolean): DeployRunSummary {
  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  for (const r of results) {
    if (r.status === 'success') {
      successCount += 1;
    } else if (r.status === 'error') {
      errorCount += 1;
    } else {
      skippedCount += 1;
    }
  }
  return { results, successCount, errorCount, skippedCount, cancelledMidChain };
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
