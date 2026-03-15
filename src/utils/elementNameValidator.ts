/**
 * Validates 1C metadata element names (identifiers).
 * Returns error message or null if valid.
 */
const VALID_NAME_REGEX = /^[\p{L}\p{N}_]+$/u;
const MAX_NAME_LENGTH = 80; // 1C platform limit
const DIGIT_START_REGEX = /^\d/;

// Reserved keywords in 1C that cannot be used as identifiers
const RESERVED_KEYWORDS = new Set([
  'Procedure', 'EndProcedure', 'Function', 'EndFunction',
  'If', 'Then', 'ElsIf', 'Else', 'EndIf',
  'For', 'To', 'Each', 'In', 'Do', 'EndDo',
  'While', 'EndWhile', 'Try', 'Except', 'EndTry',
  'Raise', 'Return', 'Continue', 'Break',
  'And', 'Or', 'Not', 'True', 'False', 'Undefined', 'Null',
  'New', 'Execute', 'Eval', 'Export', 'Var', 'Val',
  // Russian equivalents
  'Процедура', 'КонецПроцедуры', 'Функция', 'КонецФункции',
  'Если', 'Тогда', 'ИначеЕсли', 'Иначе', 'КонецЕсли',
  'Для', 'По', 'Каждого', 'Из', 'Цикл', 'КонецЦикла',
  'Пока', 'КонецПока', 'Попытка', 'Исключение', 'КонецПопытки',
  'ВызватьИсключение', 'Возврат', 'Продолжить', 'Прервать',
  'И', 'Или', 'Не', 'Истина', 'Ложь', 'Неопределено',
  'Новый', 'Выполнить', 'Вычислить', 'Экспорт', 'Перем', 'Знач',
]);

export function validateElementName(
  name: string,
  siblingNames: string[]
): string | null {
  const trimmed = name.trim();
  
  // Check for empty name
  if (!trimmed) {
    return 'Имя не может быть пустым.';
  }
  
  // Check maximum length (1C platform limit)
  if (trimmed.length > MAX_NAME_LENGTH) {
    return `Имя не может быть длиннее ${MAX_NAME_LENGTH} символов.`;
  }
  
  // Check if name starts with a digit (not allowed in 1C)
  if (DIGIT_START_REGEX.test(trimmed)) {
    return 'Имя не может начинаться с цифры.';
  }
  
  // Check for valid characters (letters, digits, underscore)
  if (!VALID_NAME_REGEX.test(trimmed)) {
    return 'Имя может содержать только буквы, цифры и подчёркивание.';
  }
  
  // Check for reserved keywords (case-insensitive)
  if (RESERVED_KEYWORDS.has(trimmed) || RESERVED_KEYWORDS.has(trimmed.toLowerCase())) {
    return `«${trimmed}» является зарезервированным словом и не может использоваться как имя.`;
  }
  
  // Check for duplicate sibling names (case-insensitive)
  const lowerSiblings = siblingNames.map((s) => s.toLowerCase());
  if (lowerSiblings.includes(trimmed.toLowerCase())) {
    return `Элемент с именем «${trimmed}» уже существует.`;
  }
  
  return null;
}
