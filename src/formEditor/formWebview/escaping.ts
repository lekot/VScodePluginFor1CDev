export function escapeWebviewText(value: unknown): string {
  if (value == null) { return ''; }
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeWebviewAttribute(value: unknown): string {
  if (value == null) { return ''; }
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
