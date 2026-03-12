/**
 * Shared XML property utilities for Designer and EDT parsers
 */

/**
 * Convert string boolean values ("true"/"false") to actual boolean primitives
 * @param properties Properties object that may contain string "false"/"true" values
 * @returns Properties object with string booleans converted to primitives
 */
export function convertStringBooleans(
  properties: Record<string, unknown>
): Record<string, unknown> {
  const converted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(properties)) {
    if (value === 'false') {
      converted[key] = false;
    } else if (value === 'true') {
      converted[key] = true;
    } else {
      converted[key] = value;
    }
  }

  return converted;
}
