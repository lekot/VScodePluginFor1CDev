import { webcrypto } from 'crypto';

/** The MCP SDK expects WebCrypto during module evaluation on Node 18. */
export function ensureWebCrypto(): void {
  if (globalThis.crypto !== undefined) {
    return;
  }
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    enumerable: false,
    value: webcrypto,
    writable: false,
  });
}
