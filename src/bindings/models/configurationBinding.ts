/**
 * WOW Phase 2 — привязка информационных баз к выгрузке конфигурации (design §12.8).
 * Персистится в `.vscode/infobase-bindings.json` per workspace folder.
 */

/** Корень JSON-файла привязок в `.vscode/infobase-bindings.json`. */
export interface InfobaseBindingsFileRoot {
  schemaVersion: 1;
  bindings: ConfigurationBinding[];
}

export interface ConfigurationBinding {
  /** Имя папки workspace (`WorkspaceFolder.name`), для multi-root. */
  workspaceFolder: string;

  /** Относительный путь к Configuration.xml от корня этой папки. */
  configRelativePath: string;

  /** ID баз из каталога Infobase Manager; порядок = порядок раскатки. */
  infobaseIds: string[];

  /** Массовая раскатка во все привязанные базы. */
  massDeployment: boolean;
}
