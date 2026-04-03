/**
 * HTTP transport for the RDBG debug protocol.
 * Does not depend on VS Code API or rdbgTypes.
 */

const DEFAULT_TIMEOUT_MS = 0;

export class RdbgTransport {
    private readonly baseUrl: string;
    private readonly debugUiId: string;
    private readonly fetchImpl: typeof fetch;
    private readonly timeoutMs: number;

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
        const url = `${this.baseUrl}/e1crdbg/rdbg?cmd=${command}&dbgui=${this.debugUiId}`;

        let signal: AbortSignal | undefined;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

        if (this.timeoutMs > 0) {
            if (typeof AbortSignal.timeout === 'function') {
                signal = AbortSignal.timeout(this.timeoutMs);
            } else {
                const controller = new AbortController();
                timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
                signal = controller.signal;
            }
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
                    ...(signal ? { signal } : {}),
                });
            } catch (err: unknown) {
                const isAbort =
                    err instanceof Error &&
                    (err.name === 'AbortError' || err.name === 'TimeoutError');

                if (isAbort) {
                    throw new Error(
                        `RDBG request timeout after ${this.timeoutMs}ms: ${command}`
                    );
                }

                const message = err instanceof Error ? err.message : String(err);
                throw new Error(message);
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
        }
    }

    dispose(): void {
        // Reserved for future cancellation of pending requests.
    }
}
