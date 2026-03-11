/**
 * UI messages and strings
 */
export const MESSAGES = {
  // Workspace messages
  NO_WORKSPACE: 'Откройте папку с конфигурацией 1С',
  NO_CONFIGURATION: 'Конфигурация 1С не найдена в рабочей области',

  // Loading messages
  LOADING: 'Загрузка метаданных 1С...',
  SUCCESS: 'Метаданные 1С успешно загружены',

  // Error messages
  ERROR_LOADING: 'Ошибка загрузки метаданных',
  ERROR_PROVIDER_NOT_INITIALIZED: 'Tree data provider not initialized',

  // Log messages
  EXTENSION_ACTIVATED: '1C Metadata Tree extension activated',
  EXTENSION_DEACTIVATED: '1C Metadata Tree extension deactivated',
  OPENING_PANEL: 'Opening metadata tree panel',
  REFRESHING: 'Refreshing metadata tree',
  TREE_LOADED: 'Metadata tree loaded successfully',
} as const;
