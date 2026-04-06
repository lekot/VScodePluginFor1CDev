import { validateElementName } from '../utils/elementNameValidator';
import type { TreeNode } from '../models/treeNode';
import type { ValidationResult } from './propertiesWebviewTypes';

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

  // Validate element name if present (Name / name / Имя)
  const nameKeys = ['Name', 'name', 'Имя'];
  for (const key of nameKeys) {
    if (key in properties) {
      const raw = properties[key];
      const nameStr = typeof raw === 'string' ? raw : raw != null ? String(raw) : '';
      const siblingNames = (currentNode.parent?.children ?? [])
        .map((c) => c.name)
        .filter((n) => n !== currentNode.name);
      const nameError = validateElementName(nameStr, siblingNames);
      if (nameError) {
        errors[key] = nameError;
      }
      break;
    }
  }

  for (const [name, value] of Object.entries(properties)) {
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

    // Required field validation
    if (isRequiredProperty(name)) {
      if (value === '' || value === null || value === undefined) {
        errors[name] = 'This field is required';
        continue;
      }
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

/**
 * Check if a property is required
 */
function isRequiredProperty(propertyName: string): boolean {
  // Common required properties in 1C metadata
  const requiredProperties = ['name', 'Name', 'Имя'];
  return requiredProperties.includes(propertyName);
}
