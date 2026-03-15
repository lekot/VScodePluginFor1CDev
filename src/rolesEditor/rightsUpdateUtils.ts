/**
 * Rights update utilities for managing role permissions with automatic dependency handling
 */

import {
  RoleModel,
  ObjectRights,
  RightType,
  createEmptyObjectRights,
  allRightsFalse,
  RIGHTS_REQUIRING_READ,
  INTERACTIVE_RIGHTS
} from './models/roleModel';

/**
 * Result of a rights update operation
 */
export interface UpdateRightResult {
  success: boolean;
  errors: string[];
  updatedRights: ObjectRights | null;
}

/**
 * Mapping of interactive rights to their base rights
 */
const INTERACTIVE_TO_BASE_RIGHT: Record<string, RightType> = {
  interactiveInsert: 'insert',
  interactiveDelete: 'delete',
  interactiveClear: 'delete',
  interactiveDeleteMarked: 'delete',
  interactiveUndeleteMarked: 'delete',
  interactiveDeletePredefinedData: 'delete',
  interactiveSetDeletionMark: 'delete',
  interactiveClearDeletionMark: 'delete',
  interactiveDeleteMarkedPredefinedData: 'delete'
};

/**
 * Mapping of base rights to their dependent interactive rights
 */
const BASE_TO_INTERACTIVE_RIGHTS: Record<string, RightType[]> = {
  insert: ['interactiveInsert'],
  delete: [
    'interactiveDelete',
    'interactiveClear',
    'interactiveDeleteMarked',
    'interactiveUndeleteMarked',
    'interactiveDeletePredefinedData',
    'interactiveSetDeletionMark',
    'interactiveClearDeletionMark',
    'interactiveDeleteMarkedPredefinedData'
  ]
};

/**
 * Update a single right for an object with automatic dependency management
 * 
 * Algorithm:
 * 1. Get or create object rights
 * 2. Update the specified right
 * 3. Apply dependency rules:
 *    - Enabling Update/Delete automatically enables Read
 *    - Enabling interactive rights automatically enables base rights
 *    - Disabling Read automatically disables Update/Delete
 *    - Disabling base rights automatically disables interactive rights
 * 4. Remove object from RightsMap if all rights are false
 * 
 * @param roleModel - The role model to update
 * @param objectName - Full name of the object (e.g., "Catalog.Products")
 * @param rightType - The right to update
 * @param value - New value for the right (true to enable, false to disable)
 * @returns Result with success status and any validation errors
 */
export function updateRight(
  roleModel: RoleModel,
  objectName: string,
  rightType: RightType,
  value: boolean
): UpdateRightResult {
  // Precondition checks
  if (!roleModel) {
    return {
      success: false,
      errors: ['Role model is null or undefined'],
      updatedRights: null
    };
  }

  if (!objectName || objectName.trim() === '') {
    return {
      success: false,
      errors: ['Object name is empty'],
      updatedRights: null
    };
  }

  if (!rightType) {
    return {
      success: false,
      errors: ['Right type is invalid'],
      updatedRights: null
    };
  }

  // Step 1: Get or create object rights
  if (!roleModel.rights[objectName]) {
    roleModel.rights[objectName] = createEmptyObjectRights();
  }

  const objectRights = roleModel.rights[objectName];

  // Step 2: Update the specified right
  objectRights[rightType] = value;

  // Step 3: Apply dependency rules
  if (value === true) {
    // Enabling a right may require enabling dependencies
    
    // Rule: Update or Delete requires Read
    if (RIGHTS_REQUIRING_READ.includes(rightType)) {
      objectRights.read = true;
    }

    // Rule: Interactive rights require their base rights
    if (INTERACTIVE_RIGHTS.includes(rightType)) {
      const baseRight = INTERACTIVE_TO_BASE_RIGHT[rightType];
      if (baseRight) {
        objectRights[baseRight] = true;
        
        // If the base right requires Read, enable Read as well
        if (RIGHTS_REQUIRING_READ.includes(baseRight)) {
          objectRights.read = true;
        }
      }
    }
  } else {
    // Disabling a right may require disabling dependents
    
    // Rule: Disabling Read disables Update and Delete
    if (rightType === 'read') {
      objectRights.update = false;
      objectRights.delete = false;
      
      // Also disable all interactive rights that depend on delete
      const deleteInteractiveRights = BASE_TO_INTERACTIVE_RIGHTS['delete'] || [];
      deleteInteractiveRights.forEach(interactiveRight => {
        objectRights[interactiveRight] = false;
      });
    }

    // Rule: Disabling base rights disables their interactive rights
    if (rightType === 'insert' || rightType === 'delete') {
      const dependentInteractiveRights = BASE_TO_INTERACTIVE_RIGHTS[rightType] || [];
      dependentInteractiveRights.forEach(interactiveRight => {
        objectRights[interactiveRight] = false;
      });
    }
  }

  // Step 4: Remove object if all rights are false
  if (allRightsFalse(objectRights)) {
    delete roleModel.rights[objectName];
    return {
      success: true,
      errors: [],
      updatedRights: null
    };
  }

  // Return success with updated rights
  return {
    success: true,
    errors: [],
    updatedRights: { ...objectRights }
  };
}

/**
 * Get the base right for an interactive right
 * 
 * @param interactiveRight - The interactive right type
 * @returns The base right type, or null if not an interactive right
 */
export function getBaseRight(interactiveRight: RightType): RightType | null {
  return INTERACTIVE_TO_BASE_RIGHT[interactiveRight] || null;
}

/**
 * Get all interactive rights that depend on a base right
 * 
 * @param baseRight - The base right type
 * @returns Array of dependent interactive rights
 */
export function getInteractiveRights(baseRight: RightType): RightType[] {
  return BASE_TO_INTERACTIVE_RIGHTS[baseRight] || [];
}

/**
 * Check if a right type is an interactive right
 * 
 * @param rightType - The right type to check
 * @returns True if the right is an interactive right
 */
export function isInteractiveRight(rightType: RightType): boolean {
  return INTERACTIVE_RIGHTS.includes(rightType);
}

/**
 * Check if a right type requires the Read right
 * 
 * @param rightType - The right type to check
 * @returns True if the right requires Read to be enabled
 */
export function requiresRead(rightType: RightType): boolean {
  return RIGHTS_REQUIRING_READ.includes(rightType);
}
