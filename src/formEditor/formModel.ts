/**
 * Data model for 1C form structure (Ext/Form.xml).
 * Used by form editor provider and FormXmlWriter.
 */

/** Events: event name → method name (e.g. OnOpen → ПриОткрытии). */
export type FormEventsMap = Record<string, string>;

/** Single form-level or element-level event. */
export interface FormEventItem {
  name: string;
  method: string;
}

/** One item in the form elements tree (ChildItems). */
export interface FormChildItem {
  /** Element tag: UsualGroup, Page, InputField, Button, Table, etc. */
  tag: string;
  /** Optional id from XML (e.g. "1", "12"). */
  id?: string;
  /** name attribute. */
  name: string;
  /** Other properties (Title, DataPath, Group, CommandName, etc.) as raw values for round-trip. */
  properties: Record<string, unknown>;
  /** Nested ChildItems. */
  childItems: FormChildItem[];
  /** Events of this element (event name → method name). */
  events?: FormEventsMap;
}

/** Form attribute (реквизит формы). */
export interface FormAttribute {
  name: string;
  id?: string;
  /** Type and other content for round-trip. */
  properties: Record<string, unknown>;
}

/** Form command. */
export interface FormCommand {
  name: string;
  id?: string;
  properties: Record<string, unknown>;
}

/** Root model of Ext/Form.xml. */
export interface FormModel {
  /** Root of the form elements tree (top-level ChildItems). */
  childItemsRoot: FormChildItem[];
  /** Form-level attributes (реквизиты). */
  attributes: FormAttribute[];
  /** Form commands. */
  commands: FormCommand[];
  /** Form-level events. */
  formEvents: FormEventItem[];
  /** Name of the form command bar element (from root AutoCommandBar). */
  autoCommandBarName?: string;
  /** Id of the form command bar element (from root AutoCommandBar), for round-trip. */
  autoCommandBarId?: string;
  /** Optional: parameters, group list, etc. for future use. */
  parameters?: unknown[];
}

/** Result of parsing when file is missing (allowed by option). */
export interface FormParseFileMissing {
  fileMissing: true;
  model: FormModel;
}

/** Successful parse result. */
export interface FormParseSuccess {
  fileMissing?: false;
  model: FormModel;
}

/** Parse error with message. */
export interface FormParseError {
  error: string;
}

export type FormParseResult = FormParseSuccess | FormParseFileMissing | FormParseError;

export function isFormParseError(r: FormParseResult): r is FormParseError {
  return 'error' in r && typeof (r as FormParseError).error === 'string';
}

export function isFormParseFileMissing(r: FormParseResult): r is FormParseFileMissing {
  return 'fileMissing' in r && (r as FormParseFileMissing).fileMissing === true;
}

/** Empty model for new form or when file is missing. */
export function createEmptyFormModel(): FormModel {
  return {
    childItemsRoot: [],
    attributes: [],
    commands: [],
    formEvents: [],
  };
}
