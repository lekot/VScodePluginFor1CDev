import type { ConfigurationId } from '../../services/configurationSession/types';
import type { CfeProjectErrorCode } from './types';

/** The only Designer form formats currently emitted by the CFE form domain. */
export type CfeFormFormatVersion = '2.17' | '2.18' | '2.19' | '2.20' | '2.21';

export type CfeFormOwnerType = 'Catalog' | 'Document';
export type CfeFormCallType = 'Before' | 'After' | 'Override';
export type CfeFormVisualElementType = 'UsualGroup' | 'InputField' | 'Button';

/**
 * Creates a form that belongs to the extension. `ownerDotPath` is intentionally
 * a CFE path: the service proves that it resolves to one unambiguous Catalog or
 * Document in the linked extension before it creates any files.
 */
export interface CfeCreateOwnFormRequest {
  readonly extensionConfigurationId: ConfigurationId | string;
  readonly ownerDotPath: string;
  readonly formName: string;
  readonly formType?: 'Managed';
}

/**
 * Borrows one base form into an already borrowed owner. The owner is identified
 * by the UUID of the base metadata object. Exactly one form selector is required.
 */
export interface CfeBorrowFormRequest {
  readonly extensionConfigurationId: ConfigurationId | string;
  readonly ownerSourceUuid: string;
  readonly sourceFormUuid?: string;
  readonly sourceFormName?: string;
}

/** A scalar form-attribute type, for example `xs:string` or `cfg:CatalogRef.Products`. */
export interface CfeFormAttributeType {
  readonly typeName: string;
}

export interface CfeAddAttributeOperation {
  readonly kind: 'addAttribute';
  readonly name: string;
  readonly type: CfeFormAttributeType;
  readonly title?: string;
}

export interface CfeFormAction {
  readonly handler: string;
  readonly callType: CfeFormCallType;
}

export interface CfeAddCommandOperation {
  readonly kind: 'addCommand';
  readonly name: string;
  readonly title?: string;
  readonly actions?: readonly CfeFormAction[];
}

export interface CfeAddElementOperation {
  readonly kind: 'addElement';
  readonly elementType: CfeFormVisualElementType;
  readonly name: string;
  /** Omit to append to the form root; otherwise an existing UsualGroup is required. */
  readonly parentName?: string;
  /** Required by InputField and must name an extension form attribute. */
  readonly attributeName?: string;
  /** Required by Button and must name an extension or base command. */
  readonly commandName?: string;
  readonly title?: string;
}

export interface CfeSetFormEventOperation {
  readonly kind: 'setFormEvent';
  readonly eventName: string;
  readonly handler: string;
  readonly callType: CfeFormCallType;
}

export interface CfeSetElementEventOperation {
  readonly kind: 'setElementEvent';
  readonly elementName: string;
  readonly eventName: string;
  readonly handler: string;
  readonly callType: CfeFormCallType;
}

export interface CfeAddCommandActionOperation {
  readonly kind: 'addCommandAction';
  readonly commandName: string;
  readonly handler: string;
  readonly callType: CfeFormCallType;
}

export type CfeFormOperation =
  | CfeAddAttributeOperation
  | CfeAddCommandOperation
  | CfeAddElementOperation
  | CfeSetFormEventOperation
  | CfeSetElementEventOperation
  | CfeAddCommandActionOperation;

/**
 * `expectedFormHash` is the SHA-256 of the linked base `Ext/Form.xml`.
 * The service verifies it before queue admission and immediately before commit.
 */
export interface CfeExtendFormRequest {
  readonly extensionConfigurationId: ConfigurationId | string;
  readonly sourceFormUuid: string;
  readonly expectedFormHash: string;
  readonly operations: readonly CfeFormOperation[];
}

export type CfeFormMutationStatus =
  | 'created'
  | 'borrowed'
  | 'extended'
  | 'already-created'
  | 'already-borrowed'
  | 'unchanged';

export interface CfeFormMutationOutcome {
  readonly status: CfeFormMutationStatus;
  readonly ownerType: CfeFormOwnerType;
  readonly ownerName: string;
  readonly ownerSourceUuid?: string;
  readonly formName: string;
  readonly sourceFormUuid?: string;
  /** Extension-relative metadata file path. */
  readonly metadataPath: string;
  /** Extension-relative Ext/Form.xml path. */
  readonly formPath: string;
  /** Extension-relative form module path. */
  readonly modulePath: string;
  readonly localUuid: string;
}

export type CfeFormErrorCode = CfeProjectErrorCode | 'CFE_FORM_ID_EXHAUSTED';

/** Isolated form-domain error. Integration later maps it into the shared Agent/MCP error DTO. */
export class CfeFormError extends Error {
  constructor(
    readonly code: CfeFormErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CfeFormError';
  }
}
