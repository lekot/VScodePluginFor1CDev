import type { FormAttribute } from './formModel';

/**
 * Return the default preview width, in character cells, for a form item bound
 * to DataPath. The function is embedded into the isolated webview, so it must
 * stay self-contained and free of module or browser dependencies.
 */
export function getPreviewFieldCharacterWidth(dataPath: string, attributes: readonly FormAttribute[]): number {
  const path = String(dataPath || '').trim().replace(/^\.+|\.+$/g, '');
  if (!path || !Array.isArray(attributes)) {return 15;}

  const normalizedPath = path.toLowerCase();
  const pathSegments = normalizedPath.split('.').filter(Boolean);
  const attribute = [...attributes]
    .filter((item) => item && typeof item.name === 'string' && item.name.trim() !== '')
    .sort((left, right) => right.name.length - left.name.length)
    .find((item) => {
      const name = item.name.trim().toLowerCase();
      return normalizedPath === name || normalizedPath.endsWith(`.${name}`) || pathSegments[pathSegments.length - 1] === name;
    });
  if (!attribute) {return 15;}

  const values: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const record = (key: string, value: unknown): void => {
    if (value == null || typeof value === 'object') {return;}
    const local = key.includes(':') ? key.split(':').pop()! : key;
    const normalized = local.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normalized || normalized.startsWith('@')) {return;}
    (values[normalized] ??= []).push(String(value).trim());
  };
  const visit = (value: unknown, inheritedKey = ''): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {visit(entry, inheritedKey);}
      return;
    }
    if (value == null || typeof value !== 'object') {
      record(inheritedKey, value);
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (key === ':@' || key.startsWith('@')) {continue;}
      if (key === '#text') {record(inheritedKey, nested);}
      else {visit(nested, key);}
    }
  };
  visit(attribute.properties['Type'], 'Type');

  const type = (values['type'] ?? []).join(' ').toLowerCase();
  const dateFractions = (values['datefractions'] ?? []).join(' ').toLowerCase().replace(/[^a-zа-я0-9]/g, '');
  if (type.includes('boolean') || type.includes('булев')) {return 10;}
  if (dateFractions.includes('datetime')) {return 22;}
  if (dateFractions.includes('time')) {return 8;}
  if (dateFractions.includes('date')) {return 10;}
  if (type.includes('datetime')) {return 22;}
  if (/(?:^|[^a-z])time(?:$|[^a-z])/.test(type) || type.includes('время')) {return 8;}
  if (/(?:^|[^a-z])date(?:$|[^a-z])/.test(type) || type.includes('дата')) {return 10;}
  if (/(?:catalog|document|enum|chartof|businessprocess|task)[a-z]*ref|reference|ссылка/.test(type)) {return 15;}

  if (type.includes('decimal') || type.includes('integer') || type.includes('number') || type.includes('число')) {
    const digits = Number.parseInt((values['digits'] ?? [])[0] ?? '', 10);
    const fractionDigits = Number.parseInt((values['fractiondigits'] ?? [])[0] ?? '', 10);
    if (!Number.isFinite(digits) || digits <= 0) {return 15;}
    const fraction = Number.isFinite(fractionDigits) ? Math.max(0, Math.min(digits, fractionDigits)) : 0;
    const integerDigits = Math.max(1, digits - fraction);
    const groupingSeparators = Math.floor((integerDigits - 1) / 3);
    const decimalSeparator = fraction > 0 ? 1 : 0;
    const sign = (values['allowedsign'] ?? []).join(' ').toLowerCase().includes('nonnegative') ? 0 : 1;
    const renderedCharacters = integerDigits + groupingSeparators + fraction + decimalSeparator + sign;
    return Math.max(4, Math.ceil(renderedCharacters * 5.4 / 8));
  }
  return 15;
}
