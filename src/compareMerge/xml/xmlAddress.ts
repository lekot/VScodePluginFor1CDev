export interface XmlAddress {
  filePath: string;
  pointer: string;
  displayPath: string;
  identityKey?: string;
}

export interface XmlAddressSegment {
  localName: string;
  selector: string;
}

export function encodeXmlAddressComponent(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*~]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\[/g, '%5B')
    .replace(/\]/g, '%5D');
}

export function parseXmlAddressPointer(pointer: string): XmlAddressSegment[] {
  if (!pointer.startsWith('/')) {
    throw new Error(`Invalid XML address pointer: ${pointer}`);
  }

  const encodedSegments = pointer.slice(1).split('/');
  if (encodedSegments.length === 0 || encodedSegments.some((segment) => !segment)) {
    throw new Error(`Invalid XML address pointer: ${pointer}`);
  }

  return encodedSegments.map((segment) => {
    const match = /^(.+)\[(.*)\]$/.exec(segment);
    if (!match) {
      return {
        localName: decodeXmlAddressComponent(segment, pointer),
        selector: '0',
      };
    }

    return {
      localName: decodeXmlAddressComponent(match[1], pointer),
      selector: decodeXmlAddressComponent(match[2], pointer),
    };
  });
}

function decodeXmlAddressComponent(value: string, pointer: string): string {
  try {
    const encoded = value.replace(/%(?![\da-f]{2})/gi, '%25');
    return decodeURIComponent(encoded);
  } catch {
    throw new Error(`Invalid XML address encoding: ${pointer}`);
  }
}
