/**
 * ibcmd may emit OEM (CP866) or UTF-8 depending on build and pipe. Spawn streaming `auto` assumes UTF-8; pick `oem866` / `windows1251`
 * when needed. After {@link decodeIbcmdProcessStreams}, strings are normalized for UI (JavaScript UTF-16).
 */

/** Values for `1cMetadataTree.ibcmd.consoleOutputEncoding`. */
export type IbcmdConsoleOutputEncoding = 'auto' | 'utf8' | 'utf16le' | 'oem866' | 'windows1251';

/**
 * Result of a finished ibcmd process (execFile or post-decode streaming aggregation).
 * `stdout` / `stderr` are always decoded for display — treat as plain text for Output Channel / messages.
 */
export interface IbcmdRunOutcome {
  stdout: string;
  stderr: string;
}

/** Design doc discriminated union (for helpers / future APIs). */
export type IbcmdStreamEncodingMode =
  | { kind: 'utf8' }
  | { kind: 'utf16le' }
  | { kind: 'oem'; codePage: number }
  | { kind: 'windows'; codePage: number }
  | { kind: 'auto' };

export function encodingModeFromSetting(setting: IbcmdConsoleOutputEncoding): IbcmdStreamEncodingMode {
  switch (setting) {
    case 'utf8':
      return { kind: 'utf8' };
    case 'utf16le':
      return { kind: 'utf16le' };
    case 'oem866':
      return { kind: 'oem', codePage: 866 };
    case 'windows1251':
      return { kind: 'windows', codePage: 1251 };
    default:
      return { kind: 'auto' };
  }
}
