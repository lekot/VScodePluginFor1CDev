import { scanBslInterceptorBlocks } from '../../extensionSupport/cfeProject/bslInterceptorScanner';

const SUPPORTED_DECORATORS = new Set(['перед', 'после', 'вместо', 'before', 'after', 'instead']);
const UNSUPPORTED_DECORATORS = new Set(['изменениеиконтроль', 'changeandvalidate']);
const BSL_IDENTIFIER = '[\\p{L}_][\\p{L}\\p{N}_]*';

/** Returns a reason when a selected module contains an unsupported or ambiguous intercept. */
export function unsupportedExtensionInterceptReason(content: Buffer): string | undefined {
  const source = content.toString('utf8').replace(/^\uFEFF/u, '');
  const originalLines = source.split(/\r?\n/u);
  const codeLines = stripBslStringsAndComments(source).split(/\r?\n/u);
  let hasRussianSupportedDecorator = false;

  for (let lineIndex = 0; lineIndex < codeLines.length; lineIndex++) {
    const codeLine = codeLines[lineIndex]!.trim();
    const match = new RegExp(`^&\\s*(${BSL_IDENTIFIER})`, 'u').exec(codeLine);
    if (!match) {continue;}
    const decorator = match[1]!.toLocaleLowerCase();
    const hasCallShape = new RegExp(`^&\\s*${escapeRegExp(match[1]!)}\\s*\\(`, 'iu').test(codeLine);

    if (UNSUPPORTED_DECORATORS.has(decorator)) {
      return `Перехват ${match[1]} не поддерживается при переносе CFE↔CFE.`;
    }
    if (!SUPPORTED_DECORATORS.has(decorator)) {
      if (hasCallShape) {
        return `Неизвестная форма BSL-перехвата ${match[1]} блокирует перенос.`;
      }
      continue;
    }
    if (!hasCallShape) {
      return `Декоратор ${match[1]} имеет неподдерживаемую форму.`;
    }

    if (decorator === 'перед' || decorator === 'после' || decorator === 'вместо') {
      hasRussianSupportedDecorator = true;
      continue;
    }
    if (!isWellFormedEnglishDecorator(originalLines[lineIndex] ?? '', match[1]!)) {
      return `Декоратор ${match[1]} имеет неподдерживаемую форму.`;
    }
  }

  if (hasRussianSupportedDecorator) {
    try {
      const blocks = scanBslInterceptorBlocks(source);
      if (blocks.some((block) => block.interceptorKind === 'changeAndValidate')) {
        return 'Перехват ИзменениеИКонтроль не поддерживается при переносе CFE↔CFE.';
      }
    } catch (error) {
      return `Не удалось безопасно разобрать BSL-перехват: ${errorMessage(error)}.`;
    }
  }
  return undefined;
}

function isWellFormedEnglishDecorator(line: string, decorator: string): boolean {
  const escapedName = escapeRegExp(decorator);
  const targetMethod = new RegExp(`^&\\s*${escapedName}\\s*\\(\\s*"${BSL_IDENTIFIER}"\\s*\\)\\s*(?://.*)?$`, 'iu');
  return targetMethod.test(line.trim());
}

function stripBslStringsAndComments(source: string): string {
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
