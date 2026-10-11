/**
 * Data models for the Roles and Rights Editor
 */

import {
  ROLE_RIGHTS_REGISTRY,
  ROLE_RIGHT_DEPENDENCIES,
  UI_ROLE_RIGHTS,
  type RoleRightDescriptor,
} from '../roleRightsRegistry';

/**
 * Configuration format type
 */
/* eslint-disable @typescript-eslint/naming-convention -- values mirror 1C toolchain format names */
export enum ConfigFormat {
  Designer = 'Designer',
  EDT = 'EDT'
}
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Represents all possible rights for a metadata object
 */
export interface ObjectRights {
  /** Canonical registry keys, including recognized rights outside the rendered UI projection. */
  [rightKey: string]: boolean;
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
  /**
   * Raw XML fragments of <restrictionTemplate> from Ext/Rights.xml (RLS templates), for display in the editor.
   * Not written by RoleXmlSerializer; preserved in Rights.xml on EDT save via DOM merge.
   */
  restrictionTemplatesText?: string;
  /** Original Role.xml text, retained so Designer saves can patch only changed right elements. */
  sourceXml?: string;
  /** Values explicitly changed through the UI, including dependency-driven changes. */
  changedRights?: Record<string, Record<string, boolean>>;
}

/**
 * All possible right types as a union type
 */
export type RightType = string;

/** UI checkbox keys are a projection of the canonical registry. */
export type UiRightType = RightType;

/**
 * Array of all right types for iteration
 */
export const UI_RIGHT_TYPES: RightType[] = UI_ROLE_RIGHTS.map((right) => right.key as RightType);

/** Every known domain right, including rights hidden from the current editor grid. */
export const ALL_RIGHT_TYPES: string[] = ROLE_RIGHTS_REGISTRY.map((right) => right.key);

export const ALL_ROLE_RIGHTS: readonly RoleRightDescriptor[] = ROLE_RIGHTS_REGISTRY;

/**
 * Base rights that other rights depend on
 */
export const BASE_RIGHTS: RightType[] = [...new Set(ROLE_RIGHTS_REGISTRY.flatMap((right) => right.dependencies))];

/**
 * Interactive rights that require base rights
 */
export const INTERACTIVE_RIGHTS: RightType[] = ROLE_RIGHTS_REGISTRY
  .filter((right) => right.interactiveBase !== undefined)
  .map((right) => right.key);

/**
 * Rights that require Read right to be enabled
 */
export const RIGHTS_REQUIRING_READ: RightType[] = Object.entries(ROLE_RIGHT_DEPENDENCIES)
  .filter(([, dependencies]) => dependencies.includes('read'))
  .map(([right]) => right as RightType);

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
    interactiveDeleteMarked: false,
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
  return Object.values(rights).every((value) => !value);
}
