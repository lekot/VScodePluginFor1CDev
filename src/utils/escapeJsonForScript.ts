/**
 * Escape serialized JSON for safe injection into an HTML `<script>` data state.
 * Escaping both angle brackets prevents every HTML parser closing-tag variant
 * (case, whitespace, and attributes), not only the exact `</script>` spelling.
 */
export function escapeJsonForScript(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
