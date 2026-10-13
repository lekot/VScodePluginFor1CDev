import * as fs from 'fs';
import * as path from 'path';
import { XMLValidator } from 'fast-xml-parser';
import { localName } from '../parsers/xmlNavHelpers';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Pure mutation contributor used by root-create planners before engine execution. */
export function appendRegisterReferenceToRecorderDocumentXml(
  xml: string,
  registerKind: 'AccumulationRegister' | 'InformationRegister',
  registerName: string,
): string {
  const ref = `${registerKind}.${registerName}`;
  const itemPattern = new RegExp(
    `<xr:Item\\b[^>]*>\\s*${escapeRegex(ref)}\\s*</xr:Item>`,
  );
  if (itemPattern.test(xml)) {
    return xml;
  }

  const itemLine = `\t\t\t<xr:Item xsi:type="xr:MDObjectRef">${ref}</xr:Item>`;
  if (/<RegisterRecords\s*\/>/.test(xml)) {
    return xml.replace(/<RegisterRecords\s*\/>/, `<RegisterRecords>\n${itemLine}\n\t\t</RegisterRecords>`);
  }
  if (xml.includes('</RegisterRecords>')) {
    return xml.replace('</RegisterRecords>', `${itemLine}\n\t\t</RegisterRecords>`);
  }
  throw new Error('Recorder document has no RegisterRecords section to update.');
}

/** Pure removal of one exact direct recorder reference, without changing other XML identities. */
export function removeRegisterReferenceFromRecorderDocumentXml(
  xml: string,
  registerKind: 'AccumulationRegister' | 'InformationRegister',
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

function findDirectRecorderItemRanges(xml: string, reference: string): XmlRange[] {
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
  const docName = resolveRecorderDocumentName(recorderDocumentName);
  if (!docName) {
    return;
  }
  const docPath = path.join(configRootPath, 'Documents', `${docName}.xml`);
  if (!fs.existsSync(docPath)) {
    return;
  }
  const ref = `${registerKind}.${registerName}`;
  let xml = await fs.promises.readFile(docPath, 'utf-8');
  if (xml.includes(ref)) {
    return;
  }
  const itemLine = `\t\t\t<xr:Item xsi:type="xr:MDObjectRef">${ref}</xr:Item>`;
  if (xml.includes('<RegisterRecords/>')) {
    xml = xml.replace(
      '<RegisterRecords/>',
      `<RegisterRecords>\n${itemLine}\n\t\t</RegisterRecords>`
    );
  } else if (xml.includes('</RegisterRecords>')) {
    xml = xml.replace('</RegisterRecords>', `${itemLine}\n\t\t</RegisterRecords>`);
  } else {
    return;
  }
  await fs.promises.writeFile(docPath, xml, 'utf-8');
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
  const docName = resolveRecorderDocumentName(recorderDocumentName);
  if (!docName) {
    return;
  }
  const docPath = path.join(configRootPath, 'Documents', `${docName}.xml`);
  if (!fs.existsSync(docPath)) {
    return;
  }
  const ref = `${registerKind}.${registerName}`;
  let xml = await fs.promises.readFile(docPath, 'utf-8');
  if (!xml.includes(ref)) {
    return;
  }
  const itemRe = new RegExp(
    '\\s*<xr:Item[^>]*>\\s*' + escapeRegex(ref) + '\\s*</xr:Item>',
    'g'
  );
  xml = xml.replace(itemRe, '');
  xml = xml.replace(/<RegisterRecords>\s*<\/RegisterRecords>/g, '<RegisterRecords/>');
  await fs.promises.writeFile(docPath, xml, 'utf-8');
}
