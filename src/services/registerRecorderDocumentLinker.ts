import * as fs from 'fs';
import * as path from 'path';
import { XMLValidator } from 'fast-xml-parser';
import { localName } from '../parsers/xmlNavHelpers';
import { getConfigurationMutationEngine } from './configurationSession/ConfigurationMutationEngine';
import { unwrapMutationReceipt } from './configurationSession/mutationReceiptError';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type RecorderRegisterKind =
  | 'AccumulationRegister'
  | 'InformationRegister'
  | 'AccountingRegister'
  | 'CalculationRegister';

/** Pure mutation contributor used by root-create planners before engine execution. */
export function appendRegisterReferenceToRecorderDocumentXml(
  xml: string,
  registerKind: RecorderRegisterKind,
  registerName: string,
): string {
  const ref = `${registerKind}.${registerName}`;
  const sections: RecorderSectionLocation[] = [];
  if (findDirectRecorderItemRanges(xml, ref, sections).length > 0) {
    return xml;
  }

  const itemLine = `\t\t\t<xr:Item xsi:type="xr:MDObjectRef">${ref}</xr:Item>`;
  const section = sections[0];
  if (!section) {
    throw new Error('Recorder document must contain exactly one Document/RegisterRecords section.');
  }
  if (section.selfClosing) {
    const openingTag = xml.slice(section.start, section.end).replace(/\/\s*>$/, '>');
    const tagName = /^<\s*([^\s/>]+)/.exec(openingTag)?.[1] ?? 'RegisterRecords';
    return `${xml.slice(0, section.start)}${openingTag}\n${itemLine}\n\t\t</${tagName}>${xml.slice(section.end)}`;
  }
  return `${xml.slice(0, section.closingStart)}${itemLine}\n\t\t${xml.slice(section.closingStart)}`;
}

/** Pure removal of one exact direct recorder reference, without changing other XML identities. */
export function removeRegisterReferenceFromRecorderDocumentXml(
  xml: string,
  registerKind: RecorderRegisterKind,
  registerName: string,
): string {
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validation !== true) {
    const detail = typeof validation === 'object' ? validation.err.msg : 'Malformed XML';
    throw new Error(`Recorder document XML is malformed: ${detail}`);
  }

  const itemRanges = findDirectRecorderItemRanges(xml, `${registerKind}.${registerName}`);
  let result = xml;
  for (const range of itemRanges.reverse()) {
    result = `${result.slice(0, range.start)}${result.slice(range.end)}`;
  }
  if (itemRanges.length > 0) {
    const sections: RecorderSectionLocation[] = [];
    findDirectRecorderItemRanges(result, '', sections);
    for (const section of sections.reverse()) {
      if (section.selfClosing) {
        continue;
      }
      const openingEnd = findMarkupEnd(result, section.start) + 1;
      if (result.slice(openingEnd, section.closingStart).trim() !== '') {
        continue;
      }
      const selfClosingTag = result.slice(section.start, openingEnd).replace(/\s*>$/, '/>');
      result = `${result.slice(0, section.start)}${selfClosingTag}${result.slice(section.end)}`;
    }
  }
  return result;
}

interface XmlElementFrame {
  readonly name: string;
  readonly start: number;
  readonly contentStart: number;
  readonly isRecorderSection: boolean;
  readonly isRecorderItem: boolean;
  readonly hasMetadataObjectReferenceType: boolean;
}

interface XmlRange {
  readonly start: number;
  readonly end: number;
}

interface RecorderSectionLocation {
  readonly start: number;
  readonly end: number;
  readonly closingStart: number;
  readonly selfClosing: boolean;
}

function findDirectRecorderItemRanges(
  xml: string,
  reference: string,
  sections?: RecorderSectionLocation[],
): XmlRange[] {
  const stack: XmlElementFrame[] = [];
  const ranges: XmlRange[] = [];
  let recorderSectionCount = 0;
  let cursor = 0;

  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor);
    if (start < 0) {
      break;
    }
    const end = findMarkupEnd(xml, start);
    const markup = xml.slice(start, end + 1);
    cursor = end + 1;

    if (markup.startsWith('<!--') || markup.startsWith('<![CDATA[') || markup.startsWith('<?') || markup.startsWith('<!')) {
      continue;
    }

    const closing = /^<\s*\/\s*([^\s>]+)\s*>$/.exec(markup);
    if (closing) {
      const frame = stack.pop();
      if (!frame || frame.name !== closing[1]) {
        throw new Error('Recorder document XML has an inconsistent element structure.');
      }
      if (frame.isRecorderItem && frame.hasMetadataObjectReferenceType) {
        const text = decodeXmlText(xml.slice(frame.contentStart, start)).trim();
        if (text === reference) {
          ranges.push({ start: frame.start, end: end + 1 });
        }
      }
      if (frame.isRecorderSection) {
        sections?.push({ start: frame.start, end: end + 1, closingStart: start, selfClosing: false });
      }
      continue;
    }

    const opening = /^<\s*([^\s/>]+)/.exec(markup);
    if (!opening) {
      continue;
    }
    const name = opening[1]!;
    const parent = stack[stack.length - 1];
    const grandparent = stack[stack.length - 2];
    const isRecorderSection = localName(name) === 'RegisterRecords'
      && parent !== undefined
      && localName(parent.name) === 'Properties'
      && grandparent !== undefined
      && localName(grandparent.name) === 'Document';
    if (isRecorderSection) {
      recorderSectionCount++;
    }
    const isRecorderItem = name === 'xr:Item' && parent?.isRecorderSection === true;
    const hasMetadataObjectReferenceType = isRecorderItem
      && hasAttributeValue(markup, 'xsi:type', 'xr:MDObjectRef');
    const selfClosing = /\/\s*>$/.test(markup);
    if (isRecorderSection && selfClosing) {
      sections?.push({ start, end: end + 1, closingStart: end + 1, selfClosing: true });
    }
    if (!selfClosing) {
      stack.push({
        name,
        start,
        contentStart: end + 1,
        isRecorderSection,
        isRecorderItem,
        hasMetadataObjectReferenceType,
      });
    }
  }

  if (recorderSectionCount !== 1) {
    throw new Error('Recorder document must contain exactly one Document/RegisterRecords section.');
  }
  return ranges;
}

function hasAttributeValue(markup: string, name: string, expectedValue: string): boolean {
  const attribute = new RegExp(`\\s${escapeRegex(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(markup);
  return (attribute?.[1] ?? attribute?.[2]) === expectedValue;
}

function findMarkupEnd(xml: string, start: number): number {
  const terminator = xml.startsWith('<!--', start)
    ? '-->'
    : xml.startsWith('<![CDATA[', start)
      ? ']]>'
      : xml.startsWith('<?', start)
        ? '?>'
        : undefined;
  if (terminator) {
    const terminatorIndex = xml.indexOf(terminator, start + 2);
    if (terminatorIndex < 0) {
      throw new Error('Recorder document XML contains an unterminated markup section.');
    }
    return terminatorIndex + terminator.length - 1;
  }

  let quote: string | undefined;
  let subsetDepth = 0;
  for (let index = start + 1; index < xml.length; index++) {
    const character = xml[index]!;
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (xml.startsWith('<!DOCTYPE', start) && character === '[') {
      subsetDepth++;
    } else if (xml.startsWith('<!DOCTYPE', start) && character === ']') {
      subsetDepth--;
    } else if (character === '>' && subsetDepth === 0) {
      return index;
    }
  }
  throw new Error('Recorder document XML contains an unterminated element tag.');
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, codePoint: string) => String.fromCodePoint(Number.parseInt(codePoint, 16)))
    .replace(/&#([0-9]+);/g, (_, codePoint: string) => String.fromCodePoint(Number.parseInt(codePoint, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => ({
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
    }[entity] ?? _));
}

/** Имя документа-регистратора: явный аргумент или `process.env.IBCMD_RECORDER_DOCUMENT`. */
function resolveRecorderDocumentName(explicit?: string): string {
  const x = explicit?.trim();
  if (x) {
    return x;
  }
  return process.env.IBCMD_RECORDER_DOCUMENT?.trim() || '';
}

/**
 * Дописывает в документ-регистратор ссылку на регистр накопления / сведений в &lt;RegisterRecords&gt;,
 * чтобы ibcmd видел регистратора для регистра с проведением.
 * Без имени документа (env `IBCMD_RECORDER_DOCUMENT` не задан) — no-op.
 */
export async function appendRegisterReferenceToRecorderDocument(
  configRootPath: string,
  registerKind: 'AccumulationRegister' | 'InformationRegister',
  registerName: string,
  recorderDocumentName?: string
): Promise<void> {
  await mutateRecorderDocument(
    configRootPath,
    registerKind,
    registerName,
    recorderDocumentName,
    'append',
  );
}

/**
 * Удаляет из документа-регистратора ссылку на регистр (симметрично {@link appendRegisterReferenceToRecorderDocument}).
 * Нужно при удалении регистра, иначе в &lt;RegisterRecords&gt; остаётся ссылка на несуществующий объект (ibcmd: «Неизвестный объект метаданных»).
 */
export async function removeRegisterReferenceFromRecorderDocument(
  configRootPath: string,
  registerKind: 'AccumulationRegister' | 'InformationRegister',
  registerName: string,
  recorderDocumentName?: string
): Promise<void> {
  await mutateRecorderDocument(
    configRootPath,
    registerKind,
    registerName,
    recorderDocumentName,
    'remove',
  );
}

async function mutateRecorderDocument(
  configRootPath: string,
  registerKind: 'AccumulationRegister' | 'InformationRegister',
  registerName: string,
  recorderDocumentName: string | undefined,
  operation: 'append' | 'remove',
): Promise<void> {
  const docName = resolveRecorderDocumentName(recorderDocumentName);
  if (!docName) {
    return;
  }
  const docPath = path.join(configRootPath, 'Documents', `${docName}.xml`);
  if (!fs.existsSync(docPath)) {
    return;
  }
  const ref = `${registerKind}.${registerName}`;
  const receipt = await getConfigurationMutationEngine().transformFile(
    docPath,
    {
      kind: `recorder.${operation}RegisterReference`,
      resourcePath: docPath,
    },
    (state) => {
      if (!state.exists) {
        throw new Error(`Recorder document was deleted before its ${operation} could be committed: ${docPath}`);
      }
      if (operation === 'append') {
        let updatedContent: string;
        try {
          updatedContent = appendRegisterReferenceToRecorderDocumentXml(state.content, registerKind, registerName);
        } catch (error) {
          if (error instanceof Error
            && error.message === 'Recorder document must contain exactly one Document/RegisterRecords section.') {
            return { content: state.content, result: undefined };
          }
          throw error;
        }
        return { content: updatedContent, result: undefined };
      }
      const updatedContent = state.content.includes(ref)
        ? removeRegisterReferenceFromRecorderDocumentXml(state.content, registerKind, registerName)
        : state.content;
      return { content: updatedContent, result: undefined };
    },
  );
  unwrapMutationReceipt(receipt, `Не удалось ${operation === 'append' ? 'добавить' : 'удалить'} ссылку регистра в ${docPath}`);
}
