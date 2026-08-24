import { hashContent } from '../../services/configurationSession/atomicFileStorage';
import type { CfeInterceptorKind } from './interceptorTypes';

const IDENTIFIER = '[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*';
const DECLARATION_RE = new RegExp(
  `^\\s*(?:(Асинх|Async)\\s+)?(Процедура|Функция|Procedure|Function)\\s+(${IDENTIFIER})(?=\\s|\\(|$)`,
  'iu',
);
const CONTEXT_DIRECTIVE_RE = /^&(НаКлиенте|НаСервере|НаСервереБезКонтекста|НаКлиентеНаСервереБезКонтекста|НаКлиентеНаСервере)$/iu;
const DECORATOR_RE = /^&(Перед|После|Вместо|ИзменениеИКонтроль)\s*\(\s*"([^"]+)"\s*\)\s*$/iu;

export type BslRoutineKind = 'procedure' | 'function';

export interface BslWrapperRegion {
  readonly kind: 'region';
  readonly name: string;
}

export interface BslWrapperPreprocessor {
  readonly kind: 'preprocessor';
  readonly condition: string;
}

export type BslWrapper = BslWrapperRegion | BslWrapperPreprocessor;

export interface BslMethod {
  readonly name: string;
  readonly normalizedName: string;
  readonly kind: BslRoutineKind;
  readonly isAsync: boolean;
  readonly parameterText: string;
  readonly parameterNames: readonly string[];
  readonly contextDirective?: string;
  readonly wrappers: readonly BslWrapper[];
  readonly declarationLineIndex: number;
  readonly signatureEndLineIndex: number;
  readonly endLineIndex: number;
  readonly bodyText: string;
  readonly canonicalText: string;
  readonly sourceHash: string;
  readonly declarationStartOffset: number;
  readonly endOffset: number;
}

export interface BslInterceptorBlock {
  readonly interceptorKind: CfeInterceptorKind;
  readonly targetMethodName: string;
  readonly method: BslMethod;
  readonly contextDirective?: string;
  readonly coreText: string;
}

/** Raised when a source cannot be safely understood as structural BSL. */
export class BslStructuralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BslStructuralError';
  }
}

/**
 * Scans BSL declarations without treating strings or comments as code. The scanner keeps
 * module-level regions/preprocessor branches so generated interceptors have the same
 * placement context as their source method.
 */
export function scanBslMethods(input: string): readonly BslMethod[] {
  const source = normalizeBslEol(input.replace(/^\uFEFF/u, ''));
  const lines = splitLines(source);
  const code = stripStringsAndComments(source);
  const codeLines = splitLines(code);
  const wrappers: BslScopeFrame[] = [];
  const methods: BslMethod[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const original = lines[lineIndex]!;
    const clean = codeLines[lineIndex]!;
    updateWrappers(wrappers, original.text, clean.text, lineIndex + 1);

    const declaration = DECLARATION_RE.exec(clean.text);
    if (!declaration) {
      continue;
    }
    const name = declaration[3]!;
    const declarationOffset = original.start + firstNonWhitespaceOffset(original.text);
    const openParen = findOpeningParenthesis(code, original.start + declaration[0].length);
    if (openParen < 0) {
      throw new BslStructuralError(`Не удалось разобрать сигнатуру метода «${name}»: отсутствует «(».`);
    }
    const closeParen = findClosingParenthesis(code, openParen);
    if (closeParen < 0) {
      throw new BslStructuralError(`Не удалось разобрать сигнатуру метода «${name}»: отсутствует «)».`);
    }
    const signatureEndLineIndex = lineIndexForOffset(lines, closeParen);
    const routineKind = isFunctionKeyword(declaration[2]!) ? 'function' : 'procedure';
    const endLineIndex = findRoutineEnd(codeLines, signatureEndLineIndex + 1, routineKind, name);
    const bodyStart = signatureEndLineIndex + 1 < lines.length
      ? lines[signatureEndLineIndex + 1]!.start
      : lines[signatureEndLineIndex]!.end;
    const bodyEnd = lines[endLineIndex]!.start;
    const endOffset = lines[endLineIndex]!.end;
    const parameterText = source.slice(openParen + 1, closeParen);
    const canonicalText = source.slice(declarationOffset, endOffset);
    const priorLine = lineIndex > 0 ? codeLines[lineIndex - 1] : undefined;
    const priorOriginal = lineIndex > 0 ? lines[lineIndex - 1] : undefined;
    const contextDirective = priorLine && priorOriginal && isContextDirective(priorLine.text)
      ? priorOriginal.text.trim()
      : undefined;

    methods.push({
      name,
      normalizedName: normalizeName(name),
      kind: routineKind,
      isAsync: declaration[1] !== undefined,
      parameterText,
      parameterNames: parseParameterNames(parameterText),
      contextDirective,
      wrappers: materializeWrappers(wrappers),
      declarationLineIndex: lineIndex,
      signatureEndLineIndex,
      endLineIndex,
      bodyText: source.slice(bodyStart, bodyEnd),
      canonicalText,
      sourceHash: hashContent(canonicalText),
      declarationStartOffset: declarationOffset,
      endOffset,
    });
  }

  if (wrappers.length > 0) {
    throw new BslStructuralError('В BSL-модуле не закрыта область или директива препроцессора.');
  }
  return methods;
}

export function findBslMethod(source: string, methodName: string): BslMethod | undefined {
  const normalized = normalizeName(methodName);
  return scanBslMethods(source).find((method) => method.normalizedName === normalized);
}

/** Finds decorator blocks in an extension module and ignores comments/string contents. */
export function scanBslInterceptorBlocks(input: string): readonly BslInterceptorBlock[] {
  const source = normalizeBslEol(input.replace(/^\uFEFF/u, ''));
  const lines = splitLines(source);
  const codeLines = splitLines(stripStringsAndComments(source));
  const methods = scanBslMethods(source);
  const result: BslInterceptorBlock[] = [];

  for (let lineIndex = 0; lineIndex < codeLines.length; lineIndex++) {
    // The target method name is a string literal, therefore the lexical code view
    // deliberately blanks it. First establish that the decorator token is real in
    // code, then recover the quoted target from the original line.
    if (!/^&(Перед|После|Вместо|ИзменениеИКонтроль)\s*\(/iu.test(codeLines[lineIndex]!.text.trim())) {
      continue;
    }
    const match = DECORATOR_RE.exec(lines[lineIndex]!.text.trim());
    if (!match) {
      throw new BslStructuralError(`Некорректный декоратор перехватчика в строке ${lineIndex + 1}.`);
    }
    const method = methods.find((candidate) => (
      candidate.declarationLineIndex > lineIndex
      && onlyWhitespaceBetween(codeLines, lineIndex + 1, candidate.declarationLineIndex)
    ));
    if (!method) {
      throw new BslStructuralError(`Не удалось разобрать процедуру после декоратора в строке ${lineIndex + 1}.`);
    }
    const kind = interceptorKindFromDecorator(match[1]!);
    const priorCode = lineIndex > 0 ? codeLines[lineIndex - 1] : undefined;
    const priorOriginal = lineIndex > 0 ? lines[lineIndex - 1] : undefined;
    const contextDirective = priorCode && priorOriginal && isContextDirective(priorCode.text)
      ? priorOriginal.text.trim()
      : undefined;
    const coreStart = contextDirective === undefined ? lines[lineIndex]!.start : priorOriginal!.start;
    result.push({
      interceptorKind: kind,
      targetMethodName: match[2]!,
      method,
      contextDirective,
      coreText: source.slice(coreStart, method.endOffset),
    });
  }
  return result;
}

/** Canonical generated BSL block derived from a parsed base method. */
export function buildCanonicalInterceptorBlock(
  method: BslMethod,
  interceptorKind: CfeInterceptorKind,
  interceptorName: string,
): string {
  const prefix = method.contextDirective === undefined ? '' : `${method.contextDirective}\r\n`;
  const decorator = decoratorFor(interceptorKind);
  const asyncPrefix = method.isAsync ? 'Асинх ' : '';
  const routineKeyword = method.kind === 'function' ? 'Функция' : 'Процедура';
  const endKeyword = method.kind === 'function' ? 'КонецФункции' : 'КонецПроцедуры';
  const header = `${prefix}&${decorator}("${method.name}")\r\n${asyncPrefix}${routineKeyword} ${interceptorName}(${normalizeBslEol(method.parameterText).replace(/\n/gu, '\r\n')})`;

  switch (interceptorKind) {
    case 'before':
      return `${header}\r\n\t// TODO: код перед вызовом оригинального метода\r\n${endKeyword}`;
    case 'after':
      return `${header}\r\n\t// TODO: код после вызова оригинального метода\r\n${endKeyword}`;
    case 'instead':
      return buildInsteadBlock(header, method, endKeyword);
    case 'changeAndValidate':
      return buildChangeAndValidateBlock(header, method, endKeyword);
  }
}

/** Keeps the source module's region/preprocessor placement around a generated core block. */
export function wrapInterceptorBlock(wrappers: readonly BslWrapper[], core: string): string {
  if (wrappers.length === 0) {
    return core;
  }
  const lines: string[] = [];
  for (const wrapper of wrappers) {
    lines.push(wrapper.kind === 'region'
      ? `#Область ${wrapper.name}`
      : `#Если ${wrapper.condition} Тогда`);
    lines.push('');
  }
  lines.push(core);
  for (const wrapper of [...wrappers].reverse()) {
    lines.push('');
    lines.push(wrapper.kind === 'region' ? '#КонецОбласти' : '#КонецЕсли');
  }
  return lines.join('\r\n');
}

export function normalizeBslEol(value: string): string {
  return value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
}

function buildInsteadBlock(header: string, method: BslMethod, endKeyword: string): string {
  const parameters = method.parameterNames.join(', ');
  if (method.kind === 'function') {
    return `${header}\r\n\tРезультат = ПродолжитьВызов(${parameters});\r\n\t// TODO: доработать поведение\r\n\tВозврат Результат;\r\n${endKeyword}`;
  }
  return `${header}\r\n\tПродолжитьВызов(${parameters});\r\n\t// TODO: доработать поведение\r\n${endKeyword}`;
}

function buildChangeAndValidateBlock(header: string, method: BslMethod, endKeyword: string): string {
  const body = normalizeBslEol(method.bodyText).replace(/\n/gu, '\r\n');
  // The oracle creates an initial controlled method as a direct body copy. Diff markers
  // are recognised and preserved only when a later user-driven resync introduces them.
  return body === '' ? `${header}\r\n${endKeyword}` : `${header}\r\n${body}${endKeyword}`;
}

interface BslLine {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

type BslScopeFrame = RegionFrame | PreprocessorFrame;

interface RegionFrame {
  readonly kind: 'region';
  readonly name: string;
}

interface PreprocessorFrame {
  readonly kind: 'preprocessor';
  readonly conditions: string[];
  branch: 'if' | 'elseIf' | 'else';
}

function splitLines(source: string): readonly BslLine[] {
  const result: BslLine[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') {
      result.push({ start, end: index, text: source.slice(start, index) });
      start = index + 1;
    }
  }
  result.push({ start, end: source.length, text: source.slice(start) });
  return result;
}

function stripStringsAndComments(source: string): string {
  let output = '';
  let inString = false;
  let inComment = false;
  for (let index = 0; index < source.length; index++) {
    const current = source[index]!;
    const next = source[index + 1];
    if (inComment) {
      if (current === '\n') {
        inComment = false;
        output += current;
      } else {
        output += ' ';
      }
      continue;
    }
    if (inString) {
      if (current === '"' && next === '"') {
        output += '  ';
        index++;
        continue;
      }
      if (current === '"') {
        inString = false;
        output += ' ';
        continue;
      }
      output += current === '\n' ? '\n' : ' ';
      continue;
    }
    if (current === '/' && next === '/') {
      inComment = true;
      output += '  ';
      index++;
      continue;
    }
    if (current === '"') {
      inString = true;
      output += ' ';
      continue;
    }
    output += current;
  }
  return output;
}

function updateWrappers(
  wrappers: BslScopeFrame[],
  originalLine: string,
  cleanLine: string,
  lineNumber: number,
): void {
  const clean = cleanLine.trim();
  if (clean === '') {
    return;
  }
  const original = originalLine.trim();
  let match = /^#Область\s+(.+?)\s*$/iu.exec(clean);
  if (match) {
    const originalMatch = /^#Область\s+(.+?)\s*$/iu.exec(original);
    const name = originalMatch?.[1]?.trim() ?? '';
    if (name === '') {
      throw new BslStructuralError(`Пустое имя области в строке ${lineNumber}.`);
    }
    wrappers.push({ kind: 'region', name });
    return;
  }
  if (/^#КонецОбласти(?:\s|$)/iu.test(clean)) {
    if (wrappers[wrappers.length - 1]?.kind !== 'region') {
      throw new BslStructuralError(`Несогласованное #КонецОбласти в строке ${lineNumber}.`);
    }
    wrappers.pop();
    return;
  }
  match = /^#Если\s+(.+?)\s+Тогда\s*$/iu.exec(clean);
  if (match) {
    const originalMatch = /^#Если\s+(.+?)\s+Тогда\s*$/iu.exec(original);
    const condition = originalMatch?.[1]?.trim() ?? '';
    if (condition === '') {
      throw new BslStructuralError(`Пустое условие #Если в строке ${lineNumber}.`);
    }
    wrappers.push({ kind: 'preprocessor', conditions: [condition], branch: 'if' });
    return;
  }
  match = /^#ИначеЕсли\s+(.+?)\s+Тогда\s*$/iu.exec(clean);
  if (match) {
    const frame = lastPreprocessor(wrappers);
    const originalMatch = /^#ИначеЕсли\s+(.+?)\s+Тогда\s*$/iu.exec(original);
    const condition = originalMatch?.[1]?.trim() ?? '';
    if (!frame || condition === '') {
      throw new BslStructuralError(`Несогласованное #ИначеЕсли в строке ${lineNumber}.`);
    }
    frame.conditions.push(condition);
    frame.branch = 'elseIf';
    return;
  }
  if (/^#Иначе(?:\s|$)/iu.test(clean)) {
    const frame = lastPreprocessor(wrappers);
    if (!frame) {
      throw new BslStructuralError(`Несогласованное #Иначе в строке ${lineNumber}.`);
    }
    frame.branch = 'else';
    return;
  }
  if (/^#КонецЕсли(?:\s|$)/iu.test(clean)) {
    if (wrappers[wrappers.length - 1]?.kind !== 'preprocessor') {
      throw new BslStructuralError(`Несогласованное #КонецЕсли в строке ${lineNumber}.`);
    }
    wrappers.pop();
  }
}

function materializeWrappers(frames: readonly BslScopeFrame[]): readonly BslWrapper[] {
  return frames.map((frame) => frame.kind === 'region'
    ? { kind: 'region', name: frame.name }
    : { kind: 'preprocessor', condition: effectiveCondition(frame) });
}

function effectiveCondition(frame: PreprocessorFrame): string {
  const conditions = frame.conditions;
  if (frame.branch === 'if') {
    return conditions[0]!;
  }
  if (frame.branch === 'elseIf') {
    return [
      ...conditions.slice(0, -1).map((condition) => `НЕ (${condition})`),
      conditions[conditions.length - 1]!,
    ].join(' И ');
  }
  return conditions.map((condition) => `НЕ (${condition})`).join(' И ');
}

function lastPreprocessor(frames: BslScopeFrame[]): PreprocessorFrame | undefined {
  const frame = frames[frames.length - 1];
  return frame?.kind === 'preprocessor' ? frame : undefined;
}

function findOpeningParenthesis(code: string, start: number): number {
  for (let index = start; index < code.length; index++) {
    const current = code[index]!;
    if (current === '(') {
      return index;
    }
    if (current === '\n' && /^(?:\s*#|\s*(?:Процедура|Функция|Procedure|Function)\b)/iu.test(code.slice(index + 1))) {
      return -1;
    }
  }
  return -1;
}

function findClosingParenthesis(code: string, openParen: number): number {
  let depth = 0;
  for (let index = openParen; index < code.length; index++) {
    const current = code[index]!;
    if (current === '(') {
      depth++;
    } else if (current === ')') {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function findRoutineEnd(
  codeLines: readonly BslLine[],
  startLineIndex: number,
  routineKind: BslRoutineKind,
  name: string,
): number {
  const endPattern = routineKind === 'function'
    ? /^\s*(КонецФункции|EndFunction)(?:\s|$)/iu
    : /^\s*(КонецПроцедуры|EndProcedure)(?:\s|$)/iu;
  for (let lineIndex = startLineIndex; lineIndex < codeLines.length; lineIndex++) {
    if (endPattern.test(codeLines[lineIndex]!.text)) {
      return lineIndex;
    }
  }
  throw new BslStructuralError(`Не найден конец метода «${name}».`);
}

function lineIndexForOffset(lines: readonly BslLine[], offset: number): number {
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    if (offset >= lines[lineIndex]!.start && offset <= lines[lineIndex]!.end) {
      return lineIndex;
    }
  }
  throw new BslStructuralError('Не удалось определить строку сигнатуры метода.');
}

function parseParameterNames(parameterText: string): readonly string[] {
  const clean = stripStringsAndComments(parameterText);
  const segments: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < clean.length; index++) {
    const current = clean[index]!;
    if (current === '(') {
      depth++;
    } else if (current === ')') {
      depth--;
    } else if (current === ',' && depth === 0) {
      segments.push(parameterText.slice(start, index));
      start = index + 1;
    }
  }
  segments.push(parameterText.slice(start));
  return segments.filter((segment) => segment.trim() !== '').map((segment) => {
    const stripped = segment.trim().replace(/^(Знач|Val)\s+/iu, '');
    const name = new RegExp(`^(${IDENTIFIER})`, 'u').exec(stripped)?.[1];
    if (!name) {
      throw new BslStructuralError('Не удалось определить имя параметра метода.');
    }
    return name;
  });
}

function onlyWhitespaceBetween(lines: readonly BslLine[], start: number, end: number): boolean {
  for (let lineIndex = start; lineIndex < end; lineIndex++) {
    if (lines[lineIndex]!.text.trim() !== '') {
      return false;
    }
  }
  return true;
}

function interceptorKindFromDecorator(value: string): CfeInterceptorKind {
  switch (value.toLocaleLowerCase()) {
    case 'перед': return 'before';
    case 'после': return 'after';
    case 'вместо': return 'instead';
    case 'изменениеиконтроль': return 'changeAndValidate';
    default: throw new BslStructuralError(`Неизвестный декоратор перехватчика «${value}».`);
  }
}

function decoratorFor(kind: CfeInterceptorKind): string {
  switch (kind) {
    case 'before': return 'Перед';
    case 'after': return 'После';
    case 'instead': return 'Вместо';
    case 'changeAndValidate': return 'ИзменениеИКонтроль';
  }
}

function isFunctionKeyword(value: string): boolean {
  return value.toLocaleLowerCase() === 'функция' || value.toLocaleLowerCase() === 'function';
}

function isContextDirective(line: string): boolean {
  return CONTEXT_DIRECTIVE_RE.test(line.trim());
}

function firstNonWhitespaceOffset(value: string): number {
  const index = /\S/u.exec(value)?.index;
  return index === undefined ? 0 : index;
}

function normalizeName(value: string): string {
  return value.toLocaleLowerCase();
}
