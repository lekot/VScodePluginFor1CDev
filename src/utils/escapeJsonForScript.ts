/**
 * Escape a JSON string for safe injection into an HTML `<script>` tag.
 * Prevents `</script>` injection and HTML entity issues.
 */
export function escapeJsonForScript(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
