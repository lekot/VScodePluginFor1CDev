/**
 * Form editor tab title: "ТипОбъекта ИмяОбъекта: ИмяФормы" from Ext/Form.xml path.
 */

import * as path from 'path';

/** Metadata folder name → Russian label for form editor title. */
const METADATA_FOLDER_TO_RUSSIAN: Record<string, string> = {
  Catalogs: 'Справочник',
  Documents: 'Документ',
  Enums: 'Перечисление',
  Reports: 'Отчёт',
  DataProcessors: 'Обработка',
  ChartsOfCharacteristicTypes: 'План видов характеристик',
  ChartsOfAccounts: 'План счетов',
  ChartsOfCalculationTypes: 'План видов расчёта',
  InformationRegisters: 'Регистр сведений',
  AccumulationRegisters: 'Регистр накопления',
  AccountingRegisters: 'Регистр бухгалтерии',
  CalculationRegisters: 'Регистр расчёта',
  BusinessProcesses: 'Бизнес-процесс',
  Tasks: 'Задача',
  ExternalDataSources: 'Внешний источник данных',
  Constants: 'Константа',
  SessionParameters: 'Параметр сеанса',
  FilterCriteria: 'Критерий отбора',
  ScheduledJobs: 'Регламентное задание',
  FunctionalOptions: 'Функциональная опция',
  FunctionalOptionsParameters: 'Параметр функциональных опций',
  SettingsStorages: 'Хранилище настроек',
  EventSubscriptions: 'Подписка на событие',
  CommonModules: 'Общий модуль',
  CommandGroups: 'Группа команд',
  Roles: 'Роль',
  Interfaces: 'Интерфейс',
  Styles: 'Стиль',
  WebServices: 'Веб-сервис',
  HTTPServices: 'HTTP-сервис',
  IntegrationServices: 'Сервис интеграции',
  Subsystems: 'Подсистема',
};

const FALLBACK_TITLE = 'Форма';

/**
 * Compute form editor tab title from path to Ext/Form.xml.
 * Expected path: .../TypeFolder/ObjectName/Forms/FormName/Ext/Form.xml
 * Returns "ТипОбъекта ИмяОбъекта: ИмяФормы" or fallback if path is not typical.
 */
export function getFormEditorTitle(formXmlPath: string): string {
  const normalized = path.normalize(formXmlPath);
  const basename = path.basename(normalized);
  const parentOfFile = path.dirname(normalized);
  // Must end with Ext/Form.xml
  if (basename !== 'Form.xml' || path.basename(parentOfFile) !== 'Ext') {
    return FALLBACK_TITLE;
  }
  const formDir = path.dirname(parentOfFile); // .../FormName
  const formName = path.basename(formDir);
  const formsDir = path.dirname(formDir);
  if (path.basename(formsDir) !== 'Forms') {
    return FALLBACK_TITLE;
  }
  const objectDir = path.dirname(formsDir);
  const objectName = path.basename(objectDir);
  const typeFolder = path.basename(path.dirname(objectDir));
  const typeLabel = METADATA_FOLDER_TO_RUSSIAN[typeFolder] ?? typeFolder;
  if (!formName || !objectName) {
    return FALLBACK_TITLE;
  }
  return `${typeLabel} ${objectName}: ${formName}`;
}
