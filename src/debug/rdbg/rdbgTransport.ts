/**
 * HTTP transport for the RDBG debug protocol.
 * Does not depend on VS Code API or rdbgTypes.
 *
 * All requests are serialized on one chain: the 1C dbgs endpoint is not safe
 * under concurrent POSTs (ping + stackTrace + variables at breakpoint time).
 */

const DEFAULT_TIMEOUT_MS = 0;

/** Turn undici/node `fetch failed` into something diagnosable (ECONNREFUSED, cause chain). */
function describeFetchFailure(err: unknown, command: string): Error {
  const parts: string[] = [`cmd=${command}`];
  let cur: unknown = err;
  let depth = 0;
  while (cur !== undefined && depth < 5) {
    if (cur instanceof Error) {
      parts.push(cur.message);
      const ne = cur as NodeJS.ErrnoException;
      if (typeof ne.code === 'string' && ne.code.length > 0) {
        parts.push(`code=${ne.code}`);
      }
      if (typeof ne.errno === 'number') {
        parts.push(`errno=${ne.errno}`);
      }
      cur = 'cause' in cur ? (cur as Error & { cause?: unknown }).cause : undefined;
    } else {
      parts.push(String(cur));
      break;
    }
    depth++;
  }
  return new Error(parts.join(' | '));
}

export class RdbgTransport {
    private readonly baseUrl: string;
    private readonly debugUiId: string;
    private readonly fetchImpl: typeof fetch;
    private readonly timeoutMs: number;
    /** One in-flight HTTP request at a time; new calls wait on the previous. */
    private _sendChain: Promise<unknown> = Promise.resolve();
    private _abortController = new AbortController();
    private _disposed = false;

    constructor(
        baseUrl: string,
        debugUiId: string,
        fetchImpl?: typeof fetch,
        timeoutMs?: number
    ) {
        this.baseUrl = baseUrl;
        this.debugUiId = debugUiId;
        this.fetchImpl = fetchImpl ?? globalThis.fetch;
        this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }

    get debugUiIdValue(): string {
        return this.debugUiId;
    }

    async send(command: string, body: string): Promise<string> {
        if (this._disposed) {
            throw new Error(`RDBG transport disposed: ${command}`);
        }
        const next = this._sendChain.then(() => {
            if (this._disposed) {
                throw new Error(`RDBG transport disposed: ${command}`);
            }
            return this.sendOne(command, body);
        });
        this._sendChain = next.then(
            () => undefined,
            () => undefined
        );
        return next;
    }

    private async sendOne(command: string, body: string): Promise<string> {
        if (this._disposed) {
            throw new Error(`RDBG transport disposed: ${command}`);
        }
        const url = `${this.baseUrl}/e1crdbg/rdbg?cmd=${command}&dbgui=${this.debugUiId}`;

        const reqController = new AbortController();
        const activeSignal = this._abortController.signal;
        const onAbort = () => reqController.abort();
        if (activeSignal.aborted) {
            reqController.abort();
        } else {
            activeSignal.addEventListener('abort', onAbort, { once: true });
        }

        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        if (this.timeoutMs > 0) {
            timeoutHandle = setTimeout(() => reqController.abort(), this.timeoutMs);
        }

        try {
            let response: Response;
            try {
                response = await this.fetchImpl(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/xml; charset=utf-8',
                        'Accept': 'application/xml',
                        'User-Agent': '1CV8',
                        'Accept-Encoding': 'gzip',
                    },
                    body,
                    signal: reqController.signal,
                });
            } catch (err: unknown) {
                const isAbort =
                    err instanceof Error &&
                    (err.name === 'AbortError' || err.name === 'TimeoutError');

                if (isAbort) {
                    if (this._disposed || activeSignal.aborted) {
                        throw new Error(`RDBG request aborted: ${command}`);
                    }
                    throw new Error(
                        `RDBG request timeout after ${this.timeoutMs}ms: ${command}`
                    );
                }

                throw describeFetchFailure(err, command);
            }

            if (!response.ok) {
                let snippet = '';
                try {
                    const text = await response.text();
                    snippet = text.slice(0, 500);
                } catch {
                    // ignore read errors
                }
                throw new Error(`HTTP ${response.status}: ${snippet}`);
            }

            return response.text();
        } finally {
            if (timeoutHandle !== undefined) {
                clearTimeout(timeoutHandle);
            }
            activeSignal.removeEventListener('abort', onAbort);
        }
    }

    abortPending(): void {
        this._abortController.abort();
        if (!this._disposed) {
            this._abortController = new AbortController();
        }
    }

    dispose(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        this._abortController.abort();
    }
}
