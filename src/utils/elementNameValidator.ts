/**
 * Validates 1C metadata element names (identifiers).
 * Returns error message or null if valid.
 */
const VALID_NAME_REGEX = /^[\p{L}\p{N}_]+$/u;

export function validateElementName(
  name: string,
  siblingNames: string[]
): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return 'Имя не может быть пустым.';
  }
  if (!VALID_NAME_REGEX.test(trimmed)) {
    return 'Имя может содержать только буквы, цифры и подчёркивание.';
  }
  const lowerSiblings = siblingNames.map((s) => s.toLowerCase());
  if (lowerSiblings.includes(trimmed.toLowerCase())) {
    return `Элемент с именем «${trimmed}» уже существует.`;
  }
  return null;
}
