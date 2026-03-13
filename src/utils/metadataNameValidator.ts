/**
 * Validates 1C metadata element names (identifier rules, uniqueness).
 */

const IDENTIFIER_REGEX = /^[a-zA-Z\u0400-\u04FF_][a-zA-Z0-9\u0400-\u04FF_]*$/;

/**
 * Validates metadata name: 1C identifier rules (letters, digits, underscore; must not start with digit).
 * @param name Candidate name
 * @param existingNames Optional list of sibling names for uniqueness check
 * @returns null if valid; otherwise error message string
 */
export function validateMetadataName(
  name: string,
  existingNames?: string[]
): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return 'Name cannot be empty.';
  }
  if (!IDENTIFIER_REGEX.test(trimmed)) {
    return 'Name must be a valid 1C identifier (letters, digits, underscore; cannot start with a digit).';
  }
  if (existingNames && existingNames.includes(trimmed)) {
    return `An element named "${trimmed}" already exists.`;
  }
  return null;
}
