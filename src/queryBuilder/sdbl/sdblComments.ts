/* eslint-disable @typescript-eslint/no-explicit-any -- tokens and AST nodes are walked as plain JSON */
import { tokenizeSdbl } from './sdblTokenizer';
import { TokenType } from './sdblTokens';
import { semanticKey } from './sdblAstEquivalence';

function tokenKey(t: any): string {
  return t.type + ':' + (t.type === TokenType.StringLiteral ? t.value : t.value.toUpperCase());
}

export function captureComments(text: string, ast: any, opaqueRanges: Array<[number, number]>): void {
  const tokens = tokenizeSdbl(text, { includeComments: true });
  // Display annotations travel with their statement when a package is reordered.
  // Keep them separate from preservation anchors, including comments in opaque DCS blocks.
  const lines = text.split(/\r?\n/);
  const contextLines = [...lines];
  for (const token of tokens) {if (token.type === TokenType.Comment)
    {contextLines[token.line - 1] = contextLines[token.line - 1].slice(0, token.column - 1);}}
  let queryIndex = 0, seenCode = false, delimiterLine = -1;
  for (const token of tokens) {
    if (token.type === TokenType.Comment) {
      const index = !seenCode && token.line === delimiterLine ? queryIndex - 1 : queryIndex;
      const query = ast.queries[Math.max(0, Math.min(index, ast.queries.length - 1))];
      if (!query) {continue;}
      const prefix = (lines[token.line - 1] || '').slice(0, token.column - 1).trim();
      const previous = contextLines.slice(0, token.line - 1).reverse().find(line => line.trim());
      const next = contextLines.slice(token.line).find(line => line.trim());
      const context = prefix || (seenCode ? previous : next) || '';
      (query._displayComments ||= []).push({ text: token.raw, line: token.line, context: context.trim() });
    } else if (token.type === TokenType.Symbol && token.value === ';'
        && !opaqueRanges.some(([start, end]) => token.offset >= start && token.offset < end)) {
      if (seenCode) {queryIndex++;}
      seenCode = false;
      delimiterLine = token.line;
    } else if (token.type !== TokenType.EOF) {seenCode = true;}
  }
  const comments = tokens.filter(t => t.type === TokenType.Comment &&
    !opaqueRanges.some(([start, end]) => t.offset >= start && t.offset < end));
  if (!comments.length) {return;}
  const code = tokens.filter(t => t.type !== TokenType.Comment), keys = code.map(tokenKey);
  ast._comments = comments.map(t => {
    const boundary = code.findIndex(x => x.offset > t.offset);
    const index = boundary < 0 ? code.length : boundary;
    // A comment after code on its line stays at the end of that line.
    const trailing = (lines[t.line - 1] || '').slice(0, t.column - 1).trim() !== '';
    const comment = { text: t.raw, before: keys.slice(Math.max(0, index - 4), index),
      after: keys.slice(index, index + 4), trailing, line: t.line, column: t.column,
      context: { before: keys.slice(Math.max(0, index - 64), index), after: keys.slice(index, index + 64) },
      ordinal: 0, count: 0 };
    // The same neighbours may repeat elsewhere in the package: the occurrence
    // number tells them apart when the formatter keeps the token sequence.
    const matches = windowMatches(keys, comment);
    comment.ordinal = matches.indexOf(index);
    comment.count = matches.length;
    return comment;
  });
  ast._originalText = text;
  ast._originalSemantics = semanticKey(ast);
}

function sameKeys(keys: string[], start: number, expected: string[]): boolean {
  if (start < 0 || start + expected.length > keys.length) {return false;}
  for (let i = 0; i < expected.length; i++) {if (keys[start + i] !== expected[i]) {return false;}}
  return true;
}

function windowMatches(keys: string[], comment: any): number[] {
  const before: string[] = comment.before || [];
  const after: string[] = comment.after || [];
  if (!before.length && !after.length) {return [0];}
  const result: number[] = [];
  for (let i = before.length; i <= keys.length; i++)
    {if (sameKeys(keys, i - before.length, before) && sameKeys(keys, i, after)) {result.push(i);}}
  return result;
}

// Length of the neighbourhood that still agrees with the original around i.
function contextAgreement(keys: string[], i: number, context: { before: string[], after: string[] }): number {
  let score = 0;
  for (let k = 1; k <= context.before.length && keys[i - k] === context.before[context.before.length - k]; k++) {score++;}
  for (let k = 0; k < context.after.length && keys[i + k] === context.after[k]; k++) {score++;}
  return score;
}

function commentPosition(keys: string[], comment: any, unchanged: boolean): number {
  const candidates = windowMatches(keys, comment);
  if (candidates.length === 1) {return candidates[0];}
  // A reordered or edited package may move repeated fragments: then only the
  // wider neighbourhood decides.
  if (unchanged && comment.count === candidates.length && comment.ordinal >= 0) {return candidates[comment.ordinal];}
  if (!comment.context) {return -1;}
  const positions = candidates.length
    ? candidates
    : Array.from({ length: keys.length + 1 }, (_value, index) => index);
  let bestScore = 0, bestPosition = -1, ambiguous = false;
  for (const position of positions) {
    const score = contextAgreement(keys, position, comment.context);
    if (score > bestScore) {
      bestScore = score;
      bestPosition = position;
      ambiguous = false;
    } else if (score > 0 && score === bestScore) {
      ambiguous = true;
    }
  }
  return bestPosition >= 0 && !ambiguous ? bestPosition : -1;
}

// The formatted text gets the comments back by their neighbouring tokens: the
// layout is the formatter's even when the meaning did not change.
export function restoreComments(text: string, ast: any): string {
  if (!ast._comments?.length) {return text;}
  const tokens = tokenizeSdbl(text, { includeComments: false }).filter(t => t.type !== TokenType.EOF);
  const keys = tokens.map(tokenKey), insertions = new Map<number, string[]>();
  const unchanged = ast._originalSemantics !== undefined && semanticKey(ast) === ast._originalSemantics;
  for (const comment of ast._comments) {
    const at = commentPosition(keys, comment, unchanged);
    if (at < 0) {
      const error: any = new Error('Нельзя однозначно сохранить положение комментария после этой правки: ' + comment.text);
      if (comment.line) {Object.assign(error, { sdblLine: comment.line, sdblColumn: comment.column, sdblLength: comment.text.length });}
      throw error;
    }
    const previous = tokens[at - 1], next = tokens[at];
    let position: number, insert: string;
    if (comment.trailing && previous) {
      const end = text.indexOf('\n', previous.offset + previous.raw.length);
      position = end < 0 ? text.length : end;
      insert = ' ' + comment.text;
    } else {
      const offset = next ? next.offset : text.length;
      const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
      const lead = text.slice(lineStart, offset);
      if (next && !lead.trim()) { position = lineStart; insert = lead + comment.text + '\n'; }
      else { position = offset; insert = '\n' + comment.text + '\n'; }
    }
    const list = insertions.get(position) || []; list.push(insert); insertions.set(position, list);
  }
  for (const [position, inserts] of [...insertions].sort((a, b) => b[0] - a[0])) {
    text = text.slice(0, position) + inserts.join('') + text.slice(position);
  }
  return text;
}
