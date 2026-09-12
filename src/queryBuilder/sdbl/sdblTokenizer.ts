import {
  TokenType,
  SdblToken,
  SdblKeyword,
  getCanonicalKeyword,
} from './sdblTokens';

export interface TokenizeOptions {
  includeEof?: boolean;
  includeComments?: boolean;
}

const IDENT_START_RE = /^[A-Za-zА-Яа-яЁё_]$/;
const IDENT_PART_RE = /^[A-Za-zА-Яа-яЁё0-9_]$/;

/**
 * Tokenizes SDBL (1C Query Language) source text into a stream of tokens.
 */
export function tokenizeSdbl(text: string, options?: TokenizeOptions): SdblToken[] {
  const includeEof = options?.includeEof === true;
  const includeComments = options?.includeComments !== false;

  const tokens: SdblToken[] = [];
  const len = text.length;
  let offset = 0;
  let line = 1;
  let column = 1;

  function peek(n = 0): string {
    const idx = offset + n;
    return idx < len ? text[idx] : '';
  }

  function advance(): string {
    const char = text[offset++];
    if (char === '\r') {
      if (offset < len && text[offset] === '\n') {
        offset++;
      }
      line++;
      column = 1;
    } else if (char === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
    return char;
  }

  function isWhitespace(ch: string): boolean {
    return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
  }

  function isDigit(ch: string): boolean {
    return ch >= '0' && ch <= '9';
  }

  while (offset < len) {
    const ch = peek();

    // 1. Skip whitespace
    if (isWhitespace(ch)) {
      advance();
      continue;
    }

    const startOffset = offset;
    const startLine = line;
    const startColumn = column;

    // 2. Comments (// ...)
    if (ch === '/' && peek(1) === '/') {
      advance(); // first /
      advance(); // second /
      const commentContentStart = offset;

      while (offset < len && peek() !== '\r' && peek() !== '\n') {
        advance();
      }

      const raw = text.slice(startOffset, offset);
      const value = text.slice(commentContentStart, offset);

      if (includeComments) {
        tokens.push({
          type: TokenType.Comment,
          value,
          raw,
          line: startLine,
          column: startColumn,
          offset: startOffset,
        });
      }
      continue;
    }

    // 3. String literals ("...")
    if (ch === '"') {
      advance(); // consume opening quote
      let value = '';

      while (offset < len) {
        const nextChar = peek();
        if (nextChar === '"') {
          if (peek(1) === '"') {
            // Escaped quote ("")
            advance();
            advance();
            value += '"';
          } else {
            // Closing quote
            advance();
            break;
          }
        } else {
          value += advance();
        }
      }

      const raw = text.slice(startOffset, offset);
      tokens.push({
        type: TokenType.StringLiteral,
        value,
        raw,
        line: startLine,
        column: startColumn,
        offset: startOffset,
      });
      continue;
    }

    // 4. Query parameters (&Parameter)
    if (ch === '&') {
      if (IDENT_START_RE.test(peek(1))) {
        advance(); // consume '&'
        const paramNameStart = offset;
        while (offset < len && IDENT_PART_RE.test(peek())) {
          advance();
        }
        const raw = text.slice(startOffset, offset);
        const value = text.slice(paramNameStart, offset);
        tokens.push({
          type: TokenType.Parameter,
          value,
          raw,
          line: startLine,
          column: startColumn,
          offset: startOffset,
        });
        continue;
      }
      // Lone '&' fallback
      const op = advance();
      tokens.push({
        type: TokenType.Operator,
        value: op,
        raw: op,
        line: startLine,
        column: startColumn,
        offset: startOffset,
      });
      continue;
    }

    // 5. Number literals (123, 123.45)
    if (isDigit(ch)) {
      while (offset < len && isDigit(peek())) {
        advance();
      }

      // Check for decimal part: must be '.' followed by at least one digit
      if (peek() === '.' && isDigit(peek(1))) {
        advance(); // consume '.'
        while (offset < len && isDigit(peek())) {
          advance();
        }
      }

      const raw = text.slice(startOffset, offset);
      tokens.push({
        type: TokenType.NumberLiteral,
        value: raw,
        raw,
        line: startLine,
        column: startColumn,
        offset: startOffset,
      });
      continue;
    }

    // 6. Identifiers and Keywords
    if (IDENT_START_RE.test(ch)) {
      while (offset < len && IDENT_PART_RE.test(peek())) {
        advance();
      }

      const firstWord = text.slice(startOffset, offset);
      const upperFirstWord = firstWord.toUpperCase();

      // Check compound keyword "ДЛЯ ИЗМЕНЕНИЯ"
      if (upperFirstWord === 'ДЛЯ') {
        const savedOffset = offset;
        const savedLine = line;
        const savedColumn = column;

        while (offset < len && isWhitespace(peek())) {
          advance();
        }

        if (offset < len && IDENT_START_RE.test(peek())) {
          const secondStart = offset;
          while (offset < len && IDENT_PART_RE.test(peek())) {
            advance();
          }
          const secondWord = text.slice(secondStart, offset).toUpperCase();
          if (secondWord === 'ИЗМЕНЕНИЯ') {
            const raw = text.slice(startOffset, offset);
            tokens.push({
              type: TokenType.Keyword,
              value: SdblKeyword.ForUpdate,
              raw,
              line: startLine,
              column: startColumn,
              offset: startOffset,
            });
            continue;
          }
        }

        // Backtrack if not matched
        offset = savedOffset;
        line = savedLine;
        column = savedColumn;
      }

      // Check compound keyword "FOR UPDATE"
      if (upperFirstWord === 'FOR') {
        const savedOffset = offset;
        const savedLine = line;
        const savedColumn = column;

        while (offset < len && isWhitespace(peek())) {
          advance();
        }

        if (offset < len && IDENT_START_RE.test(peek())) {
          const secondStart = offset;
          while (offset < len && IDENT_PART_RE.test(peek())) {
            advance();
          }
          const secondWord = text.slice(secondStart, offset).toUpperCase();
          if (secondWord === 'UPDATE') {
            const raw = text.slice(startOffset, offset);
            tokens.push({
              type: TokenType.Keyword,
              value: SdblKeyword.ForUpdate,
              raw,
              line: startLine,
              column: startColumn,
              offset: startOffset,
            });
            continue;
          }
        }

        // Backtrack if not matched
        offset = savedOffset;
        line = savedLine;
        column = savedColumn;
      }

      const canonical = getCanonicalKeyword(upperFirstWord);
      if (canonical) {
        tokens.push({
          type: TokenType.Keyword,
          value: canonical,
          raw: firstWord,
          line: startLine,
          column: startColumn,
          offset: startOffset,
        });
      } else {
        tokens.push({
          type: TokenType.Identifier,
          value: firstWord,
          raw: firstWord,
          line: startLine,
          column: startColumn,
          offset: startOffset,
        });
      }
      continue;
    }

    // 7. Multi-character comparison operators (<>, <=, >=, !=)
    if (ch === '<') {
      advance();
      if (peek() === '>') {
        advance();
        tokens.push({
          type: TokenType.Operator,
          value: '<>',
          raw: '<>',
          line: startLine,
          column: startColumn,
          offset: startOffset,
        });
        continue;
      }
      if (peek() === '=') {
        advance();
        tokens.push({
          type: TokenType.Operator,
          value: '<=',
          raw: '<=',
          line: startLine,
          column: startColumn,
          offset: startOffset,
        });
        continue;
      }
      tokens.push({
        type: TokenType.Operator,
        value: '<',
        raw: '<',
        line: startLine,
        column: startColumn,
        offset: startOffset,
      });
      continue;
    }

    if (ch === '>') {
      advance();
      if (peek() === '=') {
        advance();
        tokens.push({
          type: TokenType.Operator,
          value: '>=',
          raw: '>=',
          line: startLine,
          column: startColumn,
          offset: startOffset,
        });
        continue;
      }
      tokens.push({
        type: TokenType.Operator,
        value: '>',
        raw: '>',
        line: startLine,
        column: startColumn,
        offset: startOffset,
      });
      continue;
    }

    if (ch === '!' && peek(1) === '=') {
      advance();
      advance();
      tokens.push({
        type: TokenType.Operator,
        value: '<>',
        raw: '!=',
        line: startLine,
        column: startColumn,
        offset: startOffset,
      });
      continue;
    }

    // 8. Single-character operators and symbols
    if (ch === '=') {
      advance();
      tokens.push({
        type: TokenType.Operator,
        value: '=',
        raw: '=',
        line: startLine,
        column: startColumn,
        offset: startOffset,
      });
      continue;
    }

    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      advance();
      tokens.push({
        type: TokenType.Operator,
        value: ch,
        raw: ch,
        line: startLine,
        column: startColumn,
        offset: startOffset,
      });
      continue;
    }

    if (ch === ',' || ch === '.' || ch === ';' || ch === '(' || ch === ')') {
      advance();
      tokens.push({
        type: TokenType.Symbol,
        value: ch,
        raw: ch,
        line: startLine,
        column: startColumn,
        offset: startOffset,
      });
      continue;
    }

    // 9. Any other character (fallback to Symbol)
    advance();
    tokens.push({
      type: TokenType.Symbol,
      value: ch,
      raw: ch,
      line: startLine,
      column: startColumn,
      offset: startOffset,
    });
  }

  if (includeEof) {
    tokens.push({
      type: TokenType.EOF,
      value: '',
      raw: '',
      line,
      column,
      offset,
    });
  }

  return tokens;
}
