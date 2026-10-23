export interface PropertiesBootstrapData {
  readonly nodeId: string;
  readonly sessionToken: string;
}

export interface WebviewBrowserApi<TMessage> {
  postMessage(message: TMessage): void;
}

export type PropertiesOutboundMessage =
  | { type: 'save'; properties: Record<string, unknown>; nodeId: string; sessionToken: string }
  | { type: 'cancel'; nodeId: string; sessionToken: string }
  | { type: 'dirtyChange'; isDirty: boolean; properties: Record<string, unknown>; nodeId: string; sessionToken: string }
  | { type: 'editType'; propertyName: string; nodeId: string; sessionToken: string }
  | { type: 'editSource'; propertyName: string; nodeId: string; sessionToken: string }
  | { type: 'editContent'; nodeType: string | undefined }
  | { type: 'renameElement'; nodeId: string; sessionToken: string }
  | { type: 'gotoHandler'; handler: string }
  | { type: 'openPictureFile'; filePath: string };

export type PropertiesInboundMessage =
  | { type: 'update' }
  | { type: 'saved' }
  | { type: 'error'; message: string }
  | { type: 'validationError'; errors?: Record<string, string> }
  | { type: 'typeUpdated'; sessionToken?: string; nodeId?: string; property: string; value: string }
  | { type: 'sourceUpdated'; sessionToken?: string; nodeId?: string; property: string; value: string };

export type FormSelectionOutboundMessage =
  | {
      type: 'propertyChanged';
      propertyName: string | undefined;
      value: unknown;
      scope: string;
      selectionRevision: string;
      docUri: string;
      entityType: string | undefined;
      entityId: string | undefined;
      entityName: string | undefined;
    }
  | {
      type: 'editFormSelectionType';
      propertyName: string | undefined;
      selectionRevision: string;
      docUri: string;
      entityType: string | undefined;
      entityId: string | undefined;
      entityName: string | undefined;
    }
  | { type: 'gotoEventHandler'; handlerName: string; docUri: string }
  | {
      type: 'createEventHandler';
      eventName: string;
      elementId: string;
      elementName: string;
      elementTag: string;
      docUri: string;
    };
