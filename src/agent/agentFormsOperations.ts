// src/agent/agentFormsOperations.ts
// Agent Forms API — операции управления формами 1С через run.mjs (playwright).

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentResult } from './types';
import type {
    FormsStartParams, FormsStartResult,
    FormsExecParams, FormsExecResult,
    FormsStopParams, FormsStopResult,
    FormsShotParams, FormsShotResult,
    FormsStatusParams, FormsStatusResult,
} from './agentFormsTypes';
import { FormsContext } from '../services/forms/FormsContext';
import { startIbsrv } from '../services/forms/FormsIbsrvLauncher';
import { runFormsScript } from '../services/forms/runFormsScript';
import { ensureChromiumInstalled } from '../services/forms/chromiumInstaller';
import { getPlatformPathSetting } from '../services/metadataTreeSettings';

/** Зависимости для FormsOperations. */
export interface FormsOperationsDeps {
    /** extensionContext.extensionPath */
    extensionPath: string;
    /** Output channel для логов. */
    outputChannel: vscode.OutputChannel;
    /** Test seams and explicit resource owner. */
    context?: FormsContext;
    startIbsrv?: typeof startIbsrv;
    runFormsScript?: typeof runFormsScript;
    ensureChromiumInstalled?: typeof ensureChromiumInstalled;
}

/** Класс операций Agent Forms API. */
export class FormsOperations {
    constructor(private readonly deps: FormsOperationsDeps) {}

    private get context(): FormsContext {
        return this.deps.context ?? FormsContext.get();
    }

    private runScript(
        options: Omit<Parameters<typeof runFormsScript>[0], 'extensionPath' | 'sessionFilePath'>,
    ): ReturnType<typeof runFormsScript> {
        return (this.deps.runFormsScript ?? runFormsScript)({
            ...options,
            extensionPath: this.deps.extensionPath,
            sessionFilePath: this.context.sessionFilePath,
        });
    }

    private async runShortScript(
        options: Omit<Parameters<typeof runFormsScript>[0], 'extensionPath' | 'sessionFilePath'>,
    ): ReturnType<typeof runFormsScript> {
        const result = await this.runScript(options);
        if (result.unclosedProc) {
            this.context.adoptTransientProcess(
                result.unclosedProc,
                `forms ${options.command} runner`,
            );
        }
        return result;
    }

    // ─── formsStart ───────────────────────────────────────────────────────────

    /**
     * Запускает браузерную сессию форм 1С.
     * Если задан dbPath — сначала поднимает ibsrv, потом подключает playwright.
     * Если задан url — подключается напрямую.
     */
    async formsStart(params: FormsStartParams): Promise<AgentResult<FormsStartResult>> {
        if (!params.url && !params.dbPath) {
            return { success: false, error: 'Необходимо указать url или dbPath' };
        }
        const platformPath = params.dbPath
            ? params.platformPath
                ?? getPlatformPathSetting()
            : undefined;
        if (params.dbPath && !platformPath) {
            return {
                success: false,
                error: 'platformPath не задан (ни в параметрах, ни в настройках 1cMetadataTree.platformPath)',
            };
        }

        return this.context.runExclusive(async () => {
            const ctx = this.context;
            const previousCleanup = await ctx.stop();
            if (previousCleanup.errors.length > 0) {
                return { success: false, error: `Не удалось остановить предыдущую сессию: ${previousCleanup.errors.join('; ')}` };
            }
            try {
                let targetUrl = params.url ?? '';
                let ibsrvSpawned = false;
                if (params.dbPath && platformPath) {
                    const result = await (this.deps.startIbsrv ?? startIbsrv)(
                        {
                            platformPath,
                            dbPath: params.dbPath,
                            readyTimeoutMs: params.readyTimeoutMs,
                            onSpawned: (resource) => {
                                ctx.setIbsrv(resource.proc, resource.port, params.dbPath!, resource.dataDir);
                            },
                        },
                        this.deps.outputChannel,
                    );
                    // Test seams and older compatible launchers may not invoke
                    // onSpawned; adopt their successful result before continuing.
                    if (ctx.ibsrvProc !== result.proc) {
                        ctx.setIbsrv(result.proc, result.port, params.dbPath, result.dataDir);
                    }
                    targetUrl = result.url;
                    ibsrvSpawned = true;
                }

                await (this.deps.ensureChromiumInstalled ?? ensureChromiumInstalled)(this.deps.extensionPath);
                const scriptResult = await this.runScript({
                    command: 'start',
                    args: [targetUrl],
                    timeoutMs: params.readyTimeoutMs ?? 60_000,
                    detachOnReady: (stdout) => /"message":\s*"Browser ready"/.test(stdout),
                });
                if (scriptResult.unclosedProc) {
                    ctx.setBrowserProc(scriptResult.unclosedProc, async () => {
                        throw new Error('forms runner timed out before browser readiness');
                    });
                }
                if (scriptResult.exitCode !== 0 || !scriptResult.detachedProc) {
                    throw new Error(
                        scriptResult.exitCode !== 0
                            ? `run.mjs start завершился с кодом ${scriptResult.exitCode}. stderr: ${scriptResult.stderr}`
                            : 'run.mjs start завершился до подтверждения готовности browser session.',
                    );
                }
                ctx.setBrowserProc(scriptResult.detachedProc, async () => {
                    const stopResult = await this.runShortScript({ command: 'stop', args: [] });
                    if (stopResult.exitCode !== 0) {
                        throw new Error(`run.mjs stop завершился с кодом ${stopResult.exitCode}`);
                    }
                });

                return {
                    success: true,
                    data: {
                        url: targetUrl,
                        ibsrvSpawned,
                        uiAccessHint:
                            `Браузер подключён к ${targetUrl}. ` +
                            `Для работы с формами используйте forms.exec (BSL-скрипт) ` +
                            `или forms.shot (скриншот).`,
                    },
                };
            } catch (err) {
                const cleanup = await ctx.stop();
                const error = err instanceof Error ? err.message : String(err);
                const cleanupSuffix = cleanup.errors.length > 0
                    ? ` Cleanup: ${cleanup.errors.join('; ')}`
                    : '';
                return { success: false, error: error + cleanupSuffix };
            }
        });
    }

    // ─── formsExec ────────────────────────────────────────────────────────────

    /**
     * Выполняет BSL-скрипт в активной сессии браузера форм 1С.
     * Скрипт передаётся через stdin (run.mjs exec -).
     */
    async formsExec(params: FormsExecParams): Promise<AgentResult<FormsExecResult>> {
        if (!params.script) {
            return { success: false, error: 'параметр script обязателен' };
        }
        return this.context.runExclusive(async () => {
            try {
                const result = await this.runShortScript({
                    command: 'exec',
                    args: ['-'],
                    stdin: params.script,
                    timeoutMs: params.timeoutMs,
                });

                if (result.exitCode !== 0) {
                    return {
                        success: false,
                        error: `run.mjs exec завершился с кодом ${result.exitCode}. stderr: ${result.stderr}`,
                    };
                }

                return {
                    success: true,
                    data: {
                        output: result.output,
                        stderr: result.stderr || undefined,
                        exitCode: result.exitCode,
                    },
                };
            } catch (err) {
                return { success: false, error: err instanceof Error ? err.message : String(err) };
            }
        });
    }

    // ─── formsStop ────────────────────────────────────────────────────────────

    /**
     * Останавливает браузерную сессию и ibsrv (если был запущен нами).
     */
    async formsStop(_params: FormsStopParams): Promise<AgentResult<FormsStopResult>> {
        return this.context.runExclusive(async () => {
            const outcome = await this.context.stop();
            return outcome.errors.length === 0
                ? { success: true, data: {} }
                : { success: false, error: outcome.errors.join('; ') };
        });
    }

    // ─── formsShot ────────────────────────────────────────────────────────────

    /**
     * Делает скриншот активной формы 1С и сохраняет в PNG.
     */
    async formsShot(params: FormsShotParams): Promise<AgentResult<FormsShotResult>> {
        return this.context.runExclusive(async () => {
          try {
            const file = params.file ?? path.join(
                os.tmpdir(),
                `forms-shot-${Date.now()}.png`,
            );

            const result = await this.runShortScript({
                command: 'shot',
                args: [file],
            });

            if (result.exitCode !== 0) {
                return {
                    success: false,
                    error: `run.mjs shot завершился с кодом ${result.exitCode}. stderr: ${result.stderr}`,
                };
            }

            return { success: true, data: { file } };
          } catch (err) {
              return { success: false, error: err instanceof Error ? err.message : String(err) };
          }
        });
    }

    // ─── formsStatus ──────────────────────────────────────────────────────────

    /**
     * Проверяет статус браузерной сессии и ibsrv.
     */
    async formsStatus(_params: FormsStatusParams): Promise<AgentResult<FormsStatusResult>> {
        return this.context.runExclusive(async () => {
          try {
            const ctx = this.context;
            const ibsrvAlive = ctx.isIbsrvAlive();
            const ibsrvPid = ibsrvAlive ? (ctx.ibsrvProc?.pid ?? undefined) : undefined;

            // Спрашиваем run.mjs о состоянии браузера
            const result = await this.runShortScript({
                command: 'status',
                args: [],
                timeoutMs: 5_000,
            });

            // run.mjs status: exit 0 — браузер жив, exit != 0 — нет сессии
            const browserAlive = result.exitCode === 0;

            // Пробуем извлечь url из вывода (run.mjs status печатает JSON или текст)
            let url: string | undefined;
            try {
                const parsed = JSON.parse(result.output.trim()) as Record<string, unknown>;
                if (typeof parsed.url === 'string') {
                    url = parsed.url;
                }
            } catch {
                // plain text output — не JSON
            }

            return {
                success: true,
                data: { browserAlive, url, ibsrvAlive, ibsrvPid },
            };
          } catch (err) {
              return { success: false, error: err instanceof Error ? err.message : String(err) };
          }
        });
    }
}
