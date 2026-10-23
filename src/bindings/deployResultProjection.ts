import { appendIbcmdOutputLine } from '../infobases/infobaseConfigCommands';
import type { IbcmdInfobaseOperationResult } from '../services/ibcmd/ibcmdInfobaseOperationResult';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';
import type { DeployItemResult, DeployRunSummary } from './deployContracts';
import type { RejectedDeploySupportPreflight, TargetSupportGate } from './deploySupportGate';

export function toInDoubtDeployItem(
  entry: InfobaseEntry,
  operation: IbcmdInfobaseOperationResult,
  skippedFiles?: readonly string[],
): DeployItemResult {
  return {
    infobaseId: entry.id,
    name: entry.name,
    status: 'inDoubt',
    message: operation.userMessage,
    errorCode: 'DEPLOY_OPERATION_IN_DOUBT',
    effectPossible: true,
    ...(operation.termination ? { termination: operation.termination } : {}),
    ...(skippedFiles ? { skippedFiles } : {}),
  };
}

export function appendSkippedAfterUncertainOperation(
  results: DeployItemResult[],
  entries: readonly InfobaseEntry[],
  currentIndex: number,
): void {
  for (let index = currentIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index]!;
    results.push({
      infobaseId: entry.id,
      name: entry.name,
      status: 'skipped',
      message: 'Пропущено: результат операции на предыдущей базе неопределён.',
    });
  }
}

export function targetSupportGateFailure(
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

export function rejectDeployBeforeIbcmd(
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

export function stableUniqueFiles(files: readonly string[]): string[] {
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

export function partialDeployMessage(message: string, skippedFileCount: number): string {
  return `Частично применено: ${message} Пропущено файлов: ${skippedFileCount}.`;
}

export function summarizeDeployRun(results: DeployItemResult[], cancelledMidChain: boolean): DeployRunSummary {
  let successCount = 0;
  let errorCount = 0;
  let inDoubtCount = 0;
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
    } else if (r.status === 'inDoubt') {
      inDoubtCount += 1;
    } else {
      skippedCount += 1;
    }
  }
  return { results, successCount, errorCount, inDoubtCount, skippedCount, hasPartial, cancelledMidChain };
}

/** Итог раскатки в Output (дизайн UC-12 §12.5). */
export function appendDeployRunSummaryLine(summary: DeployRunSummary): void {
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
  appendIbcmdOutputLine(`[раскатка] Итого: ${parts.join(', ')}.${tail}`);
}
