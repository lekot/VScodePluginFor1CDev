import * as fs from 'fs/promises';
import { StringDecoder } from 'string_decoder';

import type { CompareCancellationToken } from '../compareCancellation';
import { throwIfCompareCancelled } from '../compareCancellation';

const READ_CHUNK_BYTES = 4 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

export interface MetadataHeaderPrefixInput {
  filePath: string;
  rootTags: readonly string[];
  cancellation?: CompareCancellationToken;
}

type ElementKind = 'other' | 'wrapper' | 'object' | 'properties' | 'name';

interface ElementFrame {
  name: string;
  kind: ElementKind;
  propertiesSeen: boolean;
  nameSeen: boolean;
}

interface OpeningTag {
  name: string;
  selfClosing: boolean;
}

/**
 * Reads a bounded XML prefix ending at the first direct Properties/Name element
 * of the requested metadata object. The returned prefix has its open ancestors
 * closed so it can be parsed by the normal metadata XML parser.
 */
export async function readMetadataHeaderPrefix(
  input: MetadataHeaderPrefixInput
): Promise<string | undefined> {
  throwIfCompareCancelled(input.cancellation);
  const rootTags = new Set(input.rootTags.map(stripNamespacePrefix));
  if (rootTags.size === 0) {
    return undefined;
  }

  const handle = await fs.open(input.filePath, 'r');
  try {
    throwIfCompareCancelled(input.cancellation);
    const decoder = new StringDecoder('utf8');
    const scanner = new MetadataHeaderScanner(rootTags);
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    let byteOffset = 0;

    while (byteOffset < MAX_HEADER_BYTES) {
      throwIfCompareCancelled(input.cancellation);
      const readLength = Math.min(buffer.length, MAX_HEADER_BYTES - byteOffset);
      const { bytesRead } = await handle.read(buffer, 0, readLength, byteOffset);
      throwIfCompareCancelled(input.cancellation);
      if (bytesRead === 0) {
        scanner.append(decoder.end());
        return scanner.prefix;
      }

      byteOffset += bytesRead;
      scanner.append(decoder.write(buffer.subarray(0, bytesRead)));
      if (scanner.prefix !== undefined) {
        return scanner.prefix;
      }
      if (scanner.invalid) {
        return undefined;
      }
    }

    return undefined;
  } finally {
    await handle.close();
  }
}

class MetadataHeaderScanner {
  private content = '';
  private cursor = 0;
  private readonly stack: ElementFrame[] = [];
  private rootKind: 'wrapper' | 'direct' | undefined;
  private discoveredPrefix: string | undefined;
  private hasInvalidStructure = false;

  constructor(private readonly rootTags: ReadonlySet<string>) {}

  get prefix(): string | undefined {
    return this.discoveredPrefix;
  }

  get invalid(): boolean {
    return this.hasInvalidStructure;
  }

  append(text: string): void {
    if (this.discoveredPrefix !== undefined || this.hasInvalidStructure || text.length === 0) {
      return;
    }

    this.content += text;
    this.scanAvailableContent();
  }

  private scanAvailableContent(): void {
    while (this.cursor < this.content.length && !this.discoveredPrefix && !this.hasInvalidStructure) {
      if (this.content[this.cursor] !== '<') {
        this.scanTextCharacter();
        continue;
      }

      if (!this.processMarkup()) {
        return;
      }
    }
  }

  private scanTextCharacter(): void {
    const character = this.content[this.cursor];
    if (this.stack.length === 0 && character !== undefined && !isXmlWhitespace(character)) {
      this.hasInvalidStructure = true;
      return;
    }
    this.cursor += 1;
  }

  private processMarkup(): boolean {
    if (this.cursor + 1 >= this.content.length) {
      return false;
    }
    if (isPartialMarkupPrefix(this.content, this.cursor)) {
      return false;
    }
    if (this.content.startsWith('<!--', this.cursor)) {
      return this.skipDelimitedMarkup('-->');
    }
    if (this.content.startsWith('<?', this.cursor)) {
      return this.skipDelimitedMarkup('?>');
    }
    if (this.content.startsWith('<![CDATA[', this.cursor)) {
      if (this.stack.length === 0) {
        this.hasInvalidStructure = true;
        return false;
      }
      return this.skipDelimitedMarkup(']]>');
    }
    if (this.content.startsWith('<!')) {
      this.hasInvalidStructure = true;
      return false;
    }
    if (this.content.startsWith('</', this.cursor)) {
      return this.processClosingTag();
    }

    return this.processOpeningTag();
  }

  private skipDelimitedMarkup(endMarker: string): boolean {
    const end = this.content.indexOf(endMarker, this.cursor + 2);
    if (end < 0) {
      return false;
    }
    this.cursor = end + endMarker.length;
    return true;
  }

  private processOpeningTag(): boolean {
    const end = findTagEnd(this.content, this.cursor);
    if (end < 0) {
      return false;
    }
    const tag = parseOpeningTag(this.content.slice(this.cursor, end + 1));
    if (!tag) {
      this.hasInvalidStructure = true;
      return false;
    }

    const kind = this.classifyElement(tag.name);
    if (!kind) {
      this.hasInvalidStructure = true;
      return false;
    }
    this.cursor = end + 1;
    if (tag.selfClosing) {
      if (kind === 'name') {
        this.discoveredPrefix = this.closeOpenAncestors(this.cursor, this.stack);
      } else if (kind === 'object' || kind === 'wrapper') {
        this.hasInvalidStructure = true;
      }
      return !this.hasInvalidStructure && this.discoveredPrefix === undefined;
    }

    this.stack.push({ name: tag.name, kind, propertiesSeen: false, nameSeen: false });
    return true;
  }

  private classifyElement(name: string): ElementKind | undefined {
    const current = this.stack[this.stack.length - 1];
    const localName = stripNamespacePrefix(name);
    if (!current) {
      if (this.rootKind !== undefined) {
        return undefined;
      }
      if (localName === 'MetaDataObject') {
        this.rootKind = 'wrapper';
        return 'wrapper';
      }
      if (this.rootTags.has(localName)) {
        this.rootKind = 'direct';
        return 'object';
      }
      return undefined;
    }

    if (current.kind === 'wrapper' && this.stack.length === 1) {
      return this.rootTags.has(localName) ? 'object' : undefined;
    }
    if (current.kind === 'object' && localName === 'Properties' && !current.propertiesSeen) {
      current.propertiesSeen = true;
      return 'properties';
    }
    if (current.kind === 'properties' && localName === 'Name' && !current.nameSeen) {
      current.nameSeen = true;
      return 'name';
    }

    return 'other';
  }

  private processClosingTag(): boolean {
    const end = findTagEnd(this.content, this.cursor);
    if (end < 0) {
      return false;
    }
    const name = parseClosingTag(this.content.slice(this.cursor, end + 1));
    const current = this.stack[this.stack.length - 1];
    if (!name || !current || current.name !== name) {
      this.hasInvalidStructure = true;
      return false;
    }

    this.cursor = end + 1;
    if (current.kind === 'name') {
      this.discoveredPrefix = this.closeOpenAncestors(this.cursor, this.stack.slice(0, -1));
      return false;
    }
    this.stack.pop();
    if (current.kind === 'object' || current.kind === 'wrapper') {
      this.hasInvalidStructure = true;
      return false;
    }
    return true;
  }

  private closeOpenAncestors(end: number, ancestors: readonly ElementFrame[]): string {
    let prefix = this.content.slice(0, end);
    for (let index = ancestors.length - 1; index >= 0; index -= 1) {
      prefix += `</${ancestors[index]!.name}>`;
    }
    return prefix;
  }
}

function isPartialMarkupPrefix(content: string, start: number): boolean {
  return (
    isPartialTokenAt(content, start, '<!--') ||
    isPartialTokenAt(content, start, '<![CDATA[') ||
    isPartialTokenAt(content, start, '<?') ||
    isPartialTokenAt(content, start, '</')
  );
}

function isPartialTokenAt(content: string, start: number, token: string): boolean {
  const remainingLength = content.length - start;
  if (remainingLength >= token.length) {
    return false;
  }
  for (let index = 0; index < remainingLength; index += 1) {
    if (content[start + index] !== token[index]) {
      return false;
    }
  }
  return true;
}

function findTagEnd(content: string, start: number): number {
  let quote: string | undefined;
  for (let index = start + 1; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function parseOpeningTag(token: string): OpeningTag | undefined {
  if (!token.startsWith('<') || !token.endsWith('>') || token.startsWith('</')) {
    return undefined;
  }
  let nameEnd = 1;
  while (nameEnd < token.length - 1 && !isTagNameDelimiter(token[nameEnd]!)) {
    nameEnd += 1;
  }
  const name = token.slice(1, nameEnd);
  if (!name) {
    return undefined;
  }

  let lastContentCharacter = token.length - 2;
  while (lastContentCharacter > nameEnd && isXmlWhitespace(token[lastContentCharacter]!)) {
    lastContentCharacter -= 1;
  }
  return { name, selfClosing: token[lastContentCharacter] === '/' };
}

function parseClosingTag(token: string): string | undefined {
  if (!token.startsWith('</') || !token.endsWith('>')) {
    return undefined;
  }
  const rawName = token.slice(2, -1).trim();
  if (!rawName || /[\s/<>]/.test(rawName)) {
    return undefined;
  }
  return rawName;
}

function isTagNameDelimiter(character: string): boolean {
  return character === '/' || character === '>' || isXmlWhitespace(character);
}

function isXmlWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\r' || character === '\n' || character === '\uFEFF';
}

function stripNamespacePrefix(name: string): string {
  const separator = name.lastIndexOf(':');
  return separator < 0 ? name : name.slice(separator + 1);
}
