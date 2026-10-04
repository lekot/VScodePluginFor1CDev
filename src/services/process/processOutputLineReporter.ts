/** Maximum characters retained for one process-output fragment before forwarding it. */
export const PROCESS_OUTPUT_LINE_MAX_CHARS = 320;

export interface ProcessOutputLineReporter {
  /** Accept decoded process output. Chunks may end in the middle of a line. */
  accept(chunk: string): void;
  /** Forward the last unterminated line fragment when a process operation settles. */
  flush(): void;
}

/**
 * Frames arbitrary stdout/stderr chunks into bounded lines for status/progress sinks.
 * The caller must redact secrets before passing chunks to this reporter.
 */
export function createProcessOutputLineReporter(
  reportLine: ((line: string) => void) | undefined,
): ProcessOutputLineReporter {
  let pending = '';
  let previousWasCarriageReturn = false;

  const emit = (): void => {
    const line = pending.trim();
    pending = '';
    if (line) {
      reportLine?.(line);
    }
  };

  const appendCharacter = (character: string): void => {
    pending += character;
    if (pending.length >= PROCESS_OUTPUT_LINE_MAX_CHARS) {
      let fragmentEnd = PROCESS_OUTPUT_LINE_MAX_CHARS - 1;
      const lastCodeUnit = pending.charCodeAt(fragmentEnd - 1);
      if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
        fragmentEnd -= 1;
      }
      const fragment = pending.slice(0, fragmentEnd).trim();
      pending = pending.slice(fragmentEnd);
      if (fragment) {
        reportLine?.(`${fragment}…`);
      }
    }
  };

  return {
    accept(chunk): void {
      for (const character of chunk) {
        if (previousWasCarriageReturn) {
          previousWasCarriageReturn = false;
          if (character === '\n') {
            continue;
          }
        }
        if (character === '\r') {
          emit();
          previousWasCarriageReturn = true;
        } else if (character === '\n') {
          emit();
        } else {
          appendCharacter(character);
        }
      }
    },
    flush(): void {
      previousWasCarriageReturn = false;
      emit();
    },
  };
}
