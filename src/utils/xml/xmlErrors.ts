/**
 * Typed error classes for XML read/parse/write operations.
 * Used to avoid double-wrapping and fragile string matching in catch blocks.
 */

export class XmlReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlReadError';
  }
}

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlParseError';
  }
}

export class XmlWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlWriteError';
  }
}
