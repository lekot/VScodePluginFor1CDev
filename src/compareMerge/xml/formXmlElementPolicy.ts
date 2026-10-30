/** Exact logform visual item names accepted by identity, placement, and patch guards. */
export const FORM_VISUAL_ELEMENT_NAMES = [
  'Item', 'InputField', 'Table', 'UsualGroup', 'Button', 'LabelField', 'Decoration',
  'CheckBoxField', 'RadioButtonField', 'LabelDecoration', 'PictureField', 'PictureDecoration',
  'CalendarField', 'CommandBar', 'ButtonGroup', 'Popup', 'Pages', 'Page', 'PageItem', 'Column',
  'SearchStringAddition', 'SearchControlAddition', 'AutoCommandBar',
] as const;

export const FORM_VISUAL_ELEMENT_SET: ReadonlySet<string> = new Set(FORM_VISUAL_ELEMENT_NAMES);
