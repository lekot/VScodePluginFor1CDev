import * as vscode from 'vscode';
import type { InfobaseEntry } from './models/infobaseEntry';
import { InfobaseStorageService } from './infobaseStorageService';
import {
  buildLaunchArgs,
  launchWebInfobaseThinClient,
  openWebInfobaseInBrowser,
  resolveLaunchExecutable,
  spawnPlatformProcess,
} from '../services/platformLauncher';
import { runCompareInfobaseConfigurations } from '../services/configCompareService';
import { ensureStorageReady, touchLastUsed } from './infobaseCommandsShared';

/** WOW Infobase Manager §1F #25 — открыть базу в режиме 1С:Предприятие. */
export async function runOpenEnterprise(
  storage: InfobaseStorageService | null,
  entry: InfobaseEntry | undefined,
): Promise<void> {
  const s = await ensureStorageReady(storage);
  if (!s || !entry) {
    if (s && !entry) {
      void vscode.window.showWarningMessage('Запуск: выберите базу в дереве Infobase Manager.');
    }
    return;
  }

  if (entry.type === 'web') {
    const url = entry.webUrl?.trim() ?? '';
    if (!url) {
      void vscode.window.showErrorMessage('У веб-базы не задан URL.');
      return;
    }
    if (entry.launchSettings?.clientType === 'thick') {
      void vscode.window.showWarningMessage(
        'Для веб-базы толстый клиент не используется. Команда «Редактировать…» — выберите браузер или тонкий клиент (WOW §3C).',
      );
      return;
    }
    if (entry.launchSettings?.clientType === 'thin') {
      const ok = await launchWebInfobaseThinClient(entry);
      if (ok) {
        await touchLastUsed(s, entry);
      }
      return;
    }
    const ok = await openWebInfobaseInBrowser(url);
    if (ok) {
      await touchLastUsed(s, entry);
    } else {
      void vscode.window.showErrorMessage('Не удалось открыть URL в браузере.');
    }
    return;
  }

  const exe = await resolveLaunchExecutable(entry, 'enterprise');
  if (!exe) {
    return;
  }

  let password: string | undefined;
  if (entry.type === 'server' && entry.user?.trim() && entry.hasStoredPassword) {
    password = await s.readPasswordSecret(entry.id);
  }
  const creds =
    entry.type === 'server' && entry.user?.trim()
      ? { user: entry.user.trim(), password }
      : undefined;

  try {
    const args = buildLaunchArgs(entry, 'enterprise', process.platform, creds);
    spawnPlatformProcess(exe, args);
    await touchLastUsed(s, entry);
  } catch (err) {
    void vscode.window.showErrorMessage(`Запуск 1С:Предприятие: ${(err as Error).message}`);
  }
}

/** WOW Infobase Manager §1F #26 — открыть Конфигуратор (file/server). */
export async function runOpenDesigner(
  storage: InfobaseStorageService | null,
  entry: InfobaseEntry | undefined,
): Promise<void> {
  const s = await ensureStorageReady(storage);
  if (!s || !entry) {
    if (s && !entry) {
      void vscode.window.showWarningMessage('Конфигуратор: выберите базу в дереве Infobase Manager.');
    }
    return;
  }

  if (entry.type === 'web') {
    void vscode.window.showWarningMessage('Конфигуратор недоступен для веб-базы.');
    return;
  }

  const exe = await resolveLaunchExecutable(entry, 'designer');
  if (!exe) {
    return;
  }

  let password: string | undefined;
  if (entry.type === 'server' && entry.user?.trim() && entry.hasStoredPassword) {
    password = await s.readPasswordSecret(entry.id);
  }
  const creds =
    entry.type === 'server' && entry.user?.trim()
      ? { user: entry.user.trim(), password }
      : undefined;

  try {
    const args = buildLaunchArgs(entry, 'designer', process.platform, creds);
    spawnPlatformProcess(exe, args);
    await touchLastUsed(s, entry);
  } catch (err) {
    void vscode.window.showErrorMessage(`Запуск Конфигуратора: ${(err as Error).message}`);
  }
}

/** WOW Phase 4 #62 — сравнить выгрузку конфигурации с другой базой. */
export async function runCompareInfobaseWithOther(
  storage: InfobaseStorageService | null,
  entry: InfobaseEntry | undefined,
): Promise<void> {
  const s = await ensureStorageReady(storage);
  if (!s || !entry) {
    if (s && !entry) {
      void vscode.window.showWarningMessage('Сравнение: выберите первую базу в дереве Infobase Manager.');
    }
    return;
  }
  if (entry.type === 'web') {
    void vscode.window.showWarningMessage('Сравнение конфигураций недоступно для веб-базы.');
    return;
  }
  const all = await s.load();
  const others = all.filter((e) => e.id !== entry.id && e.type !== 'web');
  if (others.length === 0) {
    void vscode.window.showInformationMessage('Нет второй файловой или серверной базы для сравнения.');
    return;
  }
  type Q = vscode.QuickPickItem & { target: InfobaseEntry };
  const picked = await vscode.window.showQuickPick<Q>(
    others.map((e) => ({ label: e.name, description: e.type, target: e })),
    { title: `Сравнить с базой «${entry.name}»`, placeHolder: 'Вторая база' },
  );
  if (!picked) {
    return;
  }
  await runCompareInfobaseConfigurations({ storage: s, entryA: entry, entryB: picked.target });
}
