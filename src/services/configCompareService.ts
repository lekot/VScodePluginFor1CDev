/**
 * WOW Phase 4 #62 — сравнение выгрузок конфигурации двух информационных баз (временный export + diff).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';
import type { InfobaseStorageService } from '../infobases/infobaseStorageService';
import { prepareIbcmdConfigYaml } from '../infobases/ibcmdConfigPathResolver';
import {
  appendIbcmdOutputLine,
  serializeInfobaseConfigIbcmdOp,
  showIbcmdInfobaseOutputChannel,
} from '../infobases/infobaseConfigCommands';
import { buildInfobaseConfigExportArgs, ibcmdOfflineConnectionFromPrepared } from './ibcmd/ibcmdInfobaseConfigArgs';
import { getIbcmdService } from './ibcmd/ibcmdServiceSingleton';
import { runIbcmdStreaming } from './ibcmd/IbcmdStreamingRunner';
import { interpretIbcmdInfobaseOutcome } from './ibcmd/ibcmdInfobaseOperationResult';
import { getIbcmdConsoleOutputEncodingSetting } from './metadataTreeSettings';
import { showIbcmdNotFoundDialog } from './ibcmd/showIbcmdNotFoundDialog';
import { getIbcmdYamlInfobaseConfigUnsupportedMessage } from './ibcmd/ibcmdVersionSupport';

function vscodeCancellation(token: vscode.CancellationToken): {
  isCancellationRequested: boolean;
  onCancellationRequested: (listener: () => void) => vscode.Disposable;
} {
  return {
    isCancellationRequested: token.isCancellationRequested,
    onCancellationRequested: (listener) => token.onCancellationRequested(listener),
  };
}

async function exportInfobaseConfigToDir(params: {
  storage: InfobaseStorageService;
  entry: InfobaseEntry;
  outDir: string;
  token: vscode.CancellationToken;
}): Promise<{ ok: boolean; message: string }> {
  const ibcmd = getIbcmdService();
  const pathResult = ibcmd.resolveExecutablePath();
  if (pathResult.kind !== 'resolved') {
    return {
      ok: false,
      message:
        'Исполняемый файл ibcmd не найден. Укажите путь в настройках или переменную IBCMD_PATH.',
    };
  }

  const yamlUnsupported = await getIbcmdYamlInfobaseConfigUnsupportedMessage(pathResult.path);
  if (yamlUnsupported) {
    return { ok: false, message: yamlUnsupported };
  }

  const prep = await prepareIbcmdConfigYaml(params.entry, (id) => params.storage.readPasswordSecret(id));
  if (!prep.ok) {
    return { ok: false, message: prep.userMessage };
  }

  try {
    const args = buildInfobaseConfigExportArgs(
      ibcmdOfflineConnectionFromPrepared(prep),
      path.resolve(params.outDir),
    );
    const outcome = await runIbcmdStreaming({
      executablePath: pathResult.path,
      args,
      timeoutMs: ibcmd.getTimeoutMs(),
      cancellation: vscodeCancellation(params.token),
      consoleOutputEncoding: getIbcmdConsoleOutputEncodingSetting(),
      onStreamChunk: () => {
        /* вывод уже в общем канале при необходимости */
      },
    });
    if (outcome.spawnErrorCode === 'ENOENT' || outcome.spawnErrorCode === 'ENOTDIR') {
      ibcmd.invalidatePathCache();
    }
    const interpreted = interpretIbcmdInfobaseOutcome('export', outcome);
    return {
      ok: interpreted.status === 'success',
      message: interpreted.userMessage,
    };
  } finally {
    await prep.dispose();
  }
}

/**
 * Выгружает конфигурацию из двух баз во временные каталоги и открывает сравнение `Configuration.xml`.
 */
export async function runCompareInfobaseConfigurations(params: {
  storage: InfobaseStorageService | null;
  entryA: InfobaseEntry;
  entryB: InfobaseEntry;
}): Promise<void> {
  const { storage, entryA, entryB } = params;
  if (!storage) {
    void vscode.window.showErrorMessage('Infobase Manager: хранилище не инициализировано.');
    return;
  }
  if (entryA.type === 'web' || entryB.type === 'web') {
    void vscode.window.showWarningMessage('Сравнение конфигураций через ibcmd недоступно для веб-баз.');
    return;
  }
  if (entryA.id === entryB.id) {
    void vscode.window.showWarningMessage('Выберите две разные информационные базы.');
    return;
  }

  await serializeInfobaseConfigIbcmdOp(async () => {
    const ibcmd = getIbcmdService();
    if (ibcmd.resolveExecutablePath().kind !== 'resolved') {
      await showIbcmdNotFoundDialog();
      return;
    }

    const base = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-ib-compare-'));
    const dirA = path.join(base, 'a');
    const dirB = path.join(base, 'b');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });

    const scheduleCleanup = (): void => {
      setTimeout(() => {
        try {
          fs.rmSync(base, { recursive: true, force: true });
        } catch {
          /* diff или ОС могут удерживать файлы */
        }
      }, 180_000);
    };

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Сравнение конфигураций: ${entryA.name} ↔ ${entryB.name}`,
        cancellable: true,
      },
      async (_p, token) => {
        appendIbcmdOutputLine(`[compare] временные каталоги: A=${dirA} B=${dirB}`);
        const r1 = await exportInfobaseConfigToDir({ storage, entry: entryA, outDir: dirA, token });
        if (!r1.ok) {
          void vscode.window.showErrorMessage(`Выгрузка «${entryA.name}»: ${r1.message}`);
          showIbcmdInfobaseOutputChannel();
          scheduleCleanup();
          return;
        }
        const r2 = await exportInfobaseConfigToDir({ storage, entry: entryB, outDir: dirB, token });
        if (!r2.ok) {
          void vscode.window.showErrorMessage(`Выгрузка «${entryB.name}»: ${r2.message}`);
          showIbcmdInfobaseOutputChannel();
          scheduleCleanup();
          return;
        }

        const xmlA = path.join(dirA, 'Configuration.xml');
        const xmlB = path.join(dirB, 'Configuration.xml');
        if (!fs.existsSync(xmlA) || !fs.existsSync(xmlB)) {
          void vscode.window.showWarningMessage(
            'После выгрузки не найден Configuration.xml в одном из каталогов. Пути записаны в канал «Infobase (ibcmd)».',
          );
          appendIbcmdOutputLine(`[compare] Configuration.xml A exists=${fs.existsSync(xmlA)} B exists=${fs.existsSync(xmlB)}`);
          showIbcmdInfobaseOutputChannel();
          scheduleCleanup();
          return;
        }

        const left = vscode.Uri.file(xmlA);
        const right = vscode.Uri.file(xmlB);
        const title = `${entryA.name} ↔ ${entryB.name} (Configuration.xml)`;
        await vscode.commands.executeCommand('vscode.diff', left, right, title);
        void vscode.window.showInformationMessage(
          'Открыто сравнение Configuration.xml. Временные каталоги будут удалены через несколько минут.',
        );
        appendIbcmdOutputLine(`[compare] открыт diff: ${xmlA} vs ${xmlB}`);
        scheduleCleanup();
      },
    );
  });
}
