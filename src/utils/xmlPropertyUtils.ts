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

/**
 * Extract localized string content from v8:item structure or string.
 */
export function extractV8String(val: unknown): string | undefined {
  if (typeof val === 'string') {
    const trimmed = val.trim();
    return trimmed || undefined;
  }
  if (!val || typeof val !== 'object') {
    return undefined;
  }
  const obj = val as Record<string, unknown>;
  const rawItems = obj['v8:item'] ?? obj.item;
  if (rawItems !== undefined) {
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];
    let ruContent: string | undefined;
    let anyContent: string | undefined;
    for (const it of items) {
      if (typeof it === 'string' && it.trim()) {
        anyContent = anyContent ?? it.trim();
      } else if (it && typeof it === 'object') {
        const itemObj = it as Record<string, unknown>;
        const lang = String(itemObj['v8:lang'] ?? itemObj.lang ?? '');
        const content = itemObj['v8:content'] ?? itemObj.content ?? itemObj['#text'];
        if (typeof content === 'string' && content.trim()) {
          const trimmed = content.trim();
          if (lang.toLowerCase() === 'ru') {
            ruContent = trimmed;
          }
          if (!anyContent) {
            anyContent = trimmed;
          }
        }
      }
    }
    if (ruContent) {
      return ruContent;
    }
    if (anyContent) {
      return anyContent;
    }
  }
  if (typeof obj['#text'] === 'string' && obj['#text'].trim()) {
    return obj['#text'].trim();
  }
  if (typeof obj.ru === 'string' && obj.ru.trim()) {
    return obj.ru.trim();
  }
  if (typeof obj.content === 'string' && obj.content.trim()) {
    return obj.content.trim();
  }
  return undefined;
}

