/**
 * Property keys whose values participate in metadata identity rather than generic XML value editing.
 * Keep this list surface-neutral so UI and Agent mutation admission cannot drift.
 */
const IDENTITY_SENSITIVE_PROPERTY_ALIASES = new Set(['name', 'имя']);

export const IDENTITY_PROPERTY_EDIT_ERROR =
  'Нельзя менять имя через общие свойства. Используйте команду «Переименовать элемент».';

export function isIdentitySensitiveMetadataProperty(propertyName: string): boolean {
  return IDENTITY_SENSITIVE_PROPERTY_ALIASES.has(propertyName.toLowerCase());
}

export function getIdentitySensitiveMetadataPropertyNames(
  properties: Record<string, unknown>,
): string[] {
  return Object.keys(properties).filter(isIdentitySensitiveMetadataProperty);
}
