/** Type-folder container displayed in the lazy subsystem composition tree */
export interface CompositionTypeContainer {
  typeFolderId: string;
  metadataType: string;
  displayName: string;
  objectCount: number | null;
  checkedCount: number;
}

/** Object entry displayed in the subsystem composition editor */
export interface CompositionObjectEntry {
  /** Reference in "Type.Name" format — key in XML Content (e.g. "Catalog.Items") */
  ref: string;
  /** Display name from the metadata tree */
  displayName: string;
  /** Metadata type: "Catalog", "Document", etc. */
  type: string;
}

/** Payload sent with the 'init' message to the webview */
export interface CompositionInitPayload {
  subsystemName: string;
  objects: CompositionObjectEntry[];
  checkedRefs: string[];
  totalCount: number;
}

// ── Webview → Extension ─────────────────────────────────────────────

export type CompositionWebviewMessage =
  | { command: 'toggle'; data: { ref: string; checked: boolean } }
  | { command: 'save' }
  | { command: 'cancel' }
  | { command: 'selectAll'; data: { refs: string[] } }
  | { command: 'deselectAll'; data: { refs: string[] } };

// ── Extension → Webview ─────────────────────────────────────────────

// TODO: add ibcmd Config Check Gate support (gateWarning message)
export type CompositionHostMessage =
  | { command: 'init'; data: CompositionInitPayload }
  | { command: 'saveSuccess' }
  | { command: 'saveError'; data: { message: string } }
  | { command: 'error'; data: { message: string } };
