import * as path from 'path';
import * as vscode from 'vscode';
import type { InfobaseEntry, InfobaseEntryType, InfobaseFolder } from './models/infobaseEntry';
import type { InfobaseManager } from './infobaseManager';
import { InfobaseStorageService } from './infobaseStorageService';

export type InfobaseTypePick = InfobaseEntryType;

export const TYPE_ITEMS: { label: string; type: InfobaseTypePick; description?: string }[] = [
  { label: '$(folder) Файловая', type: 'file', description: 'Каталог файловой информационной базы' },
  { label: '$(server) Серверная', type: 'server', description: 'Кластер и имя базы на сервере 1С' },
  { label: '$(globe) Веб', type: 'web', description: 'URL веб-клиента' },
];

/** WOW §3C #53–55 — способ открытия записи типа web (браузер или 1cv8c /WS). */
export const WEB_LAUNCH_MODE_ITEMS: {
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

/** WOW §3B #49 — выбор способа ввода параметров серверной ИБ (добавление и редактирование). */
export const SERVER_INPUT_MODE_ITEMS: {
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

export function nowIso(): string {
  return new Date().toISOString();
}

export async function pickInfobaseType(): Promise<InfobaseTypePick | undefined> {
  const picked = await vscode.window.showQuickPick(TYPE_ITEMS, {
    title: 'Тип информационной базы',
    placeHolder: 'Выберите тип базы',
  });
  return picked?.type;
}

export async function ensureStorageReady(storage: InfobaseStorageService | null): Promise<InfobaseStorageService | undefined> {
  if (!storage) {
    void vscode.window.showErrorMessage('Infobase Manager: хранилище не инициализировано.');
    return undefined;
  }
  return storage;
}

export async function ensureInfobaseManagerReady(manager: InfobaseManager | null): Promise<InfobaseManager | undefined> {
  if (!manager) {
    void vscode.window.showErrorMessage('Infobase Manager: хранилище не инициализировано.');
    return undefined;
  }
  return manager;
}

export async function loadAll(storage: InfobaseStorageService): Promise<InfobaseEntry[]> {
  return storage.load();
}

export function defaultNameFromFsPath(fsPath: string): string {
  const base = path.basename(path.resolve(fsPath));
  return base || 'База';
}

/** WOW §3C #53 — URL публикации веб-клиента: только http(s), парсинг как у {@link URL}. */
export function validateWebClientUrlInput(raw: string): string | null {
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

export function isTreeFolderArg(arg: unknown): arg is { kind: 'folder'; folder: InfobaseFolder } {
  return (
    !!arg &&
    typeof arg === 'object' &&
    (arg as { kind?: unknown }).kind === 'folder' &&
    typeof (arg as { folder?: unknown }).folder === 'object' &&
    typeof (arg as { folder: { id?: unknown } }).folder.id === 'string'
  );
}

export function isTreeEntryArg(arg: unknown): arg is { kind: 'entry'; entry: InfobaseEntry } {
  return (
    !!arg &&
    typeof arg === 'object' &&
    (arg as { kind?: unknown }).kind === 'entry' &&
    typeof (arg as { entry?: unknown }).entry === 'object'
  );
}

export async function touchLastUsed(storage: InfobaseStorageService, entry: InfobaseEntry): Promise<void> {
  await storage.upsert({ ...entry, lastUsedAt: new Date().toISOString() });
}
