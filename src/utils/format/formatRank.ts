/**
 * Format Version and Format Rank utilities for 1C Metadata XML.
 *
 * The format version is determined by the 1C platform version that exported the configuration
 * (e.g. 8.3.20 -> 2.13, 8.3.24 -> 2.17, 8.3.25 -> 2.18, 8.3.27 -> 2.20, 8.5.1 -> 2.21).
 *
 * We use a monotonic numeric format rank (major * 100 + minor) to allow safe range checks:
 * e.g. `formatRank >= 220` for features introduced in 2.20 (8.3.27).
 */

export const FORMAT_VERIFIED_MIN = 217; // 8.3.24
export const FORMAT_VERIFIED_MAX = 221; // 8.5.1
export const DEFAULT_FORMAT_VERSION = '2.17';
export const DEFAULT_FORMAT_RANK = 217;

export interface FormatVersionInfo {
  version: string;
  rank: number;
  isVerified: boolean;
}

/**
 * Calculates a monotonic integer rank from a format version string "N.NN" or "N.NN.N" (e.g. "2.17" -> 217, "2.20" -> 220, "2.20.1" -> 220).
 * Returns 0 if version is empty or malformed.
 */
export function getFormatRank(versionStr: string | undefined | null): number {
  if (!versionStr) {
    return 0;
  }
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(versionStr.trim());
  if (!match) {
    return 0;
  }
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  return major * 100 + minor;
}

/**
 * Normalizes a format version string. If invalid, returns the default format version ("2.17").
 */
export function normalizeFormatVersion(versionStr: string | undefined | null): string {
  const rank = getFormatRank(versionStr);
  if (rank === 0) {
    return DEFAULT_FORMAT_VERSION;
  }
  return versionStr!.trim();
}

/**
 * Extracts the format version from an XML string (e.g. Configuration.xml or object XML header).
 * Looks for `<MetaDataObject ... version="N.NN">` or root element `version="N.NN"`.
 */
export function detectFormatVersionFromXml(xmlContent: string): FormatVersionInfo {
  if (!xmlContent) {
    return {
      version: DEFAULT_FORMAT_VERSION,
      rank: DEFAULT_FORMAT_RANK,
      isVerified: true,
    };
  }

  const match = /<MetaDataObject\b[^>]*\bversion=["'](\d+\.\d+(?:\.\d+)?)["']/i.exec(xmlContent)
    || /<[A-Za-z0-9_:]+\b[^>]*\bversion=["'](\d+\.\d+(?:\.\d+)?)["']/i.exec(xmlContent);

  if (match && match[1]) {
    const version = match[1];
    const rank = getFormatRank(version);
    return {
      version,
      rank,
      isVerified: rank >= FORMAT_VERIFIED_MIN && rank <= FORMAT_VERIFIED_MAX,
    };
  }

  return {
    version: DEFAULT_FORMAT_VERSION,
    rank: DEFAULT_FORMAT_RANK,
    isVerified: true,
  };
}

/**
 * Constructs the canonical opening <MetaDataObject ...> tag with standard namespaces and the given format version.
 */
export function buildCanonicalMetaDataObjectOpenTag(
  version: string = DEFAULT_FORMAT_VERSION,
  options?: { hasPalNamespace?: boolean }
): string {
  const normVersion = normalizeFormatVersion(version);
  const rank = getFormatRank(normVersion);
  const includePal = options?.hasPalNamespace ?? (rank >= 221);

  const palAttr = includePal ? ' xmlns:pal="http://v8.1c.ru/8.5/data/ui/palette"' : '';

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
    ` version="${normVersion}">`
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
