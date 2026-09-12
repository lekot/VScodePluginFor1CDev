/**
 * BSL Query Extractor.
 * Extracts SDBL query text, range, and metadata from BSL source code.
 */

export interface ExtractedQueryInfo {
  rawBslText: string;
  sdblText: string;
  replaceRange: {
    startOffset: number;
    endOffset: number;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  isNewQuery: boolean;
  variableName?: string; // e.g. "Запрос" if detected from `Запрос.Текст = ...`
}

export interface BslLiteralSpan {
  start: number;
  end: number;
  rawText: string;
}

const QUERY_KEYWORDS_REGEX =
  /(?:^|[^\p{L}\p{N}_])(ВЫБРАТЬ|SELECT|УНИЧТОЖИТЬ|DROP)(?=[^\p{L}\p{N}_]|$)/iu;

/**
 * Checks if the text contains query language keywords (SELECT, DROP, etc.).
 */
export function hasQueryKeywords(text: string): boolean {
  return QUERY_KEYWORDS_REGEX.test(text);
}

/**
 * Converts a 0-based character offset into 1-based line and column numbers.
 */
export function offsetToPosition(
  text: string,
  offset: number
): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const clamped = Math.max(0, Math.min(offset, text.length));

  for (let i = 0; i < clamped; i++) {
    const ch = text[i];
    if (ch === '\r') {
      if (text[i + 1] === '\n') {
        i++;
      }
      line++;
      column = 1;
    } else if (ch === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }

  return { line, column };
}

/**
 * Cleans a BSL string literal into pure SDBL text:
 * - Strips outer quotes
 * - Removes leading continuation pipes '|' (and indentation before '|')
 * - Unescapes double quotes '""' -> '"'
 */
export function cleanBslLiteral(rawLiteral: string): string {
  let text = rawLiteral.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    text = text.slice(1, -1);
  }

  const lines = text.split(/\r?\n/);
  const cleanedLines = lines.map((line) => line.replace(/^[ \t]*\|/, ''));
  return cleanedLines.join('\n').replace(/""/g, '"');
}

/**
 * Finds all BSL string literals in document text, respecting line comments.
 */
export function findBslLiterals(text: string): BslLiteralSpan[] {
  const spans: BslLiteralSpan[] = [];
  const len = text.length;
  let i = 0;

  while (i < len) {
    const ch = text[i];

    // Single line comment: // ...
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < len && text[i] !== '\r' && text[i] !== '\n') {
        i++;
      }
      continue;
    }

    // String literal start: "
    if (ch === '"') {
      const start = i;
      i++; // consume opening "

      while (i < len) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            // Escaped double quote
            i += 2;
          } else {
            // Closing quote
            i++; // consume closing "
            break;
          }
        } else if (text[i] === '\r' || text[i] === '\n') {
          if (text[i] === '\r' && text[i + 1] === '\n') {
            i += 2;
          } else {
            i++;
          }

          // Check if continuation line starts with '|'
          let temp = i;
          while (temp < len && (text[temp] === ' ' || text[temp] === '\t')) {
            temp++;
          }

          if (temp < len && text[temp] === '|') {
            i = temp + 1; // move past '|'
          } else {
            // Unclosed string literal terminated at newline
            break;
          }
        } else {
          i++;
        }
      }

      const end = i;
      spans.push({
        start,
        end,
        rawText: text.slice(start, end),
      });
      continue;
    }

    i++;
  }

  return spans;
}

/**
 * Detects the query variable name from the code preceding the query literal.
 * Supports:
 * - Variable.Текст = or Variable.Text =
 * - Variable = Новый Запрос; or Variable = New Query;
 * - Variable = Новый Запрос(...)
 */
export function detectVariableName(prefix: string): string | undefined {
  const trimmed = prefix.trimEnd();

  // Pattern 1: Variable.Текст = or Variable.Text =
  const textMatch = trimmed.match(
    /(?:^|[^\p{L}\p{N}_])([\p{L}_][\p{L}\p{N}_]*)\s*\.\s*(?:Текст|Text)\s*=\s*$/iu
  );
  if (textMatch) {
    return textMatch[1];
  }

  // Pattern 2: Variable = Новый Запрос(...) or Variable = New Query(...)
  const newQueryMatches = Array.from(
    trimmed.matchAll(
      /(?:^|[^\p{L}\p{N}_])([\p{L}_][\p{L}\p{N}_]*)\s*=\s*(?:Новый\s+Запрос|New\s+Query)/giu
    )
  );
  if (newQueryMatches.length > 0) {
    return newQueryMatches[newQueryMatches.length - 1][1];
  }

  return undefined;
}

/**
 * Extracts BSL query information from document text based on cursor or selection.
 */
export function extractBslQuery(
  documentText: string,
  cursorOffset: number,
  selectionRange?: { start: number; end: number }
): ExtractedQueryInfo {
  const docLen = documentText.length;
  const clampedCursor = Math.max(0, Math.min(cursorOffset, docLen));

  // 1. If selection is provided and contains text
  if (selectionRange && selectionRange.start !== selectionRange.end) {
    const selStart = Math.max(0, Math.min(selectionRange.start, selectionRange.end));
    const selEnd = Math.min(docLen, Math.max(selectionRange.start, selectionRange.end));
    const rawSelected = documentText.slice(selStart, selEnd);
    const trimmed = rawSelected.trim();

    if (trimmed.length > 0) {
      const isLiteral = trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2;
      const isSdblDirect = /^(?:ВЫБРАТЬ|SELECT|УНИЧТОЖИТЬ|DROP)\b/iu.test(trimmed);

      if (isLiteral || isSdblDirect || hasQueryKeywords(trimmed)) {
        const sdblText = isLiteral || trimmed.includes('|')
          ? cleanBslLiteral(rawSelected)
          : trimmed;

        if (hasQueryKeywords(sdblText)) {
          const startPos = offsetToPosition(documentText, selStart);
          const endPos = offsetToPosition(documentText, selEnd);
          const varName = detectVariableName(documentText.slice(0, selStart));

          return {
            rawBslText: rawSelected,
            sdblText,
            replaceRange: {
              startOffset: selStart,
              endOffset: selEnd,
              startLine: startPos.line,
              startColumn: startPos.column,
              endLine: endPos.line,
              endColumn: endPos.column,
            },
            isNewQuery: false,
            ...(varName ? { variableName: varName } : {}),
          };
        }
      }
    }
  }

  // 2. Check cursor inside BSL string literals
  const literals = findBslLiterals(documentText);
  const matchedLiteral = literals.find(
    (lit) => clampedCursor >= lit.start && clampedCursor <= lit.end
  );

  if (matchedLiteral && hasQueryKeywords(matchedLiteral.rawText)) {
    const sdblText = cleanBslLiteral(matchedLiteral.rawText);
    const startPos = offsetToPosition(documentText, matchedLiteral.start);
    const endPos = offsetToPosition(documentText, matchedLiteral.end);
    const varName = detectVariableName(documentText.slice(0, matchedLiteral.start));

    return {
      rawBslText: matchedLiteral.rawText,
      sdblText,
      replaceRange: {
        startOffset: matchedLiteral.start,
        endOffset: matchedLiteral.end,
        startLine: startPos.line,
        startColumn: startPos.column,
        endLine: endPos.line,
        endColumn: endPos.column,
      },
      isNewQuery: false,
      ...(varName ? { variableName: varName } : {}),
    };
  }

  // 3. Cursor on empty line or outside a query string literal
  const cursorPos = offsetToPosition(documentText, clampedCursor);
  return {
    rawBslText: '',
    sdblText: '',
    replaceRange: {
      startOffset: clampedCursor,
      endOffset: clampedCursor,
      startLine: cursorPos.line,
      startColumn: cursorPos.column,
      endLine: cursorPos.line,
      endColumn: cursorPos.column,
    },
    isNewQuery: true,
  };
}
