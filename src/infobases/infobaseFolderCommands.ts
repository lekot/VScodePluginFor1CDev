import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { InfobaseStorageService } from './infobaseStorageService';
import { ensureStorageReady, isTreeFolderArg, isTreeEntryArg } from './infobaseCommandsShared';

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
  const nextEntry = {
    ...entry,
    folderId: nextFolder.length > 0 ? nextFolder : undefined,
  };
  const nextList = all.map((e) => (e.id === entry.id ? nextEntry : e));
  await s.saveAll(nextList);
  options?.onCatalogChanged?.();
}
