/** All known events per element tag. Order = display order in the panel. */
export const FORM_EVENT_CATALOG: Readonly<Record<string, readonly string[]>> = {
  // --- Element-level events (from spec sections 8.x) ---
  InputField: [
    'OnChange', 'StartChoice', 'ChoiceProcessing', 'Clearing',
    'AutoComplete', 'TextEditEnd', 'Opening', 'OnEditEnd',
    'DragCheck', 'Drag', 'DragStart',
  ],
  Button: ['Click'],
  Table: [
    'Selection', 'OnActivateRow', 'BeforeRowChange',
    'BeforeAddRow', 'BeforeDeleteRow', 'AfterDeleteRow',
    'DragStart', 'Drag', 'DragCheck', 'Drop',
  ],
  Pages: ['OnCurrentPageChange'],
  LabelDecoration: ['Click'],
  LabelField: ['Click', 'URLProcessing'],
  CheckBoxField: ['OnChange'],
  PictureDecoration: ['Click'],
  PictureField: ['Click', 'StartDrag', 'DragCheck', 'Drag'],
  CalendarField: ['Selection', 'OnPeriodOutput'],
  RadioButtonField: ['OnChange'],
  SpreadSheetDocumentField: ['OnActivateArea', 'Selection', 'DetailProcessing'],

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
  OnActivateArea:              'ПриАктивизацииОбласти',
  DetailProcessing:            'ОбработкаРасшифровки',
  OnPeriodOutput:              'ПриВыводеПериода',
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
