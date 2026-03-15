/**
 * Data models for the Roles and Rights Editor
 */

/**
 * Configuration format type
 */
export enum ConfigFormat {
  Designer = 'Designer',
  EDT = 'EDT'
}

/**
 * Represents all possible rights for a metadata object
 */
export interface ObjectRights {
  read: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  view: boolean;
  edit: boolean;
  interactiveInsert: boolean;
  interactiveDelete: boolean;
  interactiveClear: boolean;
  interactiveDeleteMarked: boolean;
  interactiveUndeleteMarked: boolean;
  interactiveDeletePredefinedData: boolean;
  interactiveSetDeletionMark: boolean;
  interactiveClearDeletionMark: boolean;
  interactiveDeleteMarkedPredefinedData: boolean;
}

/**
 * Map of object full names to their rights
 * Key format: {MetadataType}.{ObjectName} (e.g., "Catalog.Products")
 */
export interface RightsMap {
  [objectFullName: string]: ObjectRights;
}

/**
 * Metadata about the role file
 */
export interface RoleMetadata {
  format: ConfigFormat;
  version: string;
  lastModified: Date;
}

/**
 * Complete role model with all rights assignments
 */
export interface RoleModel {
  name: string;
  filePath: string;
  rights: RightsMap;
  metadata: RoleMetadata;
}

/**
 * All possible right types as a union type
 */
export type RightType = keyof ObjectRights;

/**
 * Array of all right types for iteration
 */
export const ALL_RIGHT_TYPES: RightType[] = [
  'read',
  'insert',
  'update',
  'delete',
  'view',
  'edit',
  'interactiveInsert',
  'interactiveDelete',
  'interactiveClear',
  'interactiveDeleteMarked',
  'interactiveUndeleteMarked',
  'interactiveDeletePredefinedData',
  'interactiveSetDeletionMark',
  'interactiveClearDeletionMark',
  'interactiveDeleteMarkedPredefinedData'
];

/**
 * Base rights that other rights depend on
 */
export const BASE_RIGHTS: RightType[] = ['read', 'insert', 'update', 'delete'];

/**
 * Interactive rights that require base rights
 */
export const INTERACTIVE_RIGHTS: RightType[] = [
  'interactiveInsert',
  'interactiveDelete',
  'interactiveClear',
  'interactiveDeleteMarked',
  'interactiveUndeleteMarked',
  'interactiveDeletePredefinedData',
  'interactiveSetDeletionMark',
  'interactiveClearDeletionMark',
  'interactiveDeleteMarkedPredefinedData'
];

/**
 * Rights that require Read right to be enabled
 */
export const RIGHTS_REQUIRING_READ: RightType[] = ['update', 'delete'];

/**
 * Create an empty ObjectRights instance with all rights set to false
 */
export function createEmptyObjectRights(): ObjectRights {
  return {
    read: false,
    insert: false,
    update: false,
    delete: false,
    view: false,
    edit: false,
    interactiveInsert: false,
    interactiveDelete: false,
    interactiveClear: false,
    interactiveDeleteMarked: false,
    interactiveUndeleteMarked: false,
    interactiveDeletePredefinedData: false,
    interactiveSetDeletionMark: false,
    interactiveClearDeletionMark: false,
    interactiveDeleteMarkedPredefinedData: false
  };
}

/**
 * Check if all rights in an ObjectRights instance are false
 */
export function allRightsFalse(rights: ObjectRights): boolean {
  return ALL_RIGHT_TYPES.every(rightType => !rights[rightType]);
}
