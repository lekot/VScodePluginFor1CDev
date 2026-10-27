/** Canonical public entry point for source-derived borrowed shells. */
export {
  BORROWED_OBJECT_SOURCE_PROPERTY_POLICY,
  COMMON_MODULE_BORROWED_BOOLEAN_PROPERTIES,
  buildBorrowedObjectShellFromSource,
  validateBorrowedObjectSource,
} from './borrowedObjectShellProjection';
export type {
  BorrowedObjectShellProjectionInput,
  BorrowedObjectShellProjectionResult,
  BorrowedObjectSourceValidationInput,
  BorrowedObjectSourceValidationResult,
} from './borrowedObjectShellProjection';
