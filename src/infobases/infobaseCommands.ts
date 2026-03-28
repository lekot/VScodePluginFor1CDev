import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { InfobaseEntry, InfobaseEntryType } from './models/infobaseEntry';
import type { InfobaseManager } from './infobaseManager';
import { InfobaseStorageService } from './infobaseStorageService';
import {
  InfobaseValidationError,
  assertNoConflictingInfobaseTarget,
  validateInfobaseEntry,
} from './infobaseValidator';
import { INFOBASE_STORAGE_MAX_ENTRIES } from './constants';
import {
  buildLaunchArgs,
  openWebInfobaseInBrowser,
  resolveLaunchExecutable,
  spawnPlatformProcess,
} from '../services/platformLauncher';

type InfobaseTypePick = InfobaseEntryType;

const TYPE_ITEMS: { label: string; type: InfobaseTypePick; description?: string }[] = [
  { label: '$(folder) Файловая', type: 'file', description: 'Каталог файловой информационной базы' },
  { label: '$(server) Серверная', type: 'server', description: 'Кластер и имя базы на сервере 1С' },
  { label: '$(globe) Веб', type: 'web', description: 'URL веб-клиента' },
];

function nowIso(): string {
  return new Date().toISOString();
}

async function pickInfobaseType(): Promise<InfobaseTypePick | undefined> {
  const picked = await vscode.window.showQuickPick(TYPE_ITEMS, {
    title: 'Тип информационной базы',
    placeHolder: 'Выберите тип базы',
  });
  return picked?.type;
}

async function ensureStorageReady(storage: InfobaseStorageService | null): Promise<InfobaseStorageService | undefined> {
  if (!storage) {
    void vscode.window.showErrorMessage('Infobase Manager: хранилище не инициализировано.');
    return undefined;
  }
  return storage;
}

async function ensureInfobaseManagerReady(manager: InfobaseManager | null): Promise<InfobaseManager | undefined> {
  if (!manager) {
    void vscode.window.showErrorMessage('Infobase Manager: хранилище не инициализировано.');
    return undefined;
  }
  return manager;
}

async function loadAll(storage: InfobaseStorageService): Promise<InfobaseEntry[]> {
  return storage.load();
}

function defaultNameFromFsPath(fsPath: string): string {
  const base = path.basename(path.resolve(fsPath));
  return base || 'База';
}

/**
 * WOW Infobase Manager — add / edit / remove catalog entries (plan §1D #11–16, design UC-03 / UC-10).
 */
export async function runAddExistingInfobase(storage: InfobaseStorageService | null): Promise<void> {
  const s = await ensureStorageReady(storage);
  if (!s) {
    return;
  }
  const existing = await loadAll(s);
  if (existing.length >= INFOBASE_STORAGE_MAX_ENTRIES) {
    void vscode.window.showWarningMessage(
      `Достигнут лимит баз (${INFOBASE_STORAGE_MAX_ENTRIES}). Удалите запись, чтобы добавить новую.`,
    );
    return;
  }

  const kind = await pickInfobaseType();
  if (!kind) {
    return;
  }

  try {
    if (kind === 'file') {
      await addFileInfobase(s, existing);
    } else if (kind === 'server') {
      await addServerInfobase(s, existing);
    } else {
      await addWebInfobase(s, existing);
    }
  } catch (err) {
    if (err instanceof InfobaseValidationError) {
      void vscode.window.showErrorMessage(err.message);
      return;
    }
    throw err;
  }
}

async function addFileInfobase(storage: InfobaseStorageService, existing: InfobaseEntry[]): Promise<void> {
  const folders = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Выбрать каталог базы',
    title: 'Каталог файловой информационной базы',
  });
  const folder = folders?.[0];
  if (!folder) {
    return;
  }
  const fsPath = folder.fsPath;

  const name =
    (await vscode.window.showInputBox({
      title: 'Имя базы в списке',
      value: defaultNameFromFsPath(fsPath),
      validateInput: (v) => (v?.trim() ? null : 'Введите непустое имя'),
    }))?.trim() ?? '';
  if (!name) {
    return;
  }

  const id = randomUUID();
  const entry: InfobaseEntry = {
    id,
    name,
    type: 'file',
    filePath: fsPath,
    hasStoredPassword: false,
    createdAt: nowIso(),
  };
  validateInfobaseEntry(entry);
  assertNoConflictingInfobaseTarget(entry, existing);
  await storage.upsert(entry);
  void vscode.window.showInformationMessage(`База «${name}» добавлена в список.`);
}

async function addServerInfobase(storage: InfobaseStorageService, existing: InfobaseEntry[]): Promise<void> {
  const server =
    (await vscode.window.showInputBox({
      title: 'Сервер 1С',
      prompt: 'Имя кластера или адрес сервера (как в строке подключения)',
      validateInput: (v) => (v?.trim() ? null : 'Укажите сервер'),
    }))?.trim() ?? '';
  if (!server) {
    return;
  }
  const database =
    (await vscode.window.showInputBox({
      title: 'Имя информационной базы',
      validateInput: (v) => (v?.trim() ? null : 'Укажите имя базы на сервере'),
    }))?.trim() ?? '';
  if (!database) {
    return;
  }
  const user = (await vscode.window.showInputBox({ title: 'Пользователь (необязательно)' }))?.trim() ?? '';
  const password = await vscode.window.showInputBox({
    title: 'Пароль (необязательно)',
    password: true,
    ignoreFocusOut: true,
  });
  const hasPwd = typeof password === 'string' && password.length > 0;

  const name =
    (await vscode.window.showInputBox({
      title: 'Имя базы в списке',
      value: database,
      validateInput: (v) => (v?.trim() ? null : 'Введите непустое имя'),
    }))?.trim() ?? '';
  if (!name) {
    return;
  }

  const id = randomUUID();
  const entry: InfobaseEntry = {
    id,
    name,
    type: 'server',
    server,
    database,
    user: user || undefined,
    hasStoredPassword: hasPwd,
    createdAt: nowIso(),
  };
  validateInfobaseEntry(entry);
  assertNoConflictingInfobaseTarget(entry, existing);
  await storage.upsert(entry);
  if (hasPwd) {
    await storage.writePasswordSecret(id, password!);
  }
  void vscode.window.showInformationMessage(`База «${name}» добавлена в список.`);
}

async function addWebInfobase(storage: InfobaseStorageService, existing: InfobaseEntry[]): Promise<void> {
  const webUrl =
    (await vscode.window.showInputBox({
      title: 'URL веб-клиента',
      prompt: 'Например https://host/base',
      validateInput: (v) => {
        const t = v?.trim() ?? '';
        if (!t) {
          return 'Введите URL';
        }
        try {
          // eslint-disable-next-line no-new
          new URL(t);
          return null;
        } catch {
          return 'Некорректный URL';
        }
      },
    }))?.trim() ?? '';
  if (!webUrl) {
    return;
  }

  const name =
    (await vscode.window.showInputBox({
      title: 'Имя базы в списке',
      validateInput: (v) => (v?.trim() ? null : 'Введите непустое имя'),
    }))?.trim() ?? '';
  if (!name) {
    return;
  }

  const id = randomUUID();
  const entry: InfobaseEntry = {
    id,
    name,
    type: 'web',
    webUrl,
    hasStoredPassword: false,
    createdAt: nowIso(),
  };
  validateInfobaseEntry(entry);
  assertNoConflictingInfobaseTarget(entry, existing);
  await storage.upsert(entry);
  void vscode.window.showInformationMessage(`База «${name}» добавлена в список.`);
}

export async function runRemoveInfobase(
  manager: InfobaseManager | null,
  entry: InfobaseEntry | undefined,
): Promise<void> {
  const m = await ensureInfobaseManagerReady(manager);
  if (!m || !entry) {
    if (m && !entry) {
      void vscode.window.showWarningMessage('Удаление: выберите базу в дереве Infobase Manager.');
    }
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Удалить «${entry.name}» из списка? Файлы и данные базы на диске / сервере не удаляются.`,
    { modal: true },
    'Удалить',
  );
  if (confirm !== 'Удалить') {
    return;
  }
  await m.removeCatalogEntry(entry.id);
  void vscode.window.showInformationMessage(`База «${entry.name}» удалена из списка.`);
}

export async function runEditInfobase(
  storage: InfobaseStorageService | null,
  entry: InfobaseEntry | undefined,
): Promise<void> {
  const s = await ensureStorageReady(storage);
  if (!s || !entry) {
    if (s && !entry) {
      void vscode.window.showWarningMessage('Редактирование: выберите базу в дереве Infobase Manager.');
    }
    return;
  }

  const existing = await loadAll(s);

  try {
    if (entry.type === 'file') {
      await editFileInfobase(s, entry, existing);
    } else if (entry.type === 'server') {
      await editServerInfobase(s, entry, existing);
    } else {
      await editWebInfobase(s, entry, existing);
    }
  } catch (err) {
    if (err instanceof InfobaseValidationError) {
      void vscode.window.showErrorMessage(err.message);
      return;
    }
    throw err;
  }
}

async function editFileInfobase(
  storage: InfobaseStorageService,
  entry: InfobaseEntry,
  existing: InfobaseEntry[],
): Promise<void> {
  const name =
    (await vscode.window.showInputBox({
      title: 'Имя базы',
      value: entry.name,
      validateInput: (v) => (v?.trim() ? null : 'Введите непустое имя'),
    }))?.trim() ?? '';
  if (!name) {
    return;
  }

  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(folder) Оставить текущий каталог', path: null as string | null },
      { label: '$(folder-opened) Выбрать другой каталог…', path: '__pick__' as const },
    ],
    { title: 'Каталог файловой базы' },
  );
  if (!pick) {
    return;
  }

  let filePath = entry.filePath ?? '';
  if (pick.path === '__pick__') {
    const folders = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Каталог базы',
    });
    const folder = folders?.[0];
    if (!folder) {
      return;
    }
    filePath = folder.fsPath;
  }

  const yamlDefault = entry.ibcmdConfigYamlPath ?? '';
  const yamlInput = await vscode.window.showInputBox({
    title: 'Путь к YAML для ibcmd (необязательно)',
    value: yamlDefault,
    prompt: 'Оставьте пустым, если не используете отдельный конфиг',
  });
  if (yamlInput === undefined) {
    return;
  }
  const ibcmdConfigYamlPath = yamlInput.trim() || undefined;

  const next: InfobaseEntry = {
    ...entry,
    name,
    filePath: filePath || undefined,
    ibcmdConfigYamlPath,
    lastUsedAt: entry.lastUsedAt,
  };
  validateInfobaseEntry(next);
  assertNoConflictingInfobaseTarget(next, existing, entry.id);
  await storage.upsert(next);
  void vscode.window.showInformationMessage(`База «${name}» обновлена.`);
}

async function editServerInfobase(
  storage: InfobaseStorageService,
  entry: InfobaseEntry,
  existing: InfobaseEntry[],
): Promise<void> {
  const name =
    (await vscode.window.showInputBox({
      title: 'Имя базы',
      value: entry.name,
      validateInput: (v) => (v?.trim() ? null : 'Введите непустое имя'),
    }))?.trim() ?? '';
  if (!name) {
    return;
  }
  const server =
    (await vscode.window.showInputBox({
      title: 'Сервер 1С',
      value: entry.server ?? '',
      validateInput: (v) => (v?.trim() ? null : 'Укажите сервер'),
    }))?.trim() ?? '';
  if (!server) {
    return;
  }
  const database =
    (await vscode.window.showInputBox({
      title: 'Имя информационной базы',
      value: entry.database ?? '',
      validateInput: (v) => (v?.trim() ? null : 'Укажите имя базы'),
    }))?.trim() ?? '';
  if (!database) {
    return;
  }
  const user =
    (await vscode.window.showInputBox({
      title: 'Пользователь (необязательно)',
      value: entry.user ?? '',
    }))?.trim() ?? '';

  const pwdHint = entry.hasStoredPassword ? 'Пароль сохранён. Пусто — не менять, «-» — удалить.' : 'Пароль (необязательно)';
  const passwordReply = await vscode.window.showInputBox({
    title: 'Пароль',
    prompt: pwdHint,
    password: true,
    ignoreFocusOut: true,
  });
  if (passwordReply === undefined) {
    return;
  }

  let hasStoredPassword = entry.hasStoredPassword;
  if (passwordReply === '-') {
    hasStoredPassword = false;
  } else if (passwordReply.length > 0) {
    hasStoredPassword = true;
  }

  const next: InfobaseEntry = {
    ...entry,
    name,
    server,
    database,
    user: user || undefined,
    hasStoredPassword,
    lastUsedAt: entry.lastUsedAt,
  };
  validateInfobaseEntry(next);
  assertNoConflictingInfobaseTarget(next, existing, entry.id);
  await storage.upsert(next);

  if (passwordReply.length > 0 && passwordReply !== '-') {
    await storage.writePasswordSecret(entry.id, passwordReply);
  }
  void vscode.window.showInformationMessage(`База «${name}» обновлена.`);
}

async function editWebInfobase(
  storage: InfobaseStorageService,
  entry: InfobaseEntry,
  existing: InfobaseEntry[],
): Promise<void> {
  const name =
    (await vscode.window.showInputBox({
      title: 'Имя базы',
      value: entry.name,
      validateInput: (v) => (v?.trim() ? null : 'Введите непустое имя'),
    }))?.trim() ?? '';
  if (!name) {
    return;
  }
  const webUrl =
    (await vscode.window.showInputBox({
      title: 'URL веб-клиента',
      value: entry.webUrl ?? '',
      validateInput: (v) => {
        const t = v?.trim() ?? '';
        if (!t) {
          return 'Введите URL';
        }
        try {
          // eslint-disable-next-line no-new
          new URL(t);
          return null;
        } catch {
          return 'Некорректный URL';
        }
      },
    }))?.trim() ?? '';
  if (!webUrl) {
    return;
  }

  const next: InfobaseEntry = {
    ...entry,
    name,
    webUrl,
    lastUsedAt: entry.lastUsedAt,
  };
  validateInfobaseEntry(next);
  assertNoConflictingInfobaseTarget(next, existing, entry.id);
  await storage.upsert(next);
  void vscode.window.showInformationMessage(`База «${name}» обновлена.`);
}

async function touchLastUsed(storage: InfobaseStorageService, entry: InfobaseEntry): Promise<void> {
  await storage.upsert({ ...entry, lastUsedAt: new Date().toISOString() });
}

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
