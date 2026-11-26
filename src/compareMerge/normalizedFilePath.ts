/** Removes only a trailing run of Windows and POSIX path separators. */
export function trimTrailingPathSeparators(value: string): string {
  let end = value.length;
  while (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code !== 47 && code !== 92) {break;}
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}
