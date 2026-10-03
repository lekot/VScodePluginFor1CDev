import { METADATA_TYPE_DESCRIPTORS } from '../constants/metadataTypeDescriptors';

export interface CompletionArticleReference {
  readonly id: number;
  readonly name: string;
  readonly path: string;
}

export interface BslCompletionAliasPair {
  readonly russian: string;
  readonly english: string;
}

/** Alias provenance used to hide only the opposite side of known bilingual pairs. */
export interface BslCompletionLanguageAliases {
  /** [Russian alias index, English alias index] in the owning candidate list. */
  readonly bilingualPairIndices: readonly (readonly [number, number])[];
}

interface ParsedBslCompletionLanguageAliases {
  readonly bilingualPairs: readonly BslCompletionAliasPair[];
  readonly unpairedAliases: readonly string[];
}

export interface BslCompletionType {
  readonly aliases: readonly string[];
  readonly aliasLanguageAliases: BslCompletionLanguageAliases;
  readonly article: CompletionArticleReference;
  readonly properties: readonly string[];
  readonly methods: readonly string[];
  readonly memberLanguageAliases: BslCompletionLanguageAliases;
}

export interface BslCompletionMetadataMembers {
  readonly article: CompletionArticleReference;
  readonly properties: readonly string[];
  readonly methods: readonly string[];
  readonly languageAliases: BslCompletionLanguageAliases;
}

export interface BslCompletionCatalogApi {
  readonly folderId: 'Catalogs';
  readonly manager: BslCompletionMetadataMembers;
  readonly object: BslCompletionMetadataMembers;
}

export interface BslCompletionMetadataCollection {
  readonly aliases: readonly string[];
  readonly folderId: string;
}

export interface BslCompletionIndex {
  readonly sourceSha256: string;
  readonly global: {
    readonly article: CompletionArticleReference;
    readonly properties: readonly string[];
    readonly methods: readonly string[];
    readonly zeroArgumentMethods: readonly string[];
    readonly languageAliases: BslCompletionLanguageAliases;
  };
  readonly types: readonly BslCompletionType[];
  readonly metadataCollections: readonly BslCompletionMetadataCollection[];
  readonly catalogApi?: BslCompletionCatalogApi;
}

export interface SyntaxHelpDatabaseNodeForIndex {
  readonly id: number;
  readonly name: string;
  readonly path: string;
  readonly content: string;
}

type SectionName = 'properties' | 'methods' | 'constructors';

export interface ParsedCompletionSections {
  readonly properties: readonly string[];
  readonly methods: readonly string[];
  readonly hasConstructors: boolean;
  readonly propertyLanguageAliases: ParsedBslCompletionLanguageAliases;
  readonly methodLanguageAliases: ParsedBslCompletionLanguageAliases;
}

const identifierPattern = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const ZERO_ARGUMENT_GLOBAL_METHODS = new Set(['CurrentDate', 'ТекущаяДата'].map(normalizeIdentifier));
const CATALOG_API_ARTICLES = {
  manager: { id: 1647, path: 'catalog125/catalog126/object128.html' },
  object: { id: 1648, path: 'catalog125/catalog126/object130.html' },
} as const;
const sectionPatterns: ReadonlyArray<{ section: SectionName; pattern: RegExp }> = [
  { section: 'properties', pattern: /^(?:Свойства|Properties)\s*:\s*$/iu },
  { section: 'methods', pattern: /^(?:Методы|Methods)\s*:\s*$/iu },
  { section: 'constructors', pattern: /^(?:Конструкторы|Constructors)\s*:\s*$/iu },
];

function normalizeIdentifier(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('ru-RU');
}

function identifierLanguage(value: string): 'ru' | 'en' | undefined {
  const hasCyrillic = /\p{Script=Cyrillic}/u.test(value);
  const hasLatin = /\p{Script=Latin}/u.test(value);
  return hasCyrillic === hasLatin ? undefined : hasCyrillic ? 'ru' : 'en';
}

function compareFolded(left: string, right: string): number {
  const foldedLeft = normalizeIdentifier(left);
  const foldedRight = normalizeIdentifier(right);
  return foldedLeft < foldedRight ? -1 : foldedLeft > foldedRight ? 1 : left < right ? -1 : left > right ? 1 : 0;
}

function normalizeArticleText(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article)\s*>/gi, '\n')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&');
}

function parseAliasLine(line: string): { aliases: string[]; pair?: BslCompletionAliasPair } {
  const trimmed = line.trim();
  if (!trimmed) {
    return { aliases: [] };
  }
  const aliasMatch = /^(.*?)\s*\(([^()]*)\)\s*$/u.exec(trimmed);
  const aliases = aliasMatch
    ? [aliasMatch[1].trim(), aliasMatch[2].trim()]
    : [trimmed];
  const seen = new Set<string>();
  const validAliases = aliases.filter((alias) => {
    if (!identifierPattern.test(alias)) {
      return false;
    }
    const folded = normalizeIdentifier(alias);
    if (seen.has(folded)) {
      return false;
    }
    seen.add(folded);
    return true;
  });
  if (validAliases.length === 2) {
    const firstLanguage = identifierLanguage(validAliases[0]);
    const secondLanguage = identifierLanguage(validAliases[1]);
    if (firstLanguage === 'ru' && secondLanguage === 'en') {
      return { aliases: validAliases, pair: { russian: validAliases[0], english: validAliases[1] } };
    }
    if (firstLanguage === 'en' && secondLanguage === 'ru') {
      return { aliases: validAliases, pair: { russian: validAliases[1], english: validAliases[0] } };
    }
  }
  return { aliases: validAliases };
}

function parseAliases(line: string): string[] {
  return parseAliasLine(line).aliases;
}

function sectionFor(line: string): SectionName | undefined {
  const heading = line.trim();
  return sectionPatterns.find(({ pattern }) => pattern.test(heading))?.section;
}

function isOtherHeading(line: string): boolean {
  return /^[\p{L}][\p{L}\p{N} _-]*:\s*$/u.test(line.trim());
}

/** Parses the explicit article sections; placeholders and non-identifiers are discarded. */
export function parseCompletionSections(content: string): ParsedCompletionSections {
  let activeSection: SectionName | undefined;
  let hasConstructors = false;
  const values: Record<SectionName, string[]> = {
    properties: [],
    methods: [],
    constructors: [],
  };
  const seen: Record<SectionName, Set<string>> = {
    properties: new Set(),
    methods: new Set(),
    constructors: new Set(),
  };
  const pairs: Record<SectionName, BslCompletionAliasPair[]> = {
    properties: [],
    methods: [],
    constructors: [],
  };
  const unpairedAliases: Record<SectionName, string[]> = {
    properties: [],
    methods: [],
    constructors: [],
  };

  for (const line of normalizeArticleText(content).split('\n')) {
    const heading = sectionFor(line);
    if (heading) {
      activeSection = heading;
      hasConstructors ||= heading === 'constructors';
      continue;
    }
    if (activeSection && isOtherHeading(line)) {
      activeSection = undefined;
      continue;
    }
    if (!activeSection) {
      continue;
    }
    const parsedLine = parseAliasLine(line);
    if (parsedLine.pair) {
      pairs[activeSection].push(parsedLine.pair);
    } else {
      unpairedAliases[activeSection].push(...parsedLine.aliases);
    }
    for (const name of parsedLine.aliases) {
      const folded = normalizeIdentifier(name);
      if (!seen[activeSection].has(folded)) {
        seen[activeSection].add(folded);
        values[activeSection].push(name);
      }
    }
  }

  return {
    properties: values.properties,
    methods: values.methods,
    hasConstructors,
    propertyLanguageAliases: languageAliases(pairs.properties, unpairedAliases.properties),
    methodLanguageAliases: languageAliases(pairs.methods, unpairedAliases.methods),
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of values) {
    const key = normalizeIdentifier(value);
    if (!unique.has(key)) {
      unique.set(key, value);
    }
  }
  return [...unique.values()].sort(compareFolded);
}

function languageAliases(
  pairs: readonly BslCompletionAliasPair[],
  unpairedAliases: readonly string[],
): ParsedBslCompletionLanguageAliases {
  const uniquePairs = new Map<string, BslCompletionAliasPair>();
  for (const pair of pairs) {
    const key = `${normalizeIdentifier(pair.russian)}\u0000${normalizeIdentifier(pair.english)}`;
    if (!uniquePairs.has(key)) {
      uniquePairs.set(key, pair);
    }
  }
  const unpaired = new Set(unpairedAliases.map(normalizeIdentifier));
  const bilingualPairs = [...uniquePairs.values()]
    .filter(({ russian, english }) => !unpaired.has(normalizeIdentifier(russian))
      && !unpaired.has(normalizeIdentifier(english)))
    .sort((left, right) => compareFolded(left.russian, right.russian) || compareFolded(left.english, right.english));
  return { bilingualPairs, unpairedAliases: uniqueSorted(unpairedAliases) };
}

function combineLanguageAliases(...entries: readonly ParsedBslCompletionLanguageAliases[]): ParsedBslCompletionLanguageAliases {
  return languageAliases(
    entries.flatMap(({ bilingualPairs }) => bilingualPairs),
    entries.flatMap(({ unpairedAliases }) => unpairedAliases),
  );
}

function aliasLanguageAliases(aliasLine: string): ParsedBslCompletionLanguageAliases {
  const parsed = parseAliasLine(aliasLine);
  return languageAliases(parsed.pair ? [parsed.pair] : [], parsed.pair ? [] : parsed.aliases);
}

function candidateAliasOrder(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const name of lists.flat()) {
    const key = normalizeIdentifier(name);
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

function indexLanguageAliases(
  aliases: ParsedBslCompletionLanguageAliases,
  aliasOrder: readonly string[],
): BslCompletionLanguageAliases {
  const positions = new Map(aliasOrder.map((name, index) => [normalizeIdentifier(name), index]));
  return {
    bilingualPairIndices: aliases.bilingualPairs.flatMap(({ russian, english }) => {
      const russianIndex = positions.get(normalizeIdentifier(russian));
      const englishIndex = positions.get(normalizeIdentifier(english));
      return russianIndex === undefined || englishIndex === undefined
        ? []
        : [[russianIndex, englishIndex] as const];
    }),
  };
}

function metadataCollectionsFromGlobalProperties(content: string): BslCompletionMetadataCollection[] {
  const descriptorsByFolder = new Map(
    METADATA_TYPE_DESCRIPTORS.map((descriptor) => [normalizeIdentifier(descriptor.designerFolder), descriptor]),
  );
  const collectionsByFolder = new Map<string, BslCompletionMetadataCollection>();
  let activeSection: SectionName | undefined;

  for (const line of normalizeArticleText(content).split('\n')) {
    const heading = sectionFor(line);
    if (heading) {
      activeSection = heading;
      continue;
    }
    if (activeSection && isOtherHeading(line)) {
      activeSection = undefined;
      continue;
    }
    if (activeSection !== 'properties') {
      continue;
    }

    const aliases = parseAliases(line);
    const descriptor = aliases
      .map((alias) => descriptorsByFolder.get(normalizeIdentifier(alias)))
      .find((match) => match !== undefined);
    if (!descriptor) {
      continue;
    }

    const key = normalizeIdentifier(descriptor.designerFolder);
    if (!collectionsByFolder.has(key)) {
      collectionsByFolder.set(key, {
        aliases,
        folderId: descriptor.designerFolder,
      });
    }
  }

  return [...collectionsByFolder.values()]
    .sort((left, right) => compareFolded(left.folderId, right.folderId));
}

/** Shared deterministic parser used by the offline generator and index contract tests. */
export function buildBslCompletionIndex(
  nodes: readonly SyntaxHelpDatabaseNodeForIndex[],
  sourceSha256: string,
): BslCompletionIndex {
  const globalNode = nodes.find(({ id }) => id === 1);
  if (!globalNode) {
    throw new Error('The platform syntax database has no global context article (id 1).');
  }
  const globalSections = parseCompletionSections(globalNode.content);
  const globalProperties = uniqueSorted(globalSections.properties);
  const globalMethods = uniqueSorted(globalSections.methods);
  const globalAliasOrder = candidateAliasOrder(globalProperties, globalMethods);
  const metadataCollections = metadataCollectionsFromGlobalProperties(globalNode.content);
  const catalogApi = catalogApiFromNodes(nodes);
  const types = nodes.flatMap((node): BslCompletionType[] => {
    const sections = parseCompletionSections(node.content);
    if (!sections.hasConstructors) {
      return [];
    }
    const articleAliases = parseAliases(node.name);
    if (articleAliases.length === 0) {
      return [];
    }
    const properties = uniqueSorted(sections.properties);
    const methods = uniqueSorted(sections.methods);
    return [{
      aliases: articleAliases,
      aliasLanguageAliases: indexLanguageAliases(aliasLanguageAliases(node.name), articleAliases),
      article: { id: node.id, name: node.name, path: node.path },
      properties,
      methods,
      memberLanguageAliases: indexLanguageAliases(combineLanguageAliases(
        sections.propertyLanguageAliases,
        sections.methodLanguageAliases,
      ), candidateAliasOrder(properties, methods)),
    }];
  });
  types.sort((left, right) => compareFolded(left.article.name, right.article.name) || left.article.id - right.article.id);
  return {
    sourceSha256,
    global: {
      article: { id: globalNode.id, name: globalNode.name, path: globalNode.path },
      properties: globalProperties,
      methods: globalMethods,
      zeroArgumentMethods: uniqueSorted(globalSections.methods.filter((name) =>
        ZERO_ARGUMENT_GLOBAL_METHODS.has(normalizeIdentifier(name)))),
      languageAliases: indexLanguageAliases(combineLanguageAliases(
        globalSections.propertyLanguageAliases,
        globalSections.methodLanguageAliases,
      ), globalAliasOrder),
    },
    types,
    metadataCollections,
    ...(catalogApi ? { catalogApi } : {}),
  };
}

function catalogApiFromNodes(nodes: readonly SyntaxHelpDatabaseNodeForIndex[]): BslCompletionCatalogApi | undefined {
  const managerNode = nodes.find(({ id }) => id === CATALOG_API_ARTICLES.manager.id);
  const objectNode = nodes.find(({ id }) => id === CATALOG_API_ARTICLES.object.id);
  if (!managerNode && !objectNode) {
    return undefined;
  }
  if (!managerNode || !objectNode
    || managerNode.path.replace(/\\/g, '/') !== CATALOG_API_ARTICLES.manager.path
    || objectNode.path.replace(/\\/g, '/') !== CATALOG_API_ARTICLES.object.path) {
    throw new Error('The platform syntax database has unexpected CatalogManager/CatalogObject articles.');
  }
  const members = (node: SyntaxHelpDatabaseNodeForIndex): BslCompletionMetadataMembers => {
    const sections = parseCompletionSections(node.content);
    const properties = uniqueSorted(sections.properties);
    const methods = uniqueSorted(sections.methods);
    return {
      article: { id: node.id, name: node.name, path: node.path.replace(/\\/g, '/') },
      properties,
      methods,
      languageAliases: indexLanguageAliases(combineLanguageAliases(
        sections.propertyLanguageAliases,
        sections.methodLanguageAliases,
      ), candidateAliasOrder(properties, methods)),
    };
  };
  return {
    folderId: 'Catalogs',
    manager: members(managerNode),
    object: members(objectNode),
  };
}

function isArticleReference(value: unknown): value is CompletionArticleReference {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const article = value as Partial<CompletionArticleReference>;
  return Number.isSafeInteger(article.id) && (article.id ?? 0) > 0
    && typeof article.name === 'string' && article.name.length > 0
    && typeof article.path === 'string' && article.path.length > 0;
}

function isIdentifierList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && identifierPattern.test(entry));
}

function aliasCandidateOrder(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const name of lists.flat()) {
    const key = normalizeIdentifier(name);
    if (!seen.has(key)) {
      seen.add(key);
      aliases.push(name);
    }
  }
  return aliases;
}

function isBslCompletionLanguageAliases(
  value: unknown,
  candidateNames: readonly string[],
): value is BslCompletionLanguageAliases {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const aliases = value as Partial<BslCompletionLanguageAliases>;
  if (!Array.isArray(aliases.bilingualPairIndices)) {
    return false;
  }
  const seenPairs = new Set<string>();
  for (const pair of aliases.bilingualPairIndices) {
    if (!Array.isArray(pair) || pair.length !== 2
      || !Number.isSafeInteger(pair[0]) || pair[0] < 0 || pair[0] >= candidateNames.length
      || !Number.isSafeInteger(pair[1]) || pair[1] < 0 || pair[1] >= candidateNames.length
      || pair[0] === pair[1]) {
      return false;
    }
    const russian = candidateNames[pair[0]];
    const english = candidateNames[pair[1]];
    if (identifierLanguage(russian) !== 'ru' || identifierLanguage(english) !== 'en') {
      return false;
    }
    const key = `${pair[0]}\u0000${pair[1]}`;
    if (seenPairs.has(key)) {
      return false;
    }
    seenPairs.add(key);
  }
  return true;
}

function isMetadataCollectionList(value: unknown): value is readonly BslCompletionMetadataCollection[] {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }

  const knownFolderIds = new Set(METADATA_TYPE_DESCRIPTORS.map(({ designerFolder }) => designerFolder));
  const seenFolderIds = new Set<string>();
  const seenAliases = new Set<string>();
  return value.every((entry) => {
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    const collection = entry as Partial<BslCompletionMetadataCollection>;
    if (typeof collection.folderId !== 'string' || !knownFolderIds.has(collection.folderId)
      || seenFolderIds.has(normalizeIdentifier(collection.folderId))
      || !isIdentifierList(collection.aliases) || collection.aliases.length === 0) {
      return false;
    }

    const collectionAliases = new Set<string>();
    for (const alias of collection.aliases) {
      const normalizedAlias = normalizeIdentifier(alias);
      if (collectionAliases.has(normalizedAlias) || seenAliases.has(normalizedAlias)) {
        return false;
      }
      collectionAliases.add(normalizedAlias);
    }
    if (!collectionAliases.has(normalizeIdentifier(collection.folderId))) {
      return false;
    }

    seenFolderIds.add(normalizeIdentifier(collection.folderId));
    for (const alias of collectionAliases) {
      seenAliases.add(alias);
    }
    return true;
  });
}

/** Performs a cheap structural check before trusting the bundled JSON resource. */
export function isBslCompletionIndex(value: unknown): value is BslCompletionIndex {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const index = value as Partial<BslCompletionIndex>;
  const global = index.global;
  if (!(typeof index.sourceSha256 === 'string' && /^[a-f0-9]{64}$/.test(index.sourceSha256)
    && Boolean(global) && isArticleReference(global?.article)
    && isIdentifierList(global?.properties) && isIdentifierList(global?.methods)
    && isIdentifierList(global?.zeroArgumentMethods)
    && isBslCompletionLanguageAliases(global?.languageAliases,
      aliasCandidateOrder(global?.properties ?? [], global?.methods ?? []))
    && global?.zeroArgumentMethods.every((name) => global.methods.some((method) =>
      normalizeIdentifier(method) === normalizeIdentifier(name)))
    && isMetadataCollectionList(index.metadataCollections)
    && Array.isArray(index.types) && index.types.every((type) => Boolean(type)
      && isArticleReference(type.article)
      && isIdentifierList(type.aliases) && type.aliases.length > 0
      && isBslCompletionLanguageAliases(type.aliasLanguageAliases, type.aliases)
      && isIdentifierList(type.properties) && isIdentifierList(type.methods)
      && isBslCompletionLanguageAliases(type.memberLanguageAliases,
        aliasCandidateOrder(type.properties, type.methods))))) {
    return false;
  }
  const catalogApi = index.catalogApi;
  return catalogApi === undefined || Boolean(catalogApi)
    && catalogApi.folderId === 'Catalogs'
    && isArticleReference(catalogApi.manager?.article)
    && catalogApi.manager.article.id === CATALOG_API_ARTICLES.manager.id
    && catalogApi.manager.article.path === CATALOG_API_ARTICLES.manager.path
    && isIdentifierList(catalogApi.manager.properties) && isIdentifierList(catalogApi.manager.methods)
    && isBslCompletionLanguageAliases(catalogApi.manager.languageAliases,
      aliasCandidateOrder(catalogApi.manager.properties, catalogApi.manager.methods))
    && isArticleReference(catalogApi.object?.article)
    && catalogApi.object.article.id === CATALOG_API_ARTICLES.object.id
    && catalogApi.object.article.path === CATALOG_API_ARTICLES.object.path
    && isIdentifierList(catalogApi.object.properties) && isIdentifierList(catalogApi.object.methods)
    && isBslCompletionLanguageAliases(catalogApi.object.languageAliases,
      aliasCandidateOrder(catalogApi.object.properties, catalogApi.object.methods));
}
