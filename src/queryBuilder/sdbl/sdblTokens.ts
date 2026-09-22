/**
 * SDBL (1C 1C:Enterprise Query Language) Token Definitions.
 */

export enum TokenType {
  Keyword = 'Keyword',
  Identifier = 'Identifier',
  StringLiteral = 'StringLiteral',
  NumberLiteral = 'NumberLiteral',
  Parameter = 'Parameter',
  Symbol = 'Symbol',
  Operator = 'Operator',
  Comment = 'Comment',
  EOF = 'EOF',
}

export interface SdblToken {
  type: TokenType;
  value: string;
  raw: string;
  line: number;
  column: number;
  offset: number;
}

/**
 * Canonical representations for SDBL keywords (in standard uppercase English).
 */
export enum SdblKeyword {
  Select = 'SELECT',
  From = 'FROM',
  Where = 'WHERE',
  And = 'AND',
  Or = 'OR',
  Not = 'NOT',
  As = 'AS',
  Left = 'LEFT',
  Right = 'RIGHT',
  Full = 'FULL',
  Inner = 'INNER',
  Outer = 'OUTER',
  Join = 'JOIN',
  On = 'ON',
  By = 'BY',
  Group = 'GROUP',
  Order = 'ORDER',
  Totals = 'TOTALS',
  Union = 'UNION',
  All = 'ALL',
  Allowed = 'ALLOWED',
  Distinct = 'DISTINCT',
  Top = 'TOP',
  ForUpdate = 'FOR UPDATE',
  Into = 'INTO',
  Drop = 'DROP',
  Index = 'INDEX',
  Having = 'HAVING',
  Autoorder = 'AUTOORDER',
  // Aggregate functions
  Sum = 'SUM',
  Count = 'COUNT',
  Max = 'MAX',
  Min = 'MIN',
  Avg = 'AVG',
  // Conditional and logic
  Case = 'CASE',
  When = 'WHEN',
  Then = 'THEN',
  Else = 'ELSE',
  End = 'END',
  Between = 'BETWEEN',
  In = 'IN',
  Is = 'IS',
  Null = 'NULL',
  True = 'TRUE',
  False = 'FALSE',
  Undefined = 'UNDEFINED',
  Like = 'LIKE',
  Escape = 'ESCAPE',
  Refs = 'REFS',
  Cast = 'CAST',
  Asc = 'ASC',
  Desc = 'DESC',
  Hierarchy = 'HIERARCHY',
  Only = 'ONLY',
}

/**
 * Mapping from bilingual keywords (uppercase Russian or English) to their canonical representation.
 */
export const KEYWORD_CANONICAL_MAP: Readonly<Record<string, SdblKeyword>> = {
  // Russian primary keywords
  ВЫБРАТЬ: SdblKeyword.Select,
  ИЗ: SdblKeyword.From,
  ГДЕ: SdblKeyword.Where,
  И: SdblKeyword.And,
  ИЛИ: SdblKeyword.Or,
  НЕ: SdblKeyword.Not,
  КАК: SdblKeyword.As,
  ЛЕВОЕ: SdblKeyword.Left,
  ПРАВОЕ: SdblKeyword.Right,
  ПОЛНОЕ: SdblKeyword.Full,
  ВНУТРЕННЕЕ: SdblKeyword.Inner,
  ВНЕШНЕЕ: SdblKeyword.Outer,
  СОЕДИНЕНИЕ: SdblKeyword.Join,
  ПО: SdblKeyword.On,
  СГРУППИРОВАТЬ: SdblKeyword.Group,
  УПОРЯДОЧИТЬ: SdblKeyword.Order,
  ИТОГИ: SdblKeyword.Totals,
  ОБЪЕДИНИТЬ: SdblKeyword.Union,
  ВСЕ: SdblKeyword.All,
  РАЗРЕШЕННЫЕ: SdblKeyword.Allowed,
  РАЗЛИЧНЫЕ: SdblKeyword.Distinct,
  ПЕРВЫЕ: SdblKeyword.Top,
  'ДЛЯ ИЗМЕНЕНИЯ': SdblKeyword.ForUpdate,
  ПОМЕСТИТЬ: SdblKeyword.Into,
  УНИЧТОЖИТЬ: SdblKeyword.Drop,
  ИНДЕКСИРОВАТЬ: SdblKeyword.Index,
  ИМЕЮЩИЕ: SdblKeyword.Having,
  АВТОУПОРЯДОЧИВАНИЕ: SdblKeyword.Autoorder,

  // Russian aggregate functions
  СУММА: SdblKeyword.Sum,
  КОЛИЧЕСТВО: SdblKeyword.Count,
  МАКСИМУМ: SdblKeyword.Max,
  МИНИМУМ: SdblKeyword.Min,
  СРЕДНЕЕ: SdblKeyword.Avg,

  // Russian conditionals, literals and operators
  ВЫБОР: SdblKeyword.Case,
  КОГДА: SdblKeyword.When,
  ТОГДА: SdblKeyword.Then,
  ИНАЧЕ: SdblKeyword.Else,
  КОНЕЦ: SdblKeyword.End,
  МЕЖДУ: SdblKeyword.Between,
  В: SdblKeyword.In,
  ЕСТЬ: SdblKeyword.Is,
  ИСТИНА: SdblKeyword.True,
  ЛОЖЬ: SdblKeyword.False,
  НЕОПРЕДЕЛЕНО: SdblKeyword.Undefined,
  ПОДОБНО: SdblKeyword.Like,
  СПЕЦСИМВОЛ: SdblKeyword.Escape,
  ССЫЛКА: SdblKeyword.Refs,
  ВЫРАЗИТЬ: SdblKeyword.Cast,
  ВОЗР: SdblKeyword.Asc,
  УБЫВ: SdblKeyword.Desc,
  ИЕРАРХИЯ: SdblKeyword.Hierarchy,
  ИЕРАРХИИ: SdblKeyword.Hierarchy,
  ТОЛЬКО: SdblKeyword.Only,

  // English primary keywords
  SELECT: SdblKeyword.Select,
  FROM: SdblKeyword.From,
  WHERE: SdblKeyword.Where,
  AND: SdblKeyword.And,
  OR: SdblKeyword.Or,
  NOT: SdblKeyword.Not,
  AS: SdblKeyword.As,
  LEFT: SdblKeyword.Left,
  RIGHT: SdblKeyword.Right,
  FULL: SdblKeyword.Full,
  INNER: SdblKeyword.Inner,
  OUTER: SdblKeyword.Outer,
  JOIN: SdblKeyword.Join,
  ON: SdblKeyword.On,
  BY: SdblKeyword.By,
  GROUP: SdblKeyword.Group,
  ORDER: SdblKeyword.Order,
  TOTALS: SdblKeyword.Totals,
  UNION: SdblKeyword.Union,
  ALL: SdblKeyword.All,
  ALLOWED: SdblKeyword.Allowed,
  DISTINCT: SdblKeyword.Distinct,
  TOP: SdblKeyword.Top,
  'FOR UPDATE': SdblKeyword.ForUpdate,
  INTO: SdblKeyword.Into,
  PUT: SdblKeyword.Into,
  DROP: SdblKeyword.Drop,
  INDEX: SdblKeyword.Index,
  HAVING: SdblKeyword.Having,
  AUTOORDER: SdblKeyword.Autoorder,

  // English aggregate functions
  SUM: SdblKeyword.Sum,
  COUNT: SdblKeyword.Count,
  MAX: SdblKeyword.Max,
  MIN: SdblKeyword.Min,
  AVG: SdblKeyword.Avg,

  // English conditionals, literals and operators
  CASE: SdblKeyword.Case,
  WHEN: SdblKeyword.When,
  THEN: SdblKeyword.Then,
  ELSE: SdblKeyword.Else,
  END: SdblKeyword.End,
  BETWEEN: SdblKeyword.Between,
  IN: SdblKeyword.In,
  IS: SdblKeyword.Is,
  NULL: SdblKeyword.Null,
  TRUE: SdblKeyword.True,
  FALSE: SdblKeyword.False,
  UNDEFINED: SdblKeyword.Undefined,
  LIKE: SdblKeyword.Like,
  ESCAPE: SdblKeyword.Escape,
  REFS: SdblKeyword.Refs,
  CAST: SdblKeyword.Cast,
  ASC: SdblKeyword.Asc,
  DESC: SdblKeyword.Desc,
  HIERARCHY: SdblKeyword.Hierarchy,
  ONLY: SdblKeyword.Only,
};

/**
 * Mapping from canonical SdblKeyword to primary Russian spelling.
 */
export const RUSSIAN_KEYWORD_MAP: Readonly<Record<SdblKeyword, string>> = {
  [SdblKeyword.Select]: 'ВЫБРАТЬ',
  [SdblKeyword.From]: 'ИЗ',
  [SdblKeyword.Where]: 'ГДЕ',
  [SdblKeyword.And]: 'И',
  [SdblKeyword.Or]: 'ИЛИ',
  [SdblKeyword.Not]: 'НЕ',
  [SdblKeyword.As]: 'КАК',
  [SdblKeyword.Left]: 'ЛЕВОЕ',
  [SdblKeyword.Right]: 'ПРАВОЕ',
  [SdblKeyword.Full]: 'ПОЛНОЕ',
  [SdblKeyword.Inner]: 'ВНУТРЕННЕЕ',
  [SdblKeyword.Outer]: 'ВНЕШНЕЕ',
  [SdblKeyword.Join]: 'СОЕДИНЕНИЕ',
  [SdblKeyword.On]: 'ПО',
  [SdblKeyword.By]: 'ПО',
  [SdblKeyword.Group]: 'СГРУППИРОВАТЬ',
  [SdblKeyword.Order]: 'УПОРЯДОЧИТЬ',
  [SdblKeyword.Totals]: 'ИТОГИ',
  [SdblKeyword.Union]: 'ОБЪЕДИНИТЬ',
  [SdblKeyword.All]: 'ВСЕ',
  [SdblKeyword.Allowed]: 'РАЗРЕШЕННЫЕ',
  [SdblKeyword.Distinct]: 'РАЗЛИЧНЫЕ',
  [SdblKeyword.Top]: 'ПЕРВЫЕ',
  [SdblKeyword.ForUpdate]: 'ДЛЯ ИЗМЕНЕНИЯ',
  [SdblKeyword.Into]: 'ПОМЕСТИТЬ',
  [SdblKeyword.Drop]: 'УНИЧТОЖИТЬ',
  [SdblKeyword.Index]: 'ИНДЕКСИРОВАТЬ',
  [SdblKeyword.Having]: 'ИМЕЮЩИЕ',
  [SdblKeyword.Autoorder]: 'АВТОУПОРЯДОЧИВАНИЕ',
  [SdblKeyword.Sum]: 'СУММА',
  [SdblKeyword.Count]: 'КОЛИЧЕСТВО',
  [SdblKeyword.Max]: 'МАКСИМУМ',
  [SdblKeyword.Min]: 'МИНИМУМ',
  [SdblKeyword.Avg]: 'СРЕДНЕЕ',
  [SdblKeyword.Case]: 'ВЫБОР',
  [SdblKeyword.When]: 'КОГДА',
  [SdblKeyword.Then]: 'ТОГДА',
  [SdblKeyword.Else]: 'ИНАЧЕ',
  [SdblKeyword.End]: 'КОНЕЦ',
  [SdblKeyword.Between]: 'МЕЖДУ',
  [SdblKeyword.In]: 'В',
  [SdblKeyword.Is]: 'ЕСТЬ',
  [SdblKeyword.Null]: 'NULL',
  [SdblKeyword.True]: 'ИСТИНА',
  [SdblKeyword.False]: 'ЛОЖЬ',
  [SdblKeyword.Undefined]: 'НЕОПРЕДЕЛЕНО',
  [SdblKeyword.Like]: 'ПОДОБНО',
  [SdblKeyword.Escape]: 'СПЕЦСИМВОЛ',
  [SdblKeyword.Refs]: 'ССЫЛКА',
  [SdblKeyword.Cast]: 'ВЫРАЗИТЬ',
  [SdblKeyword.Asc]: 'ВОЗР',
  [SdblKeyword.Desc]: 'УБЫВ',
  [SdblKeyword.Hierarchy]: 'ИЕРАРХИЯ',
  [SdblKeyword.Only]: 'ТОЛЬКО',
};

/**
 * Returns canonical keyword for a given word or compound phrase (case-insensitive).
 */
export function getCanonicalKeyword(wordOrPhrase: string): SdblKeyword | undefined {
  return KEYWORD_CANONICAL_MAP[wordOrPhrase.toUpperCase().trim()];
}

/**
 * Checks if a word or phrase is a known keyword.
 */
export function isKeyword(wordOrPhrase: string): boolean {
  return wordOrPhrase.toUpperCase().trim() in KEYWORD_CANONICAL_MAP;
}

/**
 * Returns primary Russian keyword representation for a given canonical keyword.
 */
export function getRussianKeyword(keyword: SdblKeyword): string {
  return RUSSIAN_KEYWORD_MAP[keyword] || keyword;
}

/**
 * Returns canonical English representation for a given canonical keyword.
 */
export function getEnglishKeyword(keyword: SdblKeyword): string {
  return keyword;
}
