import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  isBslCompletionIndex,
  type BslCompletionLanguageAliases,
  type BslCompletionIndex,
  type BslCompletionType,
  type CompletionArticleReference,
} from './bslCompletionIndex';
import { BslLocalCompletionIndex, type BslLocalRoutineCandidate } from './bslLocalCompletionIndex';
import type { BslCompletionLanguage } from '../parsers/configurationBslLanguage';

const MAX_CONTEXT_LINES = 200;
const MAX_CONTEXT_CHARS = 16_384;
const RUSSIAN_BSL_KEYWORDS = [
  'Процедура', 'Функция', 'Перем', 'Экспорт', 'Знач', 'КонецПроцедуры', 'КонецФункции',
  'Если', 'ИначеЕсли', 'Иначе', 'Тогда', 'КонецЕсли', 'Попытка', 'Исключение', 'КонецПопытки',
  'ВызватьИсключение', 'Для', 'Каждого', 'Из', 'По', 'Цикл', 'Пока', 'КонецЦикла', 'Прервать',
  'Продолжить', 'Возврат', 'Новый', 'И', 'Или', 'Не', 'Истина', 'Ложь', 'Неопределено',
] as const;
const ENGLISH_BSL_KEYWORDS = [
  'Procedure', 'Function', 'Var', 'Export', 'Val', 'EndProcedure', 'EndFunction', 'If', 'ElsIf',
  'Else', 'Then', 'EndIf', 'Try', 'Except', 'EndTry', 'Raise', 'For', 'Each', 'In', 'To', 'Do',
  'While', 'EndDo', 'Break', 'Continue', 'Return', 'New', 'And', 'Or', 'Not', 'True', 'False', 'Undefined',
] as const;
const SHARED_BSL_KEYWORDS = ['Null'] as const;
const EMPTY_LANGUAGE_ALIASES: BslCompletionLanguageAliases = { bilingualPairIndices: [] };

type CompletionKind = 'property' | 'method' | 'type';

interface Candidate {
  readonly name: string;
  readonly kind: CompletionKind;
  readonly article: CompletionArticleReference;
  readonly zeroArgument?: boolean;
}

interface RuntimeIndex {
  readonly globalCandidatesByLanguage: Readonly<Record<BslCompletionLanguage, readonly Candidate[]>>;
  readonly globalCandidatesByFirstCharacterByLanguage: Readonly<Record<BslCompletionLanguage, ReadonlyMap<string, readonly Candidate[]>>>;
  readonly typeCandidatesByLanguage: Readonly<Record<BslCompletionLanguage, readonly Candidate[]>>;
  readonly typeCandidatesByFirstCharacterByLanguage: Readonly<Record<BslCompletionLanguage, ReadonlyMap<string, readonly Candidate[]>>>;
  readonly typesByAlias: ReadonlyMap<string, readonly BslCompletionType[]>;
  readonly metadataCollectionFolders: ReadonlyMap<string, string>;
  readonly catalogManagerCandidatesByLanguage: Readonly<Record<BslCompletionLanguage, readonly Candidate[]>>;
  readonly catalogManagerCandidatesByFirstCharacterByLanguage: Readonly<Record<BslCompletionLanguage, ReadonlyMap<string, readonly Candidate[]>>>;
  readonly catalogObjectCandidatesByLanguage: Readonly<Record<BslCompletionLanguage, readonly Candidate[]>>;
  readonly catalogObjectCandidatesByFirstCharacterByLanguage: Readonly<Record<BslCompletionLanguage, ReadonlyMap<string, readonly Candidate[]>>>;
  readonly catalogApiAvailable: boolean;
}

interface MaskedLine {
  readonly text: string;
  readonly ignoredAtEnd: boolean;
}

interface MemberContext {
  readonly receiver?: string;
  readonly metadataCollection?: string;
  readonly metadataObjectName?: string;
  readonly filter: string;
  readonly dotOffset: number;
}

interface CompletionContext {
  readonly kind: 'global' | 'type' | 'member';
  readonly prefix: string;
  readonly typeName?: string;
  readonly receiver?: string;
  readonly metadataCollection?: string;
  readonly metadataObjectName?: string;
}

interface ReceiverInference {
  readonly typeName?: string;
  readonly catalogObjectName?: string;
  readonly assigned: boolean;
}

export type LoadedTypeObjectsResult =
  | { readonly status: 'loaded'; readonly names: readonly string[] }
  | { readonly status: 'notLoaded' };

export interface BslMetadataCompletionReader {
  getLoadedTypeObjectsForResource(resourcePath: string, folderId: string): LoadedTypeObjectsResult;
  getLanguageForResource?(resourcePath: string): BslCompletionLanguage;
}

type MetadataCompletionReaderProvider = () => BslMetadataCompletionReader | null | undefined;

const indexLoads = new Map<string, Promise<RuntimeIndex>>();

function normalizeIdentifier(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('ru-RU');
}

function firstCharacter(value: string): string {
  return Array.from(normalizeIdentifier(value))[0] ?? '';
}

function groupByFirstCharacter(candidates: readonly Candidate[]): ReadonlyMap<string, readonly Candidate[]> {
  const grouped = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const first = firstCharacter(candidate.name);
    const bucket = grouped.get(first) ?? [];
    bucket.push(candidate);
    grouped.set(first, bucket);
  }
  return grouped;
}

function uniqueCandidates(candidates: readonly Candidate[]): Candidate[] {
  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = normalizeIdentifier(candidate.name);
    if (!unique.has(key)) {
      unique.set(key, candidate);
    }
  }
  return [...unique.values()];
}

function filterCandidatesForLanguage(
  candidates: readonly Candidate[],
  aliases: BslCompletionLanguageAliases,
  language: BslCompletionLanguage,
): Candidate[] {
  const oppositeIndices = new Set(aliases.bilingualPairIndices.map(([russianIndex, englishIndex]) =>
    language === 'en' ? russianIndex : englishIndex));
  const preferredIndices = new Set(aliases.bilingualPairIndices.map(([russianIndex, englishIndex]) =>
    language === 'en' ? englishIndex : russianIndex));
  return candidates.filter((_, index) => !oppositeIndices.has(index) || preferredIndices.has(index));
}

function candidatesByLanguage(
  candidates: readonly Candidate[],
  aliases: BslCompletionLanguageAliases,
): Record<BslCompletionLanguage, readonly Candidate[]> {
  return {
    ru: filterCandidatesForLanguage(candidates, aliases, 'ru'),
    en: filterCandidatesForLanguage(candidates, aliases, 'en'),
  };
}

function firstCharacterGroupsByLanguage(
  candidates: Readonly<Record<BslCompletionLanguage, readonly Candidate[]>>,
): Record<BslCompletionLanguage, ReadonlyMap<string, readonly Candidate[]>> {
  return {
    ru: groupByFirstCharacter(candidates.ru),
    en: groupByFirstCharacter(candidates.en),
  };
}

function createRuntimeIndex(index: BslCompletionIndex): RuntimeIndex {
  const globalArticle = index.global.article;
  const zeroArgumentMethods = new Set(index.global.zeroArgumentMethods.map(normalizeIdentifier));
  const allGlobalCandidates = uniqueCandidates([
    ...index.global.properties.map((name) => ({ name, kind: 'property' as const, article: globalArticle })),
    ...index.global.methods.map((name) => ({
      name,
      kind: 'method' as const,
      article: globalArticle,
      zeroArgument: zeroArgumentMethods.has(normalizeIdentifier(name)),
    })),
  ]);
  const globalCandidates = candidatesByLanguage(allGlobalCandidates, index.global.languageAliases);
  const typeCandidatesByLanguage: Record<BslCompletionLanguage, Candidate[]> = { ru: [], en: [] };
  for (const type of index.types) {
    const aliases = uniqueCandidates(type.aliases.map((name) => ({
      name,
      kind: 'type' as const,
      article: type.article,
    })));
    typeCandidatesByLanguage.ru.push(...filterCandidatesForLanguage(aliases, type.aliasLanguageAliases, 'ru'));
    typeCandidatesByLanguage.en.push(...filterCandidatesForLanguage(aliases, type.aliasLanguageAliases, 'en'));
  }
  const catalogManagerCandidates = uniqueCandidates(index.catalogApi ? [
    ...index.catalogApi.manager.properties.map((name) => ({
      name,
      kind: 'property' as const,
      article: index.catalogApi!.manager.article,
    })),
    ...index.catalogApi.manager.methods.map((name) => ({
      name,
      kind: 'method' as const,
      article: index.catalogApi!.manager.article,
    })),
  ] : []);
  const catalogObjectCandidates = uniqueCandidates(index.catalogApi ? [
    ...index.catalogApi.object.properties.map((name) => ({
      name,
      kind: 'property' as const,
      article: index.catalogApi!.object.article,
    })),
    ...index.catalogApi.object.methods.map((name) => ({
      name,
      kind: 'method' as const,
      article: index.catalogApi!.object.article,
    })),
  ] : []);
  const managerCandidatesByLanguage = candidatesByLanguage(
    catalogManagerCandidates,
    index.catalogApi?.manager.languageAliases ?? EMPTY_LANGUAGE_ALIASES,
  );
  const objectCandidatesByLanguage = candidatesByLanguage(
    catalogObjectCandidates,
    index.catalogApi?.object.languageAliases ?? EMPTY_LANGUAGE_ALIASES,
  );
  const mutableTypesByAlias = new Map<string, BslCompletionType[]>();
  for (const type of index.types) {
    for (const alias of type.aliases) {
      const key = normalizeIdentifier(alias);
      const types = mutableTypesByAlias.get(key) ?? [];
      if (!types.some(({ article }) => article.id === type.article.id)) {
        types.push(type);
        mutableTypesByAlias.set(key, types);
      }
    }
  }
  const metadataCollectionFolders = new Map<string, string>();
  for (const { aliases, folderId } of index.metadataCollections) {
    for (const alias of aliases) {
      metadataCollectionFolders.set(normalizeIdentifier(alias), folderId);
    }
  }
  return {
    globalCandidatesByLanguage: globalCandidates,
    globalCandidatesByFirstCharacterByLanguage: firstCharacterGroupsByLanguage(globalCandidates),
    typeCandidatesByLanguage,
    typeCandidatesByFirstCharacterByLanguage: firstCharacterGroupsByLanguage(typeCandidatesByLanguage),
    typesByAlias: mutableTypesByAlias,
    metadataCollectionFolders,
    catalogManagerCandidatesByLanguage: managerCandidatesByLanguage,
    catalogManagerCandidatesByFirstCharacterByLanguage: firstCharacterGroupsByLanguage(managerCandidatesByLanguage),
    catalogObjectCandidatesByLanguage: objectCandidatesByLanguage,
    catalogObjectCandidatesByFirstCharacterByLanguage: firstCharacterGroupsByLanguage(objectCandidatesByLanguage),
    catalogApiAvailable: index.catalogApi !== undefined,
  };
}

/** Reads the compact index once per extension installation; no SQLite/WASM work is done here. */
export function loadBslCompletionIndex(extensionPath: string): Promise<RuntimeIndex> {
  const cacheKey = path.resolve(extensionPath);
  const cached = indexLoads.get(cacheKey);
  if (cached) {
    return cached;
  }
  const indexPath = path.join(cacheKey, 'resources', 'help', 'bsl-completion-index.json');
  const loading = fs.promises.readFile(indexPath, 'utf8')
    .then((text) => JSON.parse(text) as unknown)
    .then((value) => {
      if (!isBslCompletionIndex(value)) {
        throw new Error('The BSL completion index has an unexpected format.');
      }
      return createRuntimeIndex(value);
    });
  indexLoads.set(cacheKey, loading);
  void loading.catch(() => {
    if (indexLoads.get(cacheKey) === loading) {
      indexLoads.delete(cacheKey);
    }
  });
  return loading;
}

/** Masks strings and `//` comments without changing code-unit offsets. */
function maskLine(source: string): MaskedLine {
  const masked = source.split('');
  let inString = false;
  let inComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    if (inComment) {
      masked[index] = ' ';
      continue;
    }
    if (inString) {
      if (current === '"' && source[index + 1] === '"') {
        masked[index] = ' ';
        masked[index + 1] = ' ';
        index += 1;
      } else if (current === '"') {
        masked[index] = ' ';
        inString = false;
      } else {
        masked[index] = ' ';
      }
      continue;
    }
    if (current === '"') {
      masked[index] = ' ';
      inString = true;
    } else if (current === '/' && source[index + 1] === '/') {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      inComment = true;
      index += 1;
    }
  }
  return { text: masked.join(''), ignoredAtEnd: inString || inComment };
}

function memberContext(prefix: string): MemberContext | undefined {
  const match = /\.\s*([\p{L}_][\p{L}\p{N}_]*)?$/u.exec(prefix);
  if (!match) {
    return undefined;
  }
  const dotOffset = match.index;
  const receiverText = prefix.slice(0, dotOffset).trimEnd();
  const statementStart = Math.max(receiverText.lastIndexOf(';'), receiverText.lastIndexOf('\n'), receiverText.lastIndexOf('\r')) + 1;
  const receiverExpression = receiverText.slice(statementStart).trim();
  const metadataMatch = /^(?:[\p{L}_][\p{L}\p{N}_]*\s*=\s*)?(Справочники|Catalogs)\s*\.\s*([\p{L}_][\p{L}\p{N}_]*)$/iu.exec(receiverExpression);
  if (metadataMatch) {
    return {
      metadataCollection: metadataMatch[1],
      metadataObjectName: metadataMatch[2],
      filter: match[1] ?? '',
      dotOffset,
    };
  }
  const receiver = /^([\p{L}_][\p{L}\p{N}_]*)$/u.exec(receiverExpression)?.[1];
  return { ...(receiver ? { receiver } : {}), filter: match[1] ?? '', dotOffset };
}

function directConstructorType(prefix: string, member: MemberContext): string | undefined {
  const expression = prefix.slice(0, member.dotOffset).trimEnd();
  if (!expression.endsWith(')')) {
    return undefined;
  }
  let depth = 0;
  let opening = -1;
  for (let index = expression.length - 1; index >= 0; index -= 1) {
    if (expression[index] === ')') {
      depth += 1;
    } else if (expression[index] === '(') {
      depth -= 1;
      if (depth === 0) {
        opening = index;
        break;
      }
    }
  }
  if (opening < 0) {
    return undefined;
  }
  const beforeCall = expression.slice(0, opening);
  return /(?:^|[^\p{L}\p{N}_])(?:Новый|New)\s+([\p{L}_][\p{L}\p{N}_]*)\s*$/iu.exec(beforeCall)?.[1];
}

function completionContext(prefix: string): CompletionContext | undefined {
  const masked = maskLine(prefix);
  if (masked.ignoredAtEnd) {
    return undefined;
  }
  const member = memberContext(masked.text);
  if (member) {
    const typeName = directConstructorType(masked.text, member);
    return {
      kind: 'member',
      prefix: member.filter,
      ...(typeName ? { typeName } : {}),
      ...(member.receiver ? { receiver: member.receiver } : {}),
      ...(member.metadataCollection ? { metadataCollection: member.metadataCollection } : {}),
      ...(member.metadataObjectName ? { metadataObjectName: member.metadataObjectName } : {}),
    };
  }
  const typeContext = /(?:^|[^\p{L}\p{N}_])(?:Новый|New)\s+([\p{L}_][\p{L}\p{N}_]*)?$/iu.exec(masked.text);
  if (typeContext) {
    return { kind: 'type', prefix: typeContext[1] ?? '' };
  }
  const currentWord = /([\p{L}_][\p{L}\p{N}_]*)?$/u.exec(masked.text)?.[1] ?? '';
  return { kind: 'global', prefix: currentWord };
}

function isMultilineStringContinuationLine(line: string): boolean {
  const scanLength = Math.min(line.length, MAX_CONTEXT_CHARS);
  const firstNonWhitespace = line.slice(0, scanLength).search(/\S/u);
  if (firstNonWhitespace >= 0) {
    return line[firstNonWhitespace] === '|';
  }
  return line.length > scanLength;
}

function currentProcedureBoundary(line: string): 'start' | 'end' | undefined {
  const trimmed = maskLine(line).text.trimStart();
  if (/^(?:Процедура|Функция|procedure|function)(?=\s|\()/iu.test(trimmed)) {
    return 'start';
  }
  if (/^(?:КонецПроцедуры|КонецФункции|endprocedure|endfunction)(?=\s|;|$)/iu.test(trimmed)) {
    return 'end';
  }
  return undefined;
}

const CATALOG_OBJECT_CREATORS = new Set([
  'СоздатьЭлемент', 'CreateItem', 'СоздатьГруппу', 'CreateFolder',
].map(normalizeIdentifier));
const CATALOG_REFERENCE_FINDERS = new Set([
  'НайтиПоКоду', 'FindByCode', 'НайтиПоНаименованию', 'FindByDescription',
  'НайтиПоРеквизиту', 'FindByAttribute', 'ПолучитьСсылку', 'GetRef', 'ПустаяСсылка', 'EmptyRef',
].map(normalizeIdentifier));

function matchingCallClose(source: string, openingIndex: number): number | undefined {
  let depth = 0;
  for (let index = openingIndex; index < source.length; index += 1) {
    if (source[index] === '(') {
      depth += 1;
    } else if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function catalogObjectFromExpression(expression: string): string | undefined {
  const call = /^\s*(?:Справочники|Catalogs)\s*\.\s*([\p{L}_][\p{L}\p{N}_]*)\s*\.\s*([\p{L}_][\p{L}\p{N}_]*)\s*\(/iu.exec(expression);
  if (!call) {
    return undefined;
  }
  const openingIndex = call[0].lastIndexOf('(');
  const closingIndex = matchingCallClose(expression, openingIndex);
  if (closingIndex === undefined) {
    return undefined;
  }
  const suffix = expression.slice(closingIndex + 1).trim();
  const hasGetObject = /^(?:\.\s*(?:ПолучитьОбъект|GetObject)\s*\(\s*\))$/iu.test(suffix);
  if (suffix !== '' && !hasGetObject) {
    return undefined;
  }
  const method = normalizeIdentifier(call[2]);
  if (CATALOG_OBJECT_CREATORS.has(method) && !hasGetObject) {
    return call[1];
  }
  return CATALOG_REFERENCE_FINDERS.has(method) && hasGetObject ? call[1] : undefined;
}

function inferredTypeForReceiver(
  document: vscode.TextDocument,
  position: vscode.Position,
  currentLinePrefix: string,
  receiver: string,
): ReceiverInference {
  if (currentLinePrefix.length > MAX_CONTEXT_CHARS) {
    return { assigned: false };
  }
  const reverseLines = [currentLinePrefix];
  let characters = currentLinePrefix.length;
  let foundProcedureStart = false;
  const firstLine = position.line;
  const oldestLine = Math.max(0, firstLine - MAX_CONTEXT_LINES + 1);
  for (let lineNumber = firstLine - 1; lineNumber >= oldestLine; lineNumber -= 1) {
    const line = document.lineAt(lineNumber).text;
    if (characters + line.length + 1 > MAX_CONTEXT_CHARS) {
      break;
    }
    reverseLines.push(line);
    characters += line.length + 1;
    const boundary = currentProcedureBoundary(line);
    if (boundary === 'end') {
      return { assigned: false };
    }
    if (boundary === 'start') {
      foundProcedureStart = true;
      break;
    }
  }
  if (!foundProcedureStart) {
    return { assigned: false };
  }

  const assignments = new Map<string, string>();
  const catalogObjects = new Map<string, string>();
  const assignedVariables = new Set<string>();
  for (const rawLine of reverseLines.reverse()) {
    const line = maskLine(rawLine).text;
    for (const statement of line.split(';')) {
      const assignment = /^\s*([\p{L}_][\p{L}\p{N}_]*)\s*=\s*([\s\S]*)$/u.exec(statement);
      if (!assignment) {
        continue;
      }
      const variable = normalizeIdentifier(assignment[1]);
      assignedVariables.add(variable);
      const catalogObjectName = catalogObjectFromExpression(assignment[2]);
      const constructor = /^\s*(?:Новый|New)\s+([\p{L}_][\p{L}\p{N}_]*)\s*\(/iu.exec(assignment[2]);
      if (catalogObjectName) {
        catalogObjects.set(variable, catalogObjectName);
        assignments.delete(variable);
      } else if (constructor) {
        assignments.set(variable, normalizeIdentifier(constructor[1]));
        catalogObjects.delete(variable);
      } else {
        assignments.delete(variable);
        catalogObjects.delete(variable);
      }
    }
  }
  const normalizedReceiver = normalizeIdentifier(receiver);
  const typeName = assignments.get(normalizedReceiver);
  const catalogObjectName = catalogObjects.get(normalizedReceiver);
  return {
    ...(typeName ? { typeName } : {}),
    ...(catalogObjectName ? { catalogObjectName } : {}),
    assigned: assignedVariables.has(normalizedReceiver),
  };
}

function matchingCandidates(
  prefix: string,
  all: readonly Candidate[],
  byFirstCharacter: ReadonlyMap<string, readonly Candidate[]>,
): Candidate[] {
  const foldedPrefix = normalizeIdentifier(prefix);
  const candidates = foldedPrefix
    ? byFirstCharacter.get(firstCharacter(foldedPrefix)) ?? []
    : all;
  return candidates.filter(({ name }) => normalizeIdentifier(name).startsWith(foldedPrefix));
}

function callInsertText(name: string, zeroArgument: boolean, hasFollowingOpenParen: boolean): vscode.SnippetString | string {
  if (hasFollowingOpenParen) {
    return name;
  }
  return new vscode.SnippetString(zeroArgument ? `${name}()$0` : `${name}($0)`);
}

function toCompletionItem(candidate: Candidate, hasFollowingOpenParen = false): vscode.CompletionItem {
  const kind = candidate.kind === 'method'
    ? vscode.CompletionItemKind.Method
    : candidate.kind === 'property'
      ? vscode.CompletionItemKind.Property
      : vscode.CompletionItemKind.Class;
  const item = new vscode.CompletionItem(candidate.name, kind);
  item.insertText = candidate.kind === 'method'
    ? callInsertText(candidate.name, candidate.zeroArgument === true, hasFollowingOpenParen)
    : candidate.name;
  item.detail = candidate.kind === 'method'
    ? `Метод платформы • ${candidate.article.name}`
    : candidate.kind === 'property'
      ? `Свойство платформы • ${candidate.article.name}`
      : 'Тип платформы с конструктором';
  item.documentation = `Статья справки платформы: «${candidate.article.name}» (syntax:${candidate.article.id}, ${candidate.article.path}).`;
  item.sortText = normalizeIdentifier(candidate.name);
  return item;
}

function hasUnsafeParameterControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code <= 8) || (code >= 14 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

function toLocalRoutineCompletionItem(
  candidate: BslLocalRoutineCandidate,
  sourceLabel: string,
  hasFollowingOpenParen = false,
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    candidate.name,
    candidate.kind === 'function' ? vscode.CompletionItemKind.Function : vscode.CompletionItemKind.Method,
  );
  item.insertText = callInsertText(candidate.name, candidate.parameterText.trim() === '', hasFollowingOpenParen);
  const kindLabel = candidate.kind === 'function' ? 'Функция' : 'Процедура';
  const parameterText = candidate.parameterText;
  const safeParameterText = parameterText.length <= 160
    && !hasUnsafeParameterControlCharacters(parameterText)
    ? parameterText.replace(/\s+/gu, ' ').trim()
    : '';
  item.detail = safeParameterText
    ? `${kindLabel} • ${sourceLabel} • Параметры: ${safeParameterText}`
    : `${kindLabel} • ${sourceLabel}`;
  item.sortText = normalizeIdentifier(candidate.name);
  return item;
}

function toMetadataCompletionItem(name: string, folderId: string): vscode.CompletionItem {
  const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
  item.insertText = name;
  item.detail = `Объект метаданных • ${folderId}`;
  item.sortText = normalizeIdentifier(name);
  return item;
}

function toCommonModuleCompletionItem(name: string): vscode.CompletionItem {
  const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Module);
  item.insertText = name;
  item.detail = 'Общий модуль метаданных';
  item.sortText = normalizeIdentifier(name);
  return item;
}

function metadataFolderForReceiver(receiver: string, index: RuntimeIndex): string | undefined {
  return index.metadataCollectionFolders.get(normalizeIdentifier(receiver));
}

function isLoadedCatalogNameAvailable(
  document: vscode.TextDocument,
  catalogName: string,
  readerProvider: MetadataCompletionReaderProvider | undefined,
): boolean {
  const resourcePath = document.uri?.scheme === 'file' ? document.uri.fsPath : '';
  if (!resourcePath) {
    return true;
  }
  try {
    const result = readerProvider?.()?.getLoadedTypeObjectsForResource(resourcePath, 'Catalogs');
    return result?.status !== 'loaded'
      || result.names.some((name) => normalizeIdentifier(name) === normalizeIdentifier(catalogName));
  } catch {
    return true;
  }
}

function catalogObjectModuleName(document: vscode.TextDocument): string | undefined {
  const filePath = document.uri?.scheme === 'file' ? document.uri.fsPath : '';
  if (!filePath) {
    return undefined;
  }
  const parts = path.resolve(filePath).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (normalizeIdentifier(parts[index]) !== 'catalogs') {
      continue;
    }
    const catalogName = parts[index + 1];
    const designerModule = normalizeIdentifier(parts[index + 2] ?? '') === 'ext'
      && normalizeIdentifier(parts[index + 3] ?? '') === 'objectmodule.bsl'
      && index + 4 === parts.length;
    const edtModule = normalizeIdentifier(parts[index + 2] ?? '') === 'objectmodule.bsl'
      && index + 3 === parts.length;
    if ((designerModule || edtModule) && IDENTIFIER_FOR_METADATA.test(catalogName)) {
      return catalogName;
    }
  }
  return undefined;
}

const IDENTIFIER_FOR_METADATA = /^[\p{L}_][\p{L}\p{N}_]*$/u;

function isThisObjectReceiver(receiver: string): boolean {
  const normalized = normalizeIdentifier(receiver);
  return normalized === normalizeIdentifier('ЭтотОбъект') || normalized === 'thisobject';
}

function localRoutineCompletionItems(
  prefix: string,
  routines: readonly BslLocalRoutineCandidate[],
  sourceLabel: string,
  hasFollowingOpenParen = false,
): vscode.CompletionItem[] {
  const foldedPrefix = normalizeIdentifier(prefix);
  return routines
    .filter(({ name }) => normalizeIdentifier(name).startsWith(foldedPrefix))
    .map((routine) => toLocalRoutineCompletionItem(routine, sourceLabel, hasFollowingOpenParen));
}

function metadataCompletionItems(prefix: string, names: readonly string[], folderId: string): vscode.CompletionItem[] {
  const foldedPrefix = normalizeIdentifier(prefix);
  return names
    .filter((name) => normalizeIdentifier(name).startsWith(foldedPrefix))
    .map((name) => toMetadataCompletionItem(name, folderId));
}

function commonModuleCompletionItems(prefix: string, names: readonly string[]): vscode.CompletionItem[] {
  const foldedPrefix = normalizeIdentifier(prefix);
  const seen = new Set<string>();
  const items: vscode.CompletionItem[] = [];
  for (const name of names) {
    const key = normalizeIdentifier(name);
    if (!key.startsWith(foldedPrefix) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push(toCommonModuleCompletionItem(name));
  }
  return items;
}

function keywordCompletionItems(prefix: string, language: BslCompletionLanguage): vscode.CompletionItem[] {
  const foldedPrefix = normalizeIdentifier(prefix);
  const keywords = language === 'en' ? ENGLISH_BSL_KEYWORDS : RUSSIAN_BSL_KEYWORDS;
  return [...keywords, ...SHARED_BSL_KEYWORDS]
    .filter((name) => normalizeIdentifier(name).startsWith(foldedPrefix))
    .map((name) => {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Keyword);
      item.insertText = name;
      item.detail = 'Ключевое слово BSL';
      item.sortText = `0_${normalizeIdentifier(name)}`;
      return item;
    });
}

function globalCompletionItems(
  prefix: string,
  platformCandidates: readonly Candidate[],
  localRoutines: readonly BslLocalRoutineCandidate[],
  commonModuleNames: readonly string[],
  language: BslCompletionLanguage,
  hasFollowingOpenParen = false,
): vscode.CompletionItem[] {
  const candidates = [
    ...keywordCompletionItems(prefix, language),
    ...platformCandidates.map((candidate) => toCompletionItem(candidate, hasFollowingOpenParen)),
    ...localRoutineCompletionItems(prefix, localRoutines, 'текущий модуль', hasFollowingOpenParen),
    ...commonModuleCompletionItems(prefix, commonModuleNames),
  ];
  const seen = new Set<string>();
  return candidates.filter(({ label }) => {
    const key = normalizeIdentifier(String(label));
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function catalogCompletionItems(
  prefix: string,
  candidates: readonly Candidate[],
  routines: readonly BslLocalRoutineCandidate[],
  sourceLabel: string,
  hasFollowingOpenParen: boolean,
): vscode.CompletionItem[] {
  const platformItems = matchingCandidates(prefix, candidates, groupByFirstCharacter(candidates));
  const seen = new Set(platformItems.map(({ name }) => normalizeIdentifier(name)));
  return [
    ...platformItems.map((candidate) => toCompletionItem(candidate, hasFollowingOpenParen)),
    ...localRoutineCompletionItems(prefix, routines, sourceLabel, hasFollowingOpenParen)
      .filter(({ label }) => {
        const key = normalizeIdentifier(String(label));
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      }),
  ];
}

function candidatesForType(type: BslCompletionType): Candidate[] {
  return [
    ...type.properties.map((name) => ({ name, kind: 'property' as const, article: type.article })),
    ...type.methods.map((name) => ({ name, kind: 'method' as const, article: type.article })),
  ];
}

export class BslCompletionProvider implements vscode.CompletionItemProvider {
  private loadedIndex: Promise<RuntimeIndex> | undefined;
  private readonly localIndex = new BslLocalCompletionIndex();

  constructor(
    private readonly extensionPath: string,
    private readonly getMetadataCompletionReader?: MetadataCompletionReaderProvider,
  ) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    _context: vscode.CompletionContext,
  ): Promise<vscode.CompletionItem[] | undefined> {
    if (token.isCancellationRequested) {
      return undefined;
    }
    if (position.character > MAX_CONTEXT_CHARS) {
      return [];
    }
    const currentLine = document.lineAt(position.line).text;
    if (isMultilineStringContinuationLine(currentLine)) {
      return undefined;
    }
    const character = Math.min(position.character, currentLine.length);
    const currentLinePrefix = currentLine.slice(0, character);
    const context = completionContext(currentLinePrefix);
    if (!context) {
      return undefined;
    }

    const hasFollowingOpenParen = currentLine[character] === '(';
    const resourcePath = document.uri?.scheme === 'file' ? document.uri.fsPath : '';
    let metadataReader: BslMetadataCompletionReader | undefined;
    if (resourcePath) {
      try {
        metadataReader = this.getMetadataCompletionReader?.() ?? undefined;
      } catch {
        // Metadata lookup is optional; completion defaults to Russian when the reader is unavailable.
      }
    }
    let language: BslCompletionLanguage = 'ru';
    try {
      language = metadataReader?.getLanguageForResource?.(resourcePath) === 'en' ? 'en' : 'ru';
    } catch {
      language = 'ru';
    }
    let commonModuleNames: readonly string[] = [];
    if (context.kind === 'global') {
      if (resourcePath) {
        try {
          const result = metadataReader?.getLoadedTypeObjectsForResource(resourcePath, 'CommonModules');
          if (result?.status === 'loaded') {
            commonModuleNames = result.names;
          }
        } catch {
          // Tree lookup is read-only and optional; keep keyword/platform completion available on failure.
        }
      }
    }

    let inferredTypeName = context.typeName;
    let catalogName = context.metadataObjectName;
    let catalogRole: 'manager' | 'object' | undefined = context.metadataObjectName ? 'manager' : undefined;
    let currentCatalogObjectModule = false;
    if (context.kind === 'member' && !catalogRole && !inferredTypeName) {
      const receiver = context.receiver;
      if (receiver && isThisObjectReceiver(receiver)) {
        catalogName = catalogObjectModuleName(document);
        if (!catalogName) {
          return [];
        }
        catalogRole = 'object';
        currentCatalogObjectModule = true;
      } else {
        let metadataFolder: string | undefined;
        if (receiver) {
          let index: RuntimeIndex | undefined;
          try {
            index = await (this.loadedIndex ??= loadBslCompletionIndex(this.extensionPath));
          } catch {
            this.loadedIndex = undefined;
          }
          if (token.isCancellationRequested) {
            return undefined;
          }
          if (index) {
            metadataFolder = metadataFolderForReceiver(receiver, index);
          }
        }
        if (metadataFolder) {
          if (!resourcePath || token.isCancellationRequested) {
            return token.isCancellationRequested ? undefined : [];
          }
          try {
            const result = metadataReader?.getLoadedTypeObjectsForResource(resourcePath, metadataFolder);
            if (token.isCancellationRequested) {
              return undefined;
            }
            return result?.status === 'loaded'
              ? metadataCompletionItems(context.prefix, result.names, metadataFolder)
              : [];
          } catch {
            return [];
          }
        }
        const receiverInference = receiver
          ? inferredTypeForReceiver(document, position, currentLinePrefix, receiver)
          : { assigned: false };
        inferredTypeName = receiverInference.typeName;
        if (receiverInference.catalogObjectName) {
          catalogName = receiverInference.catalogObjectName;
          catalogRole = 'object';
        }
        if (!inferredTypeName && !catalogRole) {
          if (!receiver || receiverInference.assigned) {
            return [];
          }
          if (token.isCancellationRequested) {
            return undefined;
          }
          const routines = await this.localIndex.getCommonModuleRoutines(document, receiver, token);
          if (token.isCancellationRequested) {
            return undefined;
          }
          return localRoutineCompletionItems(context.prefix, routines, `Общий модуль ${receiver}`, hasFollowingOpenParen);
        }
      }
    }

    try {
      const index = await (this.loadedIndex ??= loadBslCompletionIndex(this.extensionPath));
      if (token.isCancellationRequested) {
        return undefined;
      }
      if (context.kind === 'global') {
        const platformCandidates = matchingCandidates(
          context.prefix,
          index.globalCandidatesByLanguage[language],
          index.globalCandidatesByFirstCharacterByLanguage[language],
        );
        return globalCompletionItems(
          context.prefix,
          platformCandidates,
          this.localIndex.getCurrentDocumentRoutines(document),
          commonModuleNames,
          language,
          hasFollowingOpenParen,
        );
      }
      if (context.kind === 'type') {
        return matchingCandidates(
          context.prefix,
          index.typeCandidatesByLanguage[language],
          index.typeCandidatesByFirstCharacterByLanguage[language],
        )
          .map((candidate) => toCompletionItem(candidate, hasFollowingOpenParen));
      }
      if (catalogRole && catalogName) {
        if (!index.catalogApiAvailable || !isLoadedCatalogNameAvailable(document, catalogName, this.getMetadataCompletionReader)) {
          return [];
        }
        const routines = catalogRole === 'object' && currentCatalogObjectModule
          ? this.localIndex.getCurrentDocumentRoutines(document).filter(({ exported }) => exported)
          : await this.localIndex.getCatalogModuleRoutines(
            document,
            catalogName,
            catalogRole === 'manager' ? 'ManagerModule' : 'ObjectModule',
            token,
          );
        if (token.isCancellationRequested) {
          return undefined;
        }
        const candidates = catalogRole === 'manager'
          ? index.catalogManagerCandidatesByLanguage[language]
          : index.catalogObjectCandidatesByLanguage[language];
        return catalogCompletionItems(
          context.prefix,
          candidates,
          routines,
          `модуль ${catalogRole === 'manager' ? 'менеджера' : 'объекта'} справочника ${catalogName}`,
          hasFollowingOpenParen,
        );
      }
      const types = index.typesByAlias.get(normalizeIdentifier(inferredTypeName ?? ''));
      if (!types || types.length !== 1) {
        return [];
      }
      const members = filterCandidatesForLanguage(
        uniqueCandidates(candidatesForType(types[0])),
        types[0].memberLanguageAliases,
        language,
      );
      return matchingCandidates(context.prefix, members, groupByFirstCharacter(members))
        .map((candidate) => toCompletionItem(candidate, hasFollowingOpenParen));
    } catch {
      this.loadedIndex = undefined;
      if (token.isCancellationRequested) {
        return undefined;
      }
      return context.kind === 'global'
        ? globalCompletionItems(context.prefix, [], [], commonModuleNames, language, hasFollowingOpenParen)
        : undefined;
    }
  }
}

/** Registers and tracks the BSL completion provider for extension deactivation. */
export function registerBslCompletionProvider(
  context: Pick<vscode.ExtensionContext, 'subscriptions'>,
  extensionPath: string,
  getMetadataCompletionReader?: MetadataCompletionReaderProvider,
): vscode.Disposable {
  const disposable = vscode.languages.registerCompletionItemProvider(
    { language: 'bsl' },
    new BslCompletionProvider(extensionPath, getMetadataCompletionReader),
    '.',
  );
  context.subscriptions.push(disposable);
  return disposable;
}
