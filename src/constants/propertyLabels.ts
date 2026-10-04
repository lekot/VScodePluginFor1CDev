/**
 * Russian labels for metadata properties
 */
export const propertyLabels: Record<string, string> = {
  // CommonModule properties
  'Global': 'Глобальный',
  'ClientManagedApplication': 'Клиент (управляемое приложение)',
  'Server': 'Сервер',
  'ExternalConnection': 'Внешнее соединение',
  'ClientOrdinaryApplication': 'Клиент (обычное приложение)',
  'ServerCall': 'Вызов сервера',
  'Privileged': 'Привилегированный',
  'ReturnValuesReuse': 'Повторное использование возвращаемых значений',
  
  // Common properties
  'Name': 'Имя',
  'Synonym': 'Синоним',
  'Comment': 'Комментарий',
  'type': 'Тип',

  // Configuration properties
  'NamePrefix': 'Префикс имени',
  'ConfigurationExtensionCompatibilityMode': 'Режим совместимости расширения конфигурации',
  'DefaultRunMode': 'Режим запуска по умолчанию',
  'ScriptVariant': 'Вариант языка',
  'Vendor': 'Поставщик',
  'Version': 'Версия',
  
  // Attribute properties
  'PasswordMode': 'Режим пароля',
  'Format': 'Формат',
  'EditFormat': 'Формат редактирования',
  'ToolTip': 'Подсказка',
  'MarkNegatives': 'Отмечать отрицательные',
  'Mask': 'Маска',
  'MultiLine': 'Многострочный режим',
  'ExtendedEdit': 'Расширенное редактирование',
  'MinValue': 'Минимальное значение',
  'MaxValue': 'Максимальное значение',
  'FillFromFillingValue': 'Заполнять из значения заполнения',
  'FillValue': 'Значение заполнения',
  'FillChecking': 'Проверка заполнения',
  'ChoiceFoldersAndItems': 'Выбор групп и элементов',
  'ChoiceParameterLinks': 'Связи параметров выбора',
  'QuickChoice': 'Быстрый выбор',
  'CreateOnInput': 'Создавать при вводе',
  'ChoiceForm': 'Форма выбора',
  'LinkByType': 'Связь по типу',
  'ChoiceHistoryOnInput': 'История выбора при вводе',
  'Indexing': 'Индексирование',
  'FullTextSearch': 'Полнотекстовый поиск',
  'DataHistory': 'История данных',
  'AutoNumbering': 'Автонумерация',
  'NumberType': 'Тип номера',
  'NumberLength': 'Длина номера',
  'NumberAllowedLength': 'Допустимая длина номера',
  'NumberPeriodicity': 'Периодичность номера',
  'CheckUnique': 'Проверка уникальности',
  'Autonumbering': 'Автонумерация',
  'DefaultValue': 'Значение по умолчанию',
  'StandardAttributes': 'Стандартные реквизиты',
  'Characteristics': 'Характеристики',
  'BasedOn': 'На основании',
  'DataLockControlMode': 'Режим управления блокировкой данных',
  'FullTextSearchOnInputByString': 'Полнотекстовый поиск при вводе по строке',
  'ChoiceDataGetModeOnInputByString': 'Режим получения данных выбора при вводе по строке',
  'DefaultObjectForm': 'Основная форма объекта',
  'DefaultListForm': 'Основная форма списка',
  'DefaultChoiceForm': 'Основная форма выбора',
  'AuxiliaryObjectForm': 'Вспомогательная форма объекта',
  'AuxiliaryListForm': 'Вспомогательная форма списка',
  'AuxiliaryChoiceForm': 'Вспомогательная форма выбора',

  // HTTP and web services
  'RootURL': 'Корневой URL',
  'ReuseSessions': 'Повторное использование сеансов',
  'SessionMaxAge': 'Максимальный возраст сеанса',
  'Template': 'Шаблон URL',
  'HTTPMethod': 'Метод HTTP',
  'Handler': 'Обработчик',
  'Namespace': 'Пространство имён',
  'XDTOPackages': 'Пакеты XDTO',
  'DescriptorFileName': 'Файл описания веб-сервиса',
  'XDTOReturningValueType': 'Тип возвращаемого значения XDTO',
  'XDTOValueType': 'Тип значения XDTO',
  'Nillable': 'Допускает null',
  'Transactioned': 'Транзакционный',
  'ProcedureName': 'Имя процедуры',
  'TransferDirection': 'Направление передачи',

  // Integration services
  'ExternalIntegrationServiceAddress': 'Адрес внешнего сервиса интеграции',
  'ExternalIntegrationServiceChannelName': 'Имя канала внешнего сервиса интеграции',
  'MessageDirection': 'Направление сообщения',
  'ReceiveMessageProcessing': 'Обработчик полученного сообщения',

  // Other named metadata children
  'AddressingDimension': 'Измерение адресации',
  'References': 'Ссылки',
};

/**
 * Get Russian label for property name, fallback to original name
 */
export function getPropertyLabel(propertyName: string): string {
  return propertyLabels[propertyName] || propertyName;
}
