import type { TreeNode } from '../models/treeNode';
import type { ValidationResult } from './propertiesWebviewTypes';
import {
  getIdentitySensitiveMetadataPropertyNames,
  IDENTITY_PROPERTY_EDIT_ERROR,
} from '../domain/metadataPropertyClassifier';

/**
 * Validate property values for a given node.
 * Pure function — no side effects, no dependencies on class state.
 */
export function validateProperties(
  properties: Record<string, unknown>,
  currentNode: TreeNode | undefined
): ValidationResult {
  const errors: Record<string, string> = {};

  if (!currentNode) {
    return { valid: false, errors: { _general: 'No element selected' } };
  }

  const identityProperties = getIdentitySensitiveMetadataPropertyNames(properties);
  for (const propertyName of identityProperties) {
    errors[propertyName] = IDENTITY_PROPERTY_EDIT_ERROR;
  }

  for (const [name, value] of Object.entries(properties)) {
    if (identityProperties.includes(name)) {
      continue;
    }

    // Get expected type from original properties
    const expectedType = getExpectedType(name, currentNode);

    // Type validation
    const actualType = typeof value;

    if (expectedType === 'number' && actualType !== 'number') {
      if (actualType === 'string' && value !== '') {
        // Try to parse as number
        const parsed = parseFloat(value as string);
        if (isNaN(parsed)) {
          errors[name] = 'Must be a number';
          continue;
        }
      } else if (value !== null && value !== undefined && value !== '') {
        errors[name] = 'Must be a number';
        continue;
      }
    }

    if (expectedType === 'boolean' && actualType !== 'boolean') {
      errors[name] = 'Must be a boolean';
      continue;
    }

  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

/**
 * Get expected type for a property based on original value in the node
 */
function getExpectedType(propertyName: string, currentNode: TreeNode | undefined): string {
  if (!currentNode) {
    return 'unknown';
  }
  const originalValue = (currentNode.properties as Record<string, unknown>)[propertyName];
  return typeof originalValue;
}
