/**
 * Rights validation logic for the Roles and Rights Editor
 * Validates right combinations and dependencies according to 1C rules
 */

import {
  RoleModel,
  ObjectRights,
  RightType,
  RIGHTS_REQUIRING_READ,
  INTERACTIVE_RIGHTS
} from './models';

/**
 * Result of a validation operation
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

/**
 * Validates rights assignments and detects conflicts
 */
export class RightsValidator {
  /**
   * Validate all rights in a RoleModel
   * 
   * @param roleModel - The role model to validate
   * @returns Validation result with any errors found
   * 
   * Requirements: 5.1
   */
  validateRights(roleModel: RoleModel): ValidationResult {
    const errors: string[] = [];

    // Validate each object's rights
    for (const [objectName, rights] of Object.entries(roleModel.rights)) {
      const objectErrors = this.validateObjectRights(objectName, rights);
      errors.push(...objectErrors);
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate rights for a single object
   * 
   * @param objectName - Full name of the object (e.g., "Catalog.Products")
   * @param rights - The rights to validate
   * @returns Array of validation error messages
   * 
   * Requirements: 5.1, 5.2, 5.3, 5.4
   */
  validateObjectRights(objectName: string, rights: ObjectRights): string[] {
    const errors: string[] = [];

    // Check dependencies (Update/Delete require Read)
    const dependencyErrors = this.checkDependencies(objectName, rights);
    errors.push(...dependencyErrors);

    // Check interactive rights require base rights
    const combinationErrors = this.validateRightCombination(objectName, rights);
    errors.push(...combinationErrors);

    return errors;
  }

  /**
   * Check that right dependencies are satisfied
   * Update and Delete rights require Read right to be enabled
   * 
   * @param objectName - Full name of the object
   * @param rights - The rights to check
   * @returns Array of dependency violation error messages
   * 
   * Requirements: 5.2, 5.3
   */
  checkDependencies(objectName: string, rights: ObjectRights): string[] {
    const errors: string[] = [];

    // Check if Update or Delete are enabled without Read
    for (const rightType of RIGHTS_REQUIRING_READ) {
      if (rights[rightType] && !rights.read) {
        errors.push(
          `${objectName}: ${this.formatRightName(rightType)} right requires Read right to be enabled`
        );
      }
    }

    return errors;
  }

  /**
   * Validate that interactive rights have their corresponding base rights enabled
   * 
   * @param objectName - Full name of the object
   * @param rights - The rights to check
   * @returns Array of combination violation error messages
   * 
   * Requirements: 5.4
   */
  validateRightCombination(objectName: string, rights: ObjectRights): string[] {
    const errors: string[] = [];

    // Check each interactive right
    for (const interactiveRight of INTERACTIVE_RIGHTS) {
      if (rights[interactiveRight]) {
        const baseRight = this.getBaseRightForInteractive(interactiveRight);
        
        if (baseRight && !rights[baseRight]) {
          errors.push(
            `${objectName}: ${this.formatRightName(interactiveRight)} requires ${this.formatRightName(baseRight)} right to be enabled`
          );
        }
      }
    }

    return errors;
  }

  /**
   * Get the base right required for an interactive right
   * 
   * @param interactiveRight - The interactive right type
   * @returns The corresponding base right, or null if not applicable
   */
  private getBaseRightForInteractive(interactiveRight: RightType): RightType | null {
    // Map interactive rights to their base rights
    const mapping: { [key: string]: RightType } = {
      'interactiveInsert': 'insert',
      'interactiveDelete': 'delete',
      'interactiveClear': 'delete',
      'interactiveDeleteMarked': 'delete',
      'interactiveUndeleteMarked': 'delete',
      'interactiveDeletePredefinedData': 'delete',
      'interactiveSetDeletionMark': 'delete',
      'interactiveClearDeletionMark': 'delete',
      'interactiveDeleteMarkedPredefinedData': 'delete'
    };

    return mapping[interactiveRight] || null;
  }

  /**
   * Format a right type name for display in error messages
   * Converts camelCase to Title Case with spaces
   * 
   * @param rightType - The right type to format
   * @returns Formatted right name
   */
  private formatRightName(rightType: RightType): string {
    // Convert camelCase to Title Case
    // e.g., "interactiveDelete" -> "Interactive Delete"
    return rightType
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, str => str.toUpperCase())
      .trim();
  }
}
