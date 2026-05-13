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
  /** Shown while TypeEditor gathers referenceable object names from disk (large configs). */
  TYPE_EDITOR_LOADING_REFS: 'Загрузка списка ссылочных типов для редактора…',
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

  // Diagnostics clipboard
  DIAGNOSTICS_COPIED: 'CDT 41: сводка диагностики скопирована в буфер обмена.',
  DIAGNOSTICS_COPY_FAILED: 'CDT 41: не удалось скопировать сводку диагностики',

  // Log messages
  EXTENSION_ACTIVATED: 'CDT 41 extension activated',
  EXTENSION_DEACTIVATED: 'CDT 41 extension deactivated',
  OPENING_PANEL: 'Opening metadata tree panel',
  REFRESHING: 'Refreshing metadata tree',
  TREE_LOADED: 'Metadata tree loaded successfully',

  // Subsystem composition (B.3)
  SUBSYSTEM_COMPOSITION_SELECT_SUBSYSTEM: 'Выберите узел подсистемы в дереве метаданных.',
  SUBSYSTEM_COMPOSITION_NO_FILE: 'CDT 41: у подсистемы нет пути к файлу XML.',
  SUBSYSTEM_COMPOSITION_ADD_TITLE: 'Добавить объект в состав подсистемы',
  SUBSYSTEM_COMPOSITION_OBJECT_NOT_FOUND:
    'CDT 41: объект не найден в загруженном дереве метаданных этой конфигурации (проверьте имя и обновите дерево).',
  SUBSYSTEM_COMPOSITION_OBJECT_IN_OTHER_CONFIG:
    'CDT 41: объект найден в другой конфигурации workspace. Добавлять можно только объекты из текущей конфигурации подсистемы.',
  SUBSYSTEM_COMPOSITION_REJECTED_PREFIX: 'CDT 41: отклонённые ссылки:',
  SUBSYSTEM_COMPOSITION_WRITE_FAILED: 'CDT 41: не удалось записать состав подсистемы',
  SUBSYSTEM_COMPOSITION_READ_FAILED: 'CDT 41: не удалось прочитать состав подсистемы',
  SUBSYSTEM_COMPOSITION_EMPTY: 'CDT 41: состав подсистемы пуст.',
  SUBSYSTEM_COMPOSITION_REMOVE_PLACEHOLDER: 'Выберите объект для удаления из состава',
  SUBSYSTEM_COMPOSITION_ADD_OK: 'CDT 41: объект добавлен в состав подсистемы.',
  SUBSYSTEM_COMPOSITION_REMOVE_OK: 'CDT 41: объект удалён из состава подсистемы.',

  LOCKED_OBJECTS_ALL_FILTERED: 'Все выбранные файлы относятся к объектам на поддержке. Нечего раскатывать.',

  SUBSYSTEM_COMMAND_INTERFACE_TITLE: 'Командный интерфейс подсистемы',
  SUBSYSTEM_COMMAND_INTERFACE_SECTION_VISIBILITY: 'Видимость команд',
  SUBSYSTEM_COMMAND_INTERFACE_SECTION_PLACEMENT: 'Размещение команд',
  SUBSYSTEM_COMMAND_INTERFACE_SECTION_ORDER: 'Порядок команд',
  SUBSYSTEM_COMMAND_INTERFACE_SECTION_SUBSYSTEMS_ORDER: 'Порядок подсистем',
  SUBSYSTEM_COMMAND_INTERFACE_SECTION_GROUPS_ORDER: 'Порядок групп',
  SUBSYSTEM_COMMAND_INTERFACE_READ_FAILED: 'Не удалось прочитать CommandInterface.xml',
  SUBSYSTEM_COMMAND_INTERFACE_WRITE_FAILED: 'Не удалось записать CommandInterface.xml',
  SUBSYSTEM_COMMAND_INTERFACE_NO_FILE: 'У подсистемы нет файла CommandInterface.xml',
  SUBSYSTEM_COMMAND_INTERFACE_SAVED: 'Командный интерфейс сохранён',

  XDTO_PACKAGE_TITLE: 'Редактор XDTO-пакета',
  XDTO_PACKAGE_NO_METADATA_FILE: 'CDT 41: у XDTO-пакета нет пути к XML-файлу метаданных.',
  XDTO_PACKAGE_READ_FAILED: 'CDT 41: не удалось прочитать или создать файл XDTO-пакета',
  XDTO_PACKAGE_WRITE_FAILED: 'CDT 41: не удалось записать файл XDTO-пакета',
  XDTO_PACKAGE_VALIDATION_FAILED: 'CDT 41: файл XDTO-пакета содержит ошибку XML',
  XDTO_PACKAGE_SAVED: 'Файл XDTO-пакета сохранён',

  COT_PREDEFINED_VIEW_TITLE: 'Предопределённые виды характеристик',
  COT_PREDEFINED_EMPTY: 'Нет предопределённых видов характеристик',
  COT_PREDEFINED_READ_FAILED: 'Не удалось прочитать предопределённые виды',
  COT_PREDEFINED_COPIED: 'Ссылка на вид характеристики скопирована',
  COT_PREDEFINED_NO_TYPE: 'Тип не задан',
  COT_REGISTERS_TITLE: 'Регистры, связанные с ПВХ',

  // Reveal active file in tree (issue #88)
  REVEAL_NO_ACTIVE_EDITOR: 'Нет активного редактора',
  REVEAL_NOT_FILE_URI: 'Активный редактор не связан с файлом',
  REVEAL_NO_CONFIG_LOADED: 'Дерево метаданных не загружено',
  REVEAL_NOT_FOUND_IN_METADATA: 'Активный файл не найден в структуре метаданных',
  REVEAL_NODE_NOT_FOUND: 'Не удалось найти узел в дереве для активного файла',
  REVEAL_FILTER_ACTIVE_PROMPT: 'Файл может быть скрыт активным фильтром. Сбросить фильтры?',
  REVEAL_RESET_BUTTON: 'Сбросить',
  REVEAL_CANCEL_BUTTON: 'Отмена',
} as const;
