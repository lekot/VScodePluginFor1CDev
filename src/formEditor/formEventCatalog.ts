/** All known events per element tag. Order = display order in the panel. */
export const FORM_EVENT_CATALOG: Readonly<Record<string, readonly string[]>> = {
  InputField: [
    'OnChange', 'StartChoice', 'ChoiceProcessing', 'Clearing',
    'AutoComplete', 'TextEditEnd', 'Opening', 'OnEditEnd',
    'DragCheck', 'Drag', 'DragStart',
  ],
  Button: ['Click'],
  Table: [
    'Selection', 'OnActivateRow', 'OnChange', 'BeforeRowChange',
    'BeforeAddRow', 'BeforeDeleteRow', 'AfterDeleteRow',
    'OnStartEdit', 'OnEditEnd',
    'DragStart', 'DragEnd', 'Drag', 'DragCheck', 'Drop',
  ],
  Pages: ['OnCurrentPageChange'],
  LabelDecoration: ['Click', 'URLProcessing'],
  LabelField: ['Click', 'URLProcessing'],
  CheckBoxField: ['OnChange'],
  PictureDecoration: ['Click'],
  PictureField: ['Click', 'StartDrag', 'DragCheck', 'Drag'],
  CalendarField: ['Selection', 'OnPeriodOutput'],
  RadioButtonField: ['OnChange'],
  SpreadSheetDocumentField: [
    'OnActivate', 'Selection', 'OnChange', 'DetailProcessing',
    'OnChangeAreaContent', 'DragCheck', 'Drag', 'DragStart',
  ],
  TextDocumentField: ['OnChange'],
  FormattedDocumentField: ['OnClick', 'URLProcessing'],
  HTMLDocumentField: ['DocumentComplete', 'OnClick'],

  // Tags with no events:
  // UsualGroup, Page, CommandBar, ButtonGroup, Popup, AutoCommandBar -- not listed = no events
};

/** Form-level events (spec section 6). */
export const FORM_LEVEL_EVENTS: readonly string[] = [
  'OnCreateAtServer', 'OnOpen', 'BeforeClose', 'OnClose',
  'AfterWrite', 'BeforeWrite', 'BeforeWriteAtServer',
  'OnWriteAtServer', 'AfterWriteAtServer', 'OnReadAtServer',
  'NotificationProcessing', 'ChoiceProcessing',
  'NewWriteProcessing', 'FillCheckProcessingAtServer',
  'OnLoadUserSettingsAtServer', 'OnSaveUserSettingsAtServer',
  'URLProcessing',
];

/** Russian suffixes for auto-naming handlers. */
export const EVENT_RUSSIAN_SUFFIX: Readonly<Record<string, string>> = {
  OnChange:                    'ПриИзменении',
  StartChoice:                 'НачалоВыбора',
  ChoiceProcessing:            'ОбработкаВыбора',
  Clearing:                    'Очистка',
  AutoComplete:                'АвтоПодбор',
  TextEditEnd:                 'ОкончаниеВводаТекста',
  Opening:                     'Открытие',
  OnEditEnd:                   'ПриОкончанииРедактирования',
  DragCheck:                   'ПроверкаПеретаскивания',
  Drag:                        'Перетаскивание',
  DragStart:                   'НачалоПеретаскивания',
  StartDrag:                   'НачалоПеретаскивания',
  Drop:                        'ОкончаниеПеретаскивания',
  Click:                       'Нажатие',
  URLProcessing:               'ОбработкаНавигационнойСсылки',
  Selection:                   'Выбор',
  OnActivateRow:               'ПриАктивизацииСтроки',
  BeforeRowChange:             'ПередНачаломИзменения',
  BeforeAddRow:                'ПередНачаломДобавления',
  BeforeDeleteRow:             'ПередУдалением',
  AfterDeleteRow:              'ПослеУдаления',
  OnCurrentPageChange:         'ПриСменеСтраницы',
  DetailProcessing:            'ОбработкаРасшифровки',
  OnPeriodOutput:              'ПриВыводеПериода',
  OnActivate:                  'ПриАктивизацииОбласти',
  OnChangeAreaContent:         'ПриИзмененииСодержимогоОбласти',
  DragEnd:                     'ОкончаниеПеретаскивания',
  OnStartEdit:                 'ПриНачалеРедактирования',
  OnClick:                     'Нажатие',
  DocumentComplete:            'ДокументСформирован',
  // Form-level
  OnCreateAtServer:            'ПриСозданииНаСервере',
  OnOpen:                      'ПриОткрытии',
  BeforeClose:                 'ПередЗакрытием',
  OnClose:                     'ПриЗакрытии',
  AfterWrite:                  'ПослеЗаписи',
  BeforeWrite:                 'ПередЗаписью',
  BeforeWriteAtServer:         'ПередЗаписьюНаСервере',
  OnWriteAtServer:             'ПриЗаписиНаСервере',
  AfterWriteAtServer:          'ПослеЗаписиНаСервере',
  OnReadAtServer:              'ПриЧтенииНаСервере',
  NotificationProcessing:      'ОбработкаОповещения',
  NewWriteProcessing:          'ОбработкаЗаписиНового',
  FillCheckProcessingAtServer: 'ОбработкаПроверкиЗаполненияНаСервере',
  OnLoadUserSettingsAtServer:  'ПриЗагрузкеПользовательскихНастроекНаСервере',
  OnSaveUserSettingsAtServer:  'ПриСохраненииПользовательскихНастроекНаСервере',
};

/**
 * Get all possible events for a given element tag.
 * Returns empty array for tags that have no events.
 */
export function getEventsForTag(tag: string): readonly string[] {
  return FORM_EVENT_CATALOG[tag] ?? [];
}

/**
 * Generate default handler name: <ElementName><RussianSuffix>.
 * For form-level events, elementName is omitted (suffix only).
 * Falls back to eventName if no suffix is found.
 */
export function generateHandlerName(
  elementName: string,
  eventName: string,
  isFormLevel: boolean
): string {
  const suffix = EVENT_RUSSIAN_SUFFIX[eventName] ?? eventName;
  return isFormLevel ? suffix : elementName + suffix;
}

// Events that require &НаСервере directive (server-side context).
const SERVER_EVENTS = new Set([
  'OnCreateAtServer',
  'BeforeWriteAtServer',
  'OnWriteAtServer',
  'AfterWriteAtServer',
  'OnReadAtServer',
  'FillCheckProcessingAtServer',
  'OnLoadUserSettingsAtServer',
  'OnSaveUserSettingsAtServer',
  'NewWriteProcessing', // runs at server despite no suffix
]);

/**
 * Returns the BSL compiler directive for a given event name.
 * Server events get '&НаСервере', all others get '&НаКлиенте'.
 */
export function getDirective(eventName: string): string {
  return SERVER_EVENTS.has(eventName) ? '&НаСервере' : '&НаКлиенте';
}

/** Parameters for element-level event handlers (1C platform signatures). */
const ELEMENT_EVENT_PARAMS: Readonly<Record<string, string>> = {
  OnChange: 'Элемент',
  StartChoice: 'Элемент, ДанныеВыбора, СтандартнаяОбработка',
  ChoiceProcessing: 'Элемент, ВыбранноеЗначение, СтандартнаяОбработка',
  Clearing: 'Элемент, СтандартнаяОбработка',
  AutoComplete: 'Элемент, Текст, ДанныеВыбора, ПараметрыПолученияДанных, Ожидание, СтандартнаяОбработка',
  TextEditEnd: 'Элемент, Текст, ДанныеВыбора, ПараметрыПолученияДанных, СтандартнаяОбработка',
  Opening: 'Элемент, СтандартнаяОбработка',
  Click: 'Элемент',
  URLProcessing: 'Элемент, НавигационнаяСсылка, СтандартнаяОбработка',
  Selection: 'Элемент, ВыбраннаяСтрока, Поле, СтандартнаяОбработка',
  OnActivateRow: 'Элемент',
  BeforeRowChange: 'Элемент, Отказ',
  BeforeAddRow: 'Элемент, Отказ, Копирование, Родитель, Группа, Параметр',
  BeforeDeleteRow: 'Элемент, Отказ',
  AfterDeleteRow: 'Элемент',
  OnEditEnd: 'Элемент, НоваяСтрока, ОтменаРедактирования',
  OnStartEdit: 'Элемент, НоваяСтрока, Копирование',
  DragStart: 'Элемент, ПараметрыПеретаскивания, Выполнение',
  StartDrag: 'Элемент, ПараметрыПеретаскивания, Выполнение',
  Drag: 'Элемент, ПараметрыПеретаскивания, СтандартнаяОбработка',
  DragCheck: 'Элемент, ПараметрыПеретаскивания, СтандартнаяОбработка',
  Drop: 'Элемент, ПараметрыПеретаскивания, СтандартнаяОбработка',
  DragEnd: 'Элемент, ПараметрыПеретаскивания, СтандартнаяОбработка',
  OnCurrentPageChange: 'Элемент, ТекущаяСтраница',
  OnPeriodOutput: 'Элемент, ОформлениеПериода',
  OnActivate: 'Элемент',
  DetailProcessing: 'Элемент, Расшифровка, СтандартнаяОбработка',
  OnChangeAreaContent: 'Элемент, Область',
  OnClick: 'Элемент',
  DocumentComplete: 'Элемент',
};

/** Parameters for form-level event handlers (1C platform signatures). */
const FORM_LEVEL_EVENT_PARAMS: Readonly<Record<string, string>> = {
  OnCreateAtServer: 'Отказ, СтандартнаяОбработка',
  OnOpen: 'Отказ',
  BeforeClose: 'Отказ, ЗавершениеРаботы, ТекстПредупреждения, СтандартнаяОбработка',
  OnClose: 'ЗавершениеРаботы',
  AfterWrite: 'ПараметрыЗаписи',
  BeforeWrite: 'Отказ, ПараметрыЗаписи',
  BeforeWriteAtServer: 'Отказ, ТекущийОбъект, ПараметрыЗаписи',
  OnWriteAtServer: 'Отказ, ТекущийОбъект, ПараметрыЗаписи',
  AfterWriteAtServer: 'ТекущийОбъект, ПараметрыЗаписи',
  OnReadAtServer: 'ТекущийОбъект',
  NotificationProcessing: 'ИмяСобытия, Параметр, Источник',
  ChoiceProcessing: 'ВыбранноеЗначение, ИсточникВыбора',
  NewWriteProcessing: 'НовыйОбъект, Источник, СтандартнаяОбработка',
  FillCheckProcessingAtServer: 'Отказ, ПроверяемыеРеквизиты',
  OnLoadUserSettingsAtServer: 'Настройки',
  OnSaveUserSettingsAtServer: 'Настройки',
  URLProcessing: 'НавигационнаяСсылка, СтандартнаяОбработка',
};

/**
 * Get the parameter list string for an event handler.
 * Returns empty string if no parameters are known.
 */
export function getEventParams(eventName: string, isFormLevel: boolean): string {
  if (isFormLevel) {
    return FORM_LEVEL_EVENT_PARAMS[eventName] ?? '';
  }
  return ELEMENT_EVENT_PARAMS[eventName] ?? '';
}
