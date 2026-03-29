import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { InfobaseEntry, InfobaseEntryType, InfobaseFolder } from './models/infobaseEntry';
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
  launchWebInfobaseThinClient,
  openWebInfobaseInBrowser,
  resolveLaunchExecutable,
  spawnPlatformProcess,
} from '../services/platformLauncher';
import { formatServerConnectionString, parseServerConnectionString } from './models/connectionString';
import {
  formatV8iEntryPreview,
  parseV8iBuffer,
  v8iParsedEntryToInfobaseDraft,
  type V8iParsedEntry,
} from './v8iParser';
import { getIbcmdService } from '../services/ibcmd/ibcmdServiceSingleton';
import { showIbcmdNotFoundDialog } from '../services/ibcmd/showIbcmdNotFoundDialog';
import { buildV8iFileContent } from './v8iBuilder';
import { runCompareInfobaseConfigurations } from '../services/configCompareService';

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
function formatIbcmdCreateFailureMessage(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string; code?: string | number };
  const chunk = (e.stderr ?? e.stdout ?? e.message ?? String(err)).trim();
  const trimmed = chunk.length > 800 ? `${chunk.slice(0, 800)}…` : chunk;
  return trimmed ? `Не удалось создать базу: ${trimmed}` : 'Не удалось создать базу (ibcmd).';
}

/**
 * WOW Infobase Manager §3A #46–48: команда «Создать базу» — файловая ИБ через `ibcmd infobase create`, запись в каталог, уведомление.
 * Серверная / веб — отдельные подзадачи §3B / §3C.
 */
export async function runCreateInfobase(
  storage: InfobaseStorageService | null,
  options?: { onCatalogChanged?: () => void },
): Promise<void> {
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
  if (kind === 'server') {
    void vscode.window.showInformationMessage(
      'Новую серверную ИБ создают в кластере 1С (администрирование кластера, СУБД). В список расширения добавьте уже существующую базу — в том числе строкой Srvr=…;Ref=… (команда «Добавить существующую»).',
    );
    return;
  }
  if (kind === 'web') {
    void vscode.window.showInformationMessage(
      'Веб-клиент в список добавляется без ibcmd — используйте «Добавить существующую базу» (WOW §3C).',
    );
    return;
  }

  try {
    await createNewFileInfobaseWithIbcmd(s, existing, options?.onCatalogChanged);
  } catch (err) {
    if (err instanceof InfobaseValidationError) {
      void vscode.window.showErrorMessage(err.message);
      return;
    }
    throw err;
  }
}

async function createNewFileInfobaseWithIbcmd(
  storage: InfobaseStorageService,
  existing: InfobaseEntry[],
  onCatalogChanged?: () => void,
): Promise<void> {
  const folders = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Выбрать каталог',
    title: 'Каталог новой файловой информационной базы',
  });
  const folder = folders?.[0];
  if (!folder) {
    return;
  }
  const fsPath = path.resolve(folder.fsPath);

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

  const ibcmd = getIbcmdService();
  if (ibcmd.resolveExecutablePath().kind !== 'resolved') {
    await showIbcmdNotFoundDialog();
    return;
  }

  let failureMessage: string | undefined;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Создание информационной базы (ibcmd)...',
      cancellable: false,
    },
    async () => {
      try {
        await ibcmd.runInfobaseCreateFileDb(fsPath);
      } catch (e) {
        const err = e as NodeJS.ErrnoException & { code?: string | number };
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
          ibcmd.invalidatePathCache();
        }
        failureMessage = formatIbcmdCreateFailureMessage(e);
      }
    },
  );

  if (failureMessage) {
    void vscode.window.showErrorMessage(failureMessage);
    return;
  }

  await storage.upsert(entry);
  onCatalogChanged?.();
  void vscode.window.showInformationMessage(`База «${name}» создана.`);
}

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

/** WOW §3B #49 — выбор способа ввода параметров серверной ИБ (добавление и редактирование). */
/** WOW §3C #53–55 — способ открытия записи типа web (браузер или 1cv8c /WS). */
const WEB_LAUNCH_MODE_ITEMS: {
  label: string;
  description: string;
  clientType: 'web' | 'thin';
}[] = [
  {
    label: '$(globe) Браузер',
    description: 'Системный браузер по URL публикации',
    clientType: 'web',
  },
  {
    label: '$(vm) Тонкий клиент (1cv8c)',
    description: 'Платформа 1С: ENTERPRISE /WS…',
    clientType: 'thin',
  },
];

/** WOW §3C #53 — URL публикации веб-клиента: только http(s), парсинг как у {@link URL}. */
function validateWebClientUrlInput(raw: string): string | null {
  const t = raw?.trim() ?? '';
  if (!t) {
    return 'Введите URL';
  }
  let parsed: URL;
  try {
    parsed = new URL(t);
  } catch {
    return 'Некорректный URL';
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    return 'Используйте адрес с протоколом http:// или https://';
  }
  return null;
}

const SERVER_INPUT_MODE_ITEMS: {
  label: string;
  description: string;
  mode: 'connectionString' | 'fields';
}[] = [
  {
    label: '$(symbol-string) Строка Srvr=…;Ref=…',
    description: 'Как в .v8i / списке баз 1С (можно вставить целиком)',
    mode: 'connectionString',
  },
  {
    label: '$(list-flat) По полям',
    description: 'Сервер, имя базы, пользователь и пароль отдельными шагами',
    mode: 'fields',
  },
];

async function addServerInfobase(storage: InfobaseStorageService, existing: InfobaseEntry[]): Promise<void> {
  const modePick = await vscode.window.showQuickPick(SERVER_INPUT_MODE_ITEMS, {
    title: 'Серверная база: способ ввода',
    placeHolder: 'Строка подключения или по шагам',
  });
  if (!modePick) {
    return;
  }
  if (modePick.mode === 'connectionString') {
    await addServerInfobaseFromConnectionString(storage, existing);
    return;
  }
  await addServerInfobaseByFields(storage, existing);
}

async function addServerInfobaseFromConnectionString(
  storage: InfobaseStorageService,
  existing: InfobaseEntry[],
): Promise<void> {
  const raw =
    (await vscode.window.showInputBox({
      title: 'Строка подключения серверной ИБ',
      prompt: 'Например Srvr="server1c";Ref="Demo_UT"; (допускается префикс Connect=)',
      placeHolder: 'Srvr="…";Ref="…";',
      ignoreFocusOut: true,
      validateInput: (v) => {
        const t = v?.trim() ?? '';
        if (!t) {
          return 'Введите строку с Srvr и Ref';
        }
        const r = parseServerConnectionString(t);
        return r.ok ? null : r.error;
      },
    }))?.trim() ?? '';
  if (!raw) {
    return;
  }
  const parsed = parseServerConnectionString(raw);
  if (!parsed.ok) {
    return;
  }

  let user = parsed.user ?? '';
  if (!user) {
    user =
      (await vscode.window.showInputBox({
        title: 'Пользователь (необязательно)',
        prompt: 'В строке не указан Usr= — задайте вручную или оставьте пустым',
      }))?.trim() ?? '';
  }

  let extraPassword: string | undefined;
  if (!parsed.pwdKeyPresent) {
    extraPassword = await vscode.window.showInputBox({
      title: 'Пароль (необязательно)',
      prompt: 'В строке нет Pwd= — при необходимости введите пароль (сохранится в SecretStorage)',
      password: true,
      ignoreFocusOut: true,
    });
  }

  let hasStoredPassword = false;
  if (parsed.pwdKeyPresent) {
    hasStoredPassword = !!parsed.password;
  } else if (typeof extraPassword === 'string' && extraPassword.length > 0) {
    hasStoredPassword = true;
  }

  const name =
    (await vscode.window.showInputBox({
      title: 'Имя базы в списке',
      value: parsed.ref,
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
    server: parsed.server,
    database: parsed.ref,
    user: user || undefined,
    hasStoredPassword,
    createdAt: nowIso(),
  };
  validateInfobaseEntry(entry);
  assertNoConflictingInfobaseTarget(entry, existing);
  await storage.upsert(entry);
  if (parsed.pwdKeyPresent && parsed.password) {
    await storage.writePasswordSecret(id, parsed.password);
  } else if (hasStoredPassword && typeof extraPassword === 'string' && extraPassword.length > 0) {
    await storage.writePasswordSecret(id, extraPassword);
  }
  void vscode.window.showInformationMessage(`База «${name}» добавлена в список.`);
}

async function addServerInfobaseByFields(storage: InfobaseStorageService, existing: InfobaseEntry[]): Promise<void> {
  const server =
    (await vscode.window.showInputBox({
      title: 'Сервер 1С',
      prompt: 'Имя кластера или адрес сервера (как в строке подключения)',
      validateInput: (v) => (v?.trim() ? null : 'Укажите сервер'),
      ignoreFocusOut: true,
    }))?.trim() ?? '';
  if (!server) {
    return;
  }
  const database =
    (await vscode.window.showInputBox({
      title: 'Имя информационной базы',
      validateInput: (v) => (v?.trim() ? null : 'Укажите имя базы на сервере'),
      ignoreFocusOut: true,
    }))?.trim() ?? '';
  if (!database) {
    return;
  }
  const user =
    (await vscode.window.showInputBox({ title: 'Пользователь (необязательно)', ignoreFocusOut: true }))?.trim() ??
    '';
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
      prompt: 'Адрес публикации 1С (https://сервер/имя_базы или http://…)',
      placeHolder: 'https://server.example.com/demo_ut',
      ignoreFocusOut: true,
      validateInput: (v) => validateWebClientUrlInput(v ?? ''),
    }))?.trim() ?? '';
  if (!webUrl) {
    return;
  }

  const name =
    (await vscode.window.showInputBox({
      title: 'Имя базы в списке',
      ignoreFocusOut: true,
      validateInput: (v) => (v?.trim() ? null : 'Введите непустое имя'),
    }))?.trim() ?? '';
  if (!name) {
    return;
  }

  const launchPick = await vscode.window.showQuickPick(WEB_LAUNCH_MODE_ITEMS, {
    title: 'Способ запуска веб-базы',
    placeHolder: 'Браузер (по умолчанию) или тонкий клиент',
  });
  const launchSettings =
    launchPick?.clientType === 'thin' ? { clientType: 'thin' as const } : { clientType: 'web' as const };

  const id = randomUUID();
  const entry: InfobaseEntry = {
    id,
    name,
    type: 'web',
    webUrl,
    hasStoredPassword: false,
    launchSettings,
    createdAt: nowIso(),
  };
  validateInfobaseEntry(entry);
  assertNoConflictingInfobaseTarget(entry, existing);
  await storage.upsert(entry);
  void vscode.window.showInformationMessage(`База «${name}» добавлена в список.`);
}

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
  const existing = await loadAll(s);
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

/** WOW §3B #49 — правка серверной ИБ по полям (симметрично {@link addServerInfobaseByFields}). */
async function editServerInfobaseByFields(
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
      prompt: 'Имя кластера или адрес сервера (как в строке подключения)',
      value: entry.server ?? '',
      validateInput: (v) => (v?.trim() ? null : 'Укажите сервер'),
      ignoreFocusOut: true,
    }))?.trim() ?? '';
  if (!server) {
    return;
  }

  const database =
    (await vscode.window.showInputBox({
      title: 'Имя информационной базы',
      value: entry.database ?? '',
      validateInput: (v) => (v?.trim() ? null : 'Укажите имя базы на сервере'),
      ignoreFocusOut: true,
    }))?.trim() ?? '';
  if (!database) {
    return;
  }

  const user =
    (await vscode.window.showInputBox({
      title: 'Пользователь (необязательно)',
      value: entry.user ?? '',
      ignoreFocusOut: true,
    }))?.trim() ?? '';

  const pwdHint = entry.hasStoredPassword
    ? 'Пароль в SecretStorage. Пусто — не менять, «-» — удалить сохранённый пароль.'
    : 'Пароль (необязательно), сохранится в SecretStorage';
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

async function editServerInfobase(
  storage: InfobaseStorageService,
  entry: InfobaseEntry,
  existing: InfobaseEntry[],
): Promise<void> {
  const modePick = await vscode.window.showQuickPick(SERVER_INPUT_MODE_ITEMS, {
    title: 'Серверная база: способ редактирования',
    placeHolder: 'Строка подключения или по шагам',
  });
  if (!modePick) {
    return;
  }
  if (modePick.mode === 'fields') {
    await editServerInfobaseByFields(storage, entry, existing);
    return;
  }

  const name =
    (await vscode.window.showInputBox({
      title: 'Имя базы',
      value: entry.name,
      validateInput: (v) => (v?.trim() ? null : 'Введите непустое имя'),
    }))?.trim() ?? '';
  if (!name) {
    return;
  }

  const connDefault = formatServerConnectionString({
    server: entry.server ?? '',
    ref: entry.database ?? '',
    user: entry.user,
  });
  const connLine =
    (await vscode.window.showInputBox({
      title: 'Подключение (Srvr=…;Ref=…)',
      prompt:
        'Можно добавить Usr= и Pwd= в строку: при смене пароля через строку он сохранится в SecretStorage; Pwd="" — сбросить сохранённый пароль.',
      value: connDefault,
      ignoreFocusOut: true,
      validateInput: (v) => {
        const r = parseServerConnectionString(v.trim());
        return r.ok ? null : r.error;
      },
    }))?.trim() ?? '';
  if (!connLine) {
    return;
  }
  const parsed = parseServerConnectionString(connLine);
  if (!parsed.ok) {
    return;
  }

  let hasStoredPassword = entry.hasStoredPassword;
  if (parsed.pwdKeyPresent) {
    hasStoredPassword = !!parsed.password;
  }

  const pwdHint = entry.hasStoredPassword
    ? 'Пароль сохранён. Пусто — не менять, «-» — удалить.'
    : 'Пароль (необязательно)';
  let passwordReply = '';
  if (!parsed.pwdKeyPresent) {
    const reply = await vscode.window.showInputBox({
      title: 'Пароль',
      prompt: pwdHint,
      password: true,
      ignoreFocusOut: true,
    });
    if (reply === undefined) {
      return;
    }
    passwordReply = reply;
    if (passwordReply === '-') {
      hasStoredPassword = false;
    } else if (passwordReply.length > 0) {
      hasStoredPassword = true;
    }
  }

  const next: InfobaseEntry = {
    ...entry,
    name,
    server: parsed.server,
    database: parsed.ref,
    user: parsed.user,
    hasStoredPassword,
    lastUsedAt: entry.lastUsedAt,
  };
  validateInfobaseEntry(next);
  assertNoConflictingInfobaseTarget(next, existing, entry.id);
  await storage.upsert(next);

  if (parsed.pwdKeyPresent) {
    if (parsed.password) {
      await storage.writePasswordSecret(entry.id, parsed.password);
    }
  } else if (passwordReply.length > 0 && passwordReply !== '-') {
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
      ignoreFocusOut: true,
      validateInput: (v) => (v?.trim() ? null : 'Введите непустое имя'),
    }))?.trim() ?? '';
  if (!name) {
    return;
  }
  const webUrl =
    (await vscode.window.showInputBox({
      title: 'URL веб-клиента',
      prompt: 'Адрес публикации 1С (веб-клиент или /WS для тонкого)',
      value: entry.webUrl ?? '',
      ignoreFocusOut: true,
      validateInput: (v) => validateWebClientUrlInput(v ?? ''),
    }))?.trim() ?? '';
  if (!webUrl) {
    return;
  }

  const launchPick = await vscode.window.showQuickPick(WEB_LAUNCH_MODE_ITEMS, {
    title: 'Способ запуска веб-базы',
    placeHolder: 'Esc — оставить текущий способ запуска',
  });
  let nextLaunchSettings = entry.launchSettings;
  if (launchPick) {
    nextLaunchSettings = { ...entry.launchSettings, clientType: launchPick.clientType };
  }

  const next: InfobaseEntry = {
    ...entry,
    name,
    webUrl,
    lastUsedAt: entry.lastUsedAt,
    launchSettings: nextLaunchSettings,
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

function isTreeFolderArg(arg: unknown): arg is { kind: 'folder'; folder: InfobaseFolder } {
  return (
    !!arg &&
    typeof arg === 'object' &&
    (arg as { kind?: unknown }).kind === 'folder' &&
    typeof (arg as { folder?: unknown }).folder === 'object' &&
    typeof (arg as { folder: { id?: unknown } }).folder.id === 'string'
  );
}

function isTreeEntryArg(arg: unknown): arg is { kind: 'entry'; entry: InfobaseEntry } {
  return (
    !!arg &&
    typeof arg === 'object' &&
    (arg as { kind?: unknown }).kind === 'entry' &&
    typeof (arg as { entry?: unknown }).entry === 'object'
  );
}

/** WOW Phase 4 #60 — новая папка (опционально вложенная, если вызов с узла папки). */
export async function runNewInfobaseFolder(
  storage: InfobaseStorageService | null,
  arg: unknown,
  options?: { onCatalogChanged?: () => void },
): Promise<void> {
  const s = await ensureStorageReady(storage);
  if (!s) {
    return;
  }
  const parentId = isTreeFolderArg(arg) ? arg.folder.id : undefined;
  const name = await vscode.window.showInputBox({
    title: 'Новая папка в Infobase Manager',
    prompt: parentId ? 'Имя вложенной папки' : 'Имя папки',
    validateInput: (v) => (v.trim() ? undefined : 'Введите непустое имя'),
  });
  if (!name?.trim()) {
    return;
  }
  const folders = await s.loadFolders();
  const id = randomUUID();
  await s.saveFolders([...folders, { id, name: name.trim(), parentId }]);
  options?.onCatalogChanged?.();
}

/** WOW Phase 4 #60 — переименовать папку. */
export async function runRenameInfobaseFolder(
  storage: InfobaseStorageService | null,
  arg: unknown,
  options?: { onCatalogChanged?: () => void },
): Promise<void> {
  const s = await ensureStorageReady(storage);
  if (!s || !isTreeFolderArg(arg)) {
    if (s && !isTreeFolderArg(arg)) {
      void vscode.window.showWarningMessage('Переименование: выберите папку в дереве Infobase Manager.');
    }
    return;
  }
  const folder = arg.folder;
  const name =
    (await vscode.window.showInputBox({
      title: 'Имя папки',
      value: folder.name,
      validateInput: (v) => (v?.trim() ? null : 'Введите непустое имя'),
    }))?.trim() ?? '';
  if (!name || name === folder.name) {
    return;
  }
  const folders = await s.loadFolders();
  const next = folders.map((f) => (f.id === folder.id ? { ...f, name } : f));
  await s.saveFolders(next);
  options?.onCatalogChanged?.();
}

/** WOW Phase 4 #60 — удалить пустую папку. */
export async function runDeleteInfobaseFolder(
  storage: InfobaseStorageService | null,
  arg: unknown,
  options?: { onCatalogChanged?: () => void },
): Promise<void> {
  const s = await ensureStorageReady(storage);
  if (!s || !isTreeFolderArg(arg)) {
    if (s && !isTreeFolderArg(arg)) {
      void vscode.window.showWarningMessage('Удаление папки: выберите папку в дереве Infobase Manager.');
    }
    return;
  }
  const folder = arg.folder;
  const [entries, folders] = await Promise.all([s.load(), s.loadFolders()]);
  if (entries.some((e) => e.folderId === folder.id)) {
    void vscode.window.showWarningMessage('В папке есть информационные базы. Сначала переместите их.');
    return;
  }
  if (folders.some((f) => f.parentId === folder.id)) {
    void vscode.window.showWarningMessage('В папке есть вложенные папки. Сначала удалите их.');
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `Удалить папку «${folder.name}»?`,
    { modal: true },
    'Удалить',
  );
  if (ok !== 'Удалить') {
    return;
  }
  await s.saveFolders(folders.filter((f) => f.id !== folder.id));
  options?.onCatalogChanged?.();
}

/** WOW Phase 4 #60 — переместить базу в другую папку или в группу по типу. */
export async function runMoveInfobaseToFolder(
  storage: InfobaseStorageService | null,
  arg: unknown,
  options?: { onCatalogChanged?: () => void },
): Promise<void> {
  const s = await ensureStorageReady(storage);
  if (!s || !isTreeEntryArg(arg)) {
    if (s && !isTreeEntryArg(arg)) {
      void vscode.window.showWarningMessage('Перемещение: выберите базу в дереве Infobase Manager.');
    }
    return;
  }
  const entry = arg.entry;
  const folders = await s.loadFolders();
  type PickT = vscode.QuickPickItem & { folderId?: string };
  const items: PickT[] = [
    { label: '$(circle-slash) Без папки (в группу по типу)', folderId: '', alwaysShow: true },
    ...folders.map((f) => ({
      label: `$(folder) ${f.name}`,
      description: f.id,
      folderId: f.id,
    })),
  ];
  const picked = await vscode.window.showQuickPick<PickT>(items, {
    title: `Папка для «${entry.name}»`,
    placeHolder: 'Куда поместить базу',
  });
  if (!picked) {
    return;
  }
  const nextFolder = picked.folderId?.trim() ?? '';
  const all = await s.load();
  const nextEntry: InfobaseEntry = {
    ...entry,
    folderId: nextFolder.length > 0 ? nextFolder : undefined,
  };
  const nextList = all.map((e) => (e.id === entry.id ? nextEntry : e));
  await s.saveAll(nextList);
  options?.onCatalogChanged?.();
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
