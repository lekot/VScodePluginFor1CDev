import { randomUUID } from 'crypto';

/** Cryptographically secure UUID v4 for new metadata objects (e.g. templates). */
export function generateSimpleUuid(): string {
  return randomUUID();
}
