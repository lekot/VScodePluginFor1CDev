/**
 * UI messages and strings
 */
export const MESSAGES = {
  // Workspace messages
  NO_WORKSPACE: 'Откройте папку с конфигурацией 1С',
  NO_CONFIGURATION: 'Конфигурация 1С не найдена в рабочей области',

  // Empty states (req.10)
  EMPTY_STATE_NO_SELECTION_TITLE: 'Ничего не выбрано.',
  EMPTY_STATE_NO_SELECTION_HINT: 'Выберите узел в дереве метаданных.',
  EMPTY_STATE_NO_PROPERTIES_TITLE: 'Нет свойств.',
  EMPTY_STATE_NO_PROPERTIES_HINT: 'Для этого узла свойства не отображаются.',
  EMPTY_STATE_FORM_XML_MISSING_TITLE: 'Файл Form.xml не найден.',
  EMPTY_STATE_FORM_XML_MISSING_HINT:
    'Создайте форму через контекстное меню узла «Формы» в дереве или откройте папку с конфигурацией формы.',
  EMPTY_TREE_MESSAGE:
    'Конфигурация не найдена. Откройте папку с конфигурацией 1С или нажмите «Обновить».',

  // Loading messages
  LOADING: 'Загрузка метаданных 1С...',
  SUCCESS: 'Метаданные 1С успешно загружены',

  // Error messages
  ERROR_LOADING: 'Ошибка загрузки метаданных',
  ERROR_PROVIDER_NOT_INITIALIZED: 'Tree data provider not initialized',

  // File sync (Stage 5)
  FILE_CHANGED_EXTERNALLY: 'Файл изменён снаружи. Обновить панель свойств?',
  FILE_CHANGED_PANEL_REFRESHED: 'Файл изменён снаружи. Панель свойств обновлена.',
  FILE_CHANGED_UPDATE: 'Обновить',
  FILE_CHANGED_LATER: 'Позже',
  SAVE_FAILED_RESTORED: 'Сохранение не удалось. Файл восстановлен из резервной копии.',
  SAVE_SUCCESS: 'Сохранено.',
  VALIDATION_ERROR_CHECK_PANEL: 'Проверьте ошибки в панели свойств.',

  // Log export (Stage 9)
  LOGS_EXPORTED: 'Логи экспортированы',
  LOGS_EXPORT_FAILED: 'Не удалось экспортировать логи',

  // Log messages
  EXTENSION_ACTIVATED: '1C Metadata Tree extension activated',
  EXTENSION_DEACTIVATED: '1C Metadata Tree extension deactivated',
  OPENING_PANEL: 'Opening metadata tree panel',
  REFRESHING: 'Refreshing metadata tree',
  TREE_LOADED: 'Metadata tree loaded successfully',
} as const;
