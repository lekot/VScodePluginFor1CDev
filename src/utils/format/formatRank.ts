/**
 * Format-version parsing and write profiles for Designer XML.
 *
 * Reading remains permissive. Mutations are not: a version must be present on
 * the document root and belong to an explicitly supported write range. In
 * particular, an absent version must never become 2.17 before a write.
 */

export const FORMAT_VERIFIED_MIN = 217;
export const FORMAT_VERIFIED_MAX = 221;
/** Kept only for callers that intentionally need a sample version. */
export const DEFAULT_FORMAT_VERSION = '2.17';
export const DEFAULT_FORMAT_RANK = 217;

export interface FormatVersionInfo {
  version: string;
  rank: number;
  isVerified: boolean;
}

export interface WriteFormatProfile {
  /** Exact root `version` value, including an optional patch component. */
  version: string;
  rank: 217 | 218 | 219 | 220 | 221;
  hasTypeReductionMode: boolean;
  hasLineNumberLength: boolean;
  hasPalNamespace: boolean;
}

/** One user-facing error shared by UI commands and Agent/MCP operations. */
export class UnsupportedMetadataFormatError extends Error {
  readonly code = 'CDT_UNSUPPORTED_METADATA_WRITE_FORMAT';
  readonly userMessage: string;

  constructor(version: string | undefined, reason?: string) {
    const shownVersion = version?.trim() || 'не указан';
    const suffix = reason ? ` (${reason})` : '';
    super(
      `Запись метаданных остановлена: формат XML «${shownVersion}» не поддерживается. ` +
      'Поддерживается запись только для форматов 2.17–2.21; обновите расширение или откройте конфигурацию в совместимой версии платформы.' +
      suffix
    );
    this.name = 'UnsupportedMetadataFormatError';
    this.userMessage = this.message;
  }
}

/** Calculates a monotonic integer rank from `N.NN` or `N.NN.N`; malformed values yield zero. */
export function getFormatRank(versionStr: string | undefined | null): number {
  if (!versionStr) { return 0; }
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(versionStr.trim());
  if (!match) { return 0; }
  return parseInt(match[1], 10) * 100 + parseInt(match[2], 10);
}

/**
 * Legacy normalization helper. Mutation paths must call
 * {@link requireWriteFormatProfile} instead.
 */
export function normalizeFormatVersion(versionStr: string | undefined | null): string {
  return getFormatRank(versionStr) === 0 ? DEFAULT_FORMAT_VERSION : versionStr!.trim();
}

function getRootOpeningTag(xmlContent: string): string | undefined {
  // XML declaration and whitespace may precede the root. Do not search the
  // full body: a nested `version` is never project-format evidence.
  const withoutDeclaration = xmlContent.replace(/^\s*<\?xml\s+[\s\S]*?\?>\s*/i, '');
  return /^<([A-Za-z_][A-Za-z0-9_.:-]*)\b[^>]*>/i.exec(withoutDeclaration)?.[0];
}

function extractVersionFromRoot(xmlContent: string, expectedRoot?: string): string | undefined {
  const openTag = getRootOpeningTag(xmlContent);
  if (!openTag) { return undefined; }
  if (expectedRoot) {
    const rootMatch = /<([A-Za-z_][A-Za-z0-9_.:-]*)\b/i.exec(openTag);
    if (rootMatch?.[1]?.split(':').pop() !== expectedRoot) { return undefined; }
  }
  return /\bversion\s*=\s*["'](\d+\.\d+(?:\.\d+)?)["']/i.exec(openTag)?.[1];
}

/** Reads a format only from the XML root and never invents a default. */
export function detectFormatVersionFromXml(xmlContent: string): FormatVersionInfo {
  const version = extractVersionFromRoot(xmlContent);
  const rank = getFormatRank(version);
  return { version: version ?? '', rank, isVerified: rank >= FORMAT_VERIFIED_MIN && rank <= FORMAT_VERIFIED_MAX };
}

/** Strict project detector: only root `<MetaDataObject version="…">` is valid evidence. */
export function detectConfigurationFormatVersion(xmlContent: string): FormatVersionInfo {
  const version = extractVersionFromRoot(xmlContent, 'MetaDataObject');
  const rank = getFormatRank(version);
  return { version: version ?? '', rank, isVerified: rank >= FORMAT_VERIFIED_MIN && rank <= FORMAT_VERIFIED_MAX };
}

/** Converts an exact version to a write profile or throws before any mutation is planned. */
export function requireWriteFormatProfile(version: string | undefined | null): WriteFormatProfile {
  const normalized = version?.trim();
  const rank = getFormatRank(normalized);
  if (!normalized || !/^2\.\d+(?:\.\d+)?$/.test(normalized) || rank < FORMAT_VERIFIED_MIN || rank > FORMAT_VERIFIED_MAX) {
    throw new UnsupportedMetadataFormatError(normalized);
  }
  return {
    version: normalized,
    rank: rank as WriteFormatProfile['rank'],
    hasTypeReductionMode: rank >= 218,
    hasLineNumberLength: rank >= 220,
    hasPalNamespace: rank >= 221,
  };
}

/** Resolves a profile from Configuration.xml, fail-closed. */
export function requireProjectWriteFormatProfile(configurationXml: string): WriteFormatProfile {
  const info = detectConfigurationFormatVersion(configurationXml);
  if (!info.version) {
    throw new UnsupportedMetadataFormatError(undefined, 'в корне Configuration.xml нет корректного атрибута version');
  }
  return requireWriteFormatProfile(info.version);
}

/** Resolves a profile from any existing versioned child document, fail-closed. */
export function requireDocumentWriteFormatProfile(xml: string): WriteFormatProfile {
  const info = detectFormatVersionFromXml(xml);
  if (!info.version) {
    throw new UnsupportedMetadataFormatError(undefined, 'в корне XML-документа нет корректного атрибута version');
  }
  return requireWriteFormatProfile(info.version);
}

/** Constructs the canonical opening MetaDataObject tag for an already validated write profile. */
export function buildCanonicalMetaDataObjectOpenTag(
  version: string,
  options?: { hasPalNamespace?: boolean }
): string {
  const profile = requireWriteFormatProfile(version);
  const includePal = options?.hasPalNamespace ?? profile.hasPalNamespace;
  const palAttr = includePal ? ' xmlns:pal="http://v8.1c.ru/8.1/data/ui/colors/palette"' : '';

  return (
    `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"` +
    ` xmlns:app="http://v8.1c.ru/8.2/managed-application/core"` +
    ` xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config"` +
    ` xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi"` +
    ` xmlns:ent="http://v8.1c.ru/8.1/data/enterprise"` +
    ` xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform"` +
    `${palAttr}` +
    ` xmlns:style="http://v8.1c.ru/8.1/data/ui/style"` +
    ` xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system"` +
    ` xmlns:v8="http://v8.1c.ru/8.1/data/core"` +
    ` xmlns:v8ui="http://v8.1c.ru/8.1/data/ui"` +
    ` xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web"` +
    ` xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows"` +
    ` xmlns:xen="http://v8.1c.ru/8.3/xcf/enums"` +
    ` xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef"` +
    ` xmlns:xr="http://v8.1c.ru/8.3/xcf/readable"` +
    ` xmlns:xs="http://www.w3.org/2001/XMLSchema"` +
    ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"` +
    ` version="${profile.version}">`
  );
}

/**
 * Feature gate: LineNumberLength in TabularSections (introduced in version 2.20 / 8.3.27).
 */
export function hasLineNumberLength(formatRank: number): boolean {
  return formatRank >= 220;
}

/**
 * Feature gate: TypeReductionMode in StandardAttributes and InformationRegisters (introduced in 2.18 / 8.3.25).
 */
export function hasTypeReductionMode(formatRank: number): boolean {
  return formatRank >= 218;
}

/**
 * Feature gate: xmlns:pal and 8.5 UI properties (introduced in 2.21 / 8.5.1).
 */
export function hasPalNamespace(formatRank: number): boolean {
  return formatRank >= 221;
}
