import * as fs from 'fs';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { InfobaseEntry } from './models/infobaseEntry';
import { InfobaseStorageService } from './infobaseStorageService';
import {
  InfobaseValidationError,
  assertNoConflictingInfobaseTarget,
  validateInfobaseEntry,
} from './infobaseValidator';
import { INFOBASE_STORAGE_MAX_ENTRIES } from './constants';
import {
  formatV8iEntryPreview,
  parseV8iBuffer,
  v8iParsedEntryToInfobaseDraft,
  type V8iParsedEntry,
} from './v8iParser';
import { buildV8iFileContent } from './v8iBuilder';
import { ensureStorageReady, nowIso } from './infobaseCommandsShared';

interface V8iImportQuickPickItem extends vscode.QuickPickItem {
  v8i: V8iParsedEntry;
}

/**
 * WOW Infobase Manager §3D #58–59: импорт записей из `.v8i` с определением кодировки, превью и multi Quick Pick.
 */
export async function runImportV8i(
  storage: InfobaseStorageService | null,
  options?: { onCatalogChanged?: () => void },
): Promise<void> {
  const s = await ensureStorageReady(storage);
  if (!s) {
    return;
  }
  const existing = await s.load();
  const remaining = INFOBASE_STORAGE_MAX_ENTRIES - existing.length;
  if (remaining <= 0) {
    void vscode.window.showWarningMessage(
      `Достигнут лимит баз (${INFOBASE_STORAGE_MAX_ENTRIES}). Удалите записи, чтобы импортировать из .v8i.`,
    );
    return;
  }

  const pickedUris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { 'Список баз 1С (.v8i)': ['v8i'], 'Все файлы': ['*'] },
    title: 'Импорт из .v8i',
    openLabel: 'Открыть',
  });
  const fileUri = pickedUris?.[0];
  if (!fileUri) {
    return;
  }

  let buffer: Buffer;
  try {
    buffer = await fs.promises.readFile(fileUri.fsPath);
  } catch (err) {
    void vscode.window.showErrorMessage(`Не удалось прочитать файл: ${(err as Error).message}`);
    return;
  }

  const { entries, errors } = parseV8iBuffer(buffer);
  if (entries.length === 0) {
    const hint =
      errors.length > 0
        ? `Ошибки разбора (первая): ${errors[0].message} (стр. ${errors[0].line}).`
        : 'В файле нет секций с корректной строкой Connect.';
    void vscode.window.showErrorMessage(`Импорт .v8i: нечего добавить. ${hint}`);
    return;
  }

  if (errors.length > 0) {
    void vscode.window.showWarningMessage(
      `В файле пропущено записей с ошибками: ${errors.length}. Доступны для импорта: ${entries.length}.`,
    );
  }

  const items: V8iImportQuickPickItem[] = entries.map((e) => ({
    label: e.name,
    description: formatV8iEntryPreview(e),
    detail: e.connect.length > 120 ? `${e.connect.slice(0, 120)}…` : e.connect,
    picked: true,
    v8i: e,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    title: `Импорт из .v8i — выберите базы (свободно слотов: ${remaining})`,
    placeHolder: 'Снимите выделение с лишних строк (можно выбрать несколько)',
    canPickMany: true,
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (!selected?.length) {
    return;
  }

  if (selected.length > remaining) {
    void vscode.window.showErrorMessage(
      `Можно добавить не более ${remaining} баз (выбрано ${selected.length}). Уменьшите выбор или освободите каталог.`,
    );
    return;
  }

  const anyPwd = selected.some(
    (it) =>
      it.v8i.parsed.kind === 'server' &&
      it.v8i.parsed.pwdKeyPresent &&
      !!it.v8i.parsed.password?.length,
  );
  if (anyPwd) {
    const confirm = await vscode.window.showWarningMessage(
      'В выбранных строках есть пароли из .v8i (открытый текст). Они будут сохранены в SecretStorage расширения.',
      { modal: true },
      'Продолжить',
    );
    if (confirm !== 'Продолжить') {
      return;
    }
  }

  let imported = 0;
  let skipped = 0;
  const working = [...existing];

  for (const it of selected) {
    const v8i = it.v8i;
    try {
      const draft = v8iParsedEntryToInfobaseDraft(v8i);
      const id = randomUUID();
      const entry: InfobaseEntry = { ...draft, id, createdAt: nowIso() };
      validateInfobaseEntry(entry);
      assertNoConflictingInfobaseTarget(entry, working);
      await s.upsert(entry);
      if (v8i.parsed.kind === 'server' && v8i.parsed.password) {
        await s.writePasswordSecret(id, v8i.parsed.password);
      }
      working.push(entry);
      imported += 1;
    } catch (e) {
      skipped += 1;
      if (e instanceof InfobaseValidationError) {
        void vscode.window.showWarningMessage(`«${v8i.name}» не импортирована: ${e.message}`);
      } else {
        throw e;
      }
    }
  }

  if (imported > 0) {
    options?.onCatalogChanged?.();
    void vscode.window.showInformationMessage(
      skipped > 0
        ? `Импорт .v8i: добавлено ${imported}, пропущено из-за ошибок: ${skipped}.`
        : `Импорт .v8i: добавлено баз: ${imported}.`,
    );
  } else if (skipped > 0) {
    void vscode.window.showWarningMessage('Не удалось импортировать выбранные базы (см. сообщения выше).');
  }
}

/** WOW Phase 4 #61 — экспорт выбранных баз в файл `.v8i`. */
export async function runExportInfobasesV8i(
  storage: InfobaseStorageService | null,
  options?: { onCatalogChanged?: () => void },
): Promise<void> {
  void options;
  const s = await ensureStorageReady(storage);
  if (!s) {
    return;
  }
  const [entries, folders] = await Promise.all([s.load(), s.loadFolders()]);
  if (entries.length === 0) {
    void vscode.window.showInformationMessage('Нет баз для экспорта.');
    return;
  }
  type P = vscode.QuickPickItem & { entry: InfobaseEntry };
  const picked = await vscode.window.showQuickPick<P>(
    entries.map((e) => ({ label: e.name, description: e.type, picked: true, entry: e })),
    {
      title: 'Экспорт в .v8i — выберите базы',
      canPickMany: true,
      matchOnDescription: true,
    },
  );
  if (!picked || picked.length === 0) {
    return;
  }
  const uri = await vscode.window.showSaveDialog({
    title: 'Сохранить список баз как .v8i',
    filters: { 'Список баз 1С (*.v8i)': ['v8i'] },
    defaultUri: vscode.Uri.file('infobases.v8i'),
  });
  if (!uri) {
    return;
  }
  const selected = picked.map((p) => p.entry);
  const body = buildV8iFileContent(selected, folders);
  try {
    await fs.promises.writeFile(uri.fsPath, `\ufeff${body}`, 'utf8');
    void vscode.window.showInformationMessage(`Экспортировано баз: ${selected.length}.`);
  } catch (e) {
    void vscode.window.showErrorMessage(`Не удалось записать файл: ${(e as Error).message}`);
  }
}
