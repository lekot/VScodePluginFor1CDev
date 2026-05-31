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

export function parseXmlAddressPointer(pointer: string): XmlAddressSegment[] {
  if (!pointer.startsWith('/')) {
    throw new Error(`Invalid XML address pointer: ${pointer}`);
  }

  return pointer
    .slice(1)
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const match = /^(.+)\[(.*)\]$/.exec(segment);
      if (!match) {
        return {
          localName: decodeURIComponent(segment),
          selector: '0',
        };
      }

      return {
        localName: decodeURIComponent(match[1]),
        selector: decodeURIComponent(match[2]),
      };
    });
}
