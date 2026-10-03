import * as path from 'path';
import { XmlParser } from './xmlParser';

export type BslCompletionLanguage = 'ru' | 'en';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }
  const object = record(value);
  const textValue = object?.['#text'];
  return typeof textValue === 'string' ? textValue.trim() || undefined : undefined;
}

function configurationElement(xml: Record<string, unknown>): Record<string, unknown> | undefined {
  return record(record(xml.MetaDataObject)?.Configuration) ?? record(xml.Configuration);
}

function languageName(value: unknown): string | undefined {
  const candidate = text(value);
  return candidate && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(candidate) ? candidate : undefined;
}

function fromLanguageCode(value: unknown): BslCompletionLanguage {
  const code = text(value);
  return code && /^en(?:-[a-z0-9]{1,8})*$/iu.test(code) ? 'en' : 'ru';
}

/** Reads Designer's default language and its LanguageCode once while the configuration root is parsed. */
export async function resolveDesignerBslLanguage(
  configRoot: string,
  configurationXml: Record<string, unknown>,
): Promise<BslCompletionLanguage> {
  const properties = record(configurationElement(configurationXml)?.Properties);
  const defaultLanguage = text(properties?.DefaultLanguage);
  const match = defaultLanguage && /^Language\.(.+)$/u.exec(defaultLanguage);
  const name = languageName(match?.[1]);
  if (!name) {
    return 'ru';
  }

  try {
    const languageXml = await XmlParser.parseFileAsync(path.join(configRoot, 'Languages', `${name}.xml`));
    const language = record(record(languageXml.MetaDataObject)?.Language) ?? record(languageXml.Language);
    const languageProperties = record(language?.Properties);
    return fromLanguageCode(languageProperties?.LanguageCode);
  } catch {
    return 'ru';
  }
}

/** Reads EDT's inline primary-language record while the configuration root is parsed. */
export function resolveEdtBslLanguage(configurationXml: Record<string, unknown>): BslCompletionLanguage {
  const configuration = configurationElement(configurationXml);
  const defaultLanguageReference = text(configuration?.defaultLanguage);
  const defaultLanguage = languageName(defaultLanguageReference?.replace(/^Language\./u, ''));
  if (!configuration || !defaultLanguage) {
    return 'ru';
  }

  const languageRecords = configuration.languages;
  const entries = Array.isArray(languageRecords) ? languageRecords : languageRecords === undefined ? [] : [languageRecords];
  const primaryLanguage = entries
    .map(record)
    .find((entry) => languageName(entry?.name) === defaultLanguage);
  return fromLanguageCode(primaryLanguage?.languageCode);
}
