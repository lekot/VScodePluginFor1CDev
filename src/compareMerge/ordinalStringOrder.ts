/** Compares strings by UTF-16 code units, matching Array.prototype.sort() with no comparator. */
export function compareOrdinalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
