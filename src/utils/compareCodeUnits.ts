/** Compare two strings in the UTF-16 code-unit order used by default Array#sort. */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) { return -1; }
  if (a > b) { return 1; }
  return 0;
}
