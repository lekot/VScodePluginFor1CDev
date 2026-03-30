export interface AddElementWizardTypeOption {
  tag: string;
  defaultName: string;
  hint: string;
}

export interface AddElementWizardConfigPayload {
  options: AddElementWizardTypeOption[];
}

const ADD_ELEMENT_WIZARD_OPTIONS: AddElementWizardTypeOption[] = [
  { tag: 'InputField', defaultName: 'NewInputField', hint: 'Поле ввода: отображает и редактирует значение реквизита.' },
  { tag: 'CheckBoxField', defaultName: 'NewCheckBoxField', hint: 'Флажок: булево поле Да/Нет.' },
  { tag: 'Button', defaultName: 'NewButton', hint: 'Кнопка: запускает команду или действие формы.' },
  { tag: 'LabelField', defaultName: 'NewLabelField', hint: 'Надпись: статический текст в форме.' },
  { tag: 'Table', defaultName: 'NewTable', hint: 'Таблица: отображает коллекцию строк и колонок.' },
  { tag: 'Group', defaultName: 'NewGroup', hint: 'Группа: контейнер для компоновки дочерних элементов.' },
  { tag: 'UsualGroup', defaultName: 'NewUsualGroup', hint: 'Обычная группа: базовый контейнер для элементов формы.' },
  { tag: 'CollapsibleGroup', defaultName: 'NewCollapsibleGroup', hint: 'Сворачиваемая группа: контейнер с раскрытием/сворачиванием.' },
  { tag: 'Pages', defaultName: 'NewPages', hint: 'Страницы: контейнер вкладок с наборами элементов.' },
  { tag: 'Page', defaultName: 'NewPage', hint: 'Страница: отдельная вкладка внутри элемента Pages.' },
  { tag: 'AutoCommandBar', defaultName: 'NewAutoCommandBar', hint: 'Автокомандная панель: набор кнопок команд формы.' },
];

const ALLOWED_TAGS = new Set(ADD_ELEMENT_WIZARD_OPTIONS.map((option) => option.tag));

export function isAllowedAddElementWizardTag(tag: string): boolean {
  return ALLOWED_TAGS.has(tag);
}

export function getAddElementWizardDefaultName(tag: string): string {
  const option = ADD_ELEMENT_WIZARD_OPTIONS.find((item) => item.tag === tag);
  return option?.defaultName ?? 'NewItem';
}

export function getAddElementWizardConfigPayload(): AddElementWizardConfigPayload {
  return {
    options: ADD_ELEMENT_WIZARD_OPTIONS.map((option) => ({ ...option })),
  };
}
