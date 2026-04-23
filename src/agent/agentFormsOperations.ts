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
import { startIbsrv, stopIbsrv } from '../services/forms/FormsIbsrvLauncher';
import { runFormsScript } from '../services/forms/runFormsScript';
import { ensureChromiumInstalled } from '../services/forms/chromiumInstaller';

/** Зависимости для FormsOperations. */
export interface FormsOperationsDeps {
    /** extensionContext.extensionPath */
    extensionPath: string;
    /** Output channel для логов. */
    outputChannel: vscode.OutputChannel;
}

/** Класс операций Agent Forms API. */
export class FormsOperations {
    constructor(private readonly deps: FormsOperationsDeps) {}

    // ─── formsStart ───────────────────────────────────────────────────────────

    /**
     * Запускает браузерную сессию форм 1С.
     * Если задан dbPath — сначала поднимает ibsrv, потом подключает playwright.
     * Если задан url — подключается напрямую.
     */
    async formsStart(params: FormsStartParams): Promise<AgentResult<FormsStartResult>> {
        try {
            // Resolve target URL
            let targetUrl: string;
            let ibsrvSpawned = false;

            if (params.url) {
                targetUrl = params.url;
            } else if (params.dbPath) {
                // Нужен ibsrv
                const platformPath = params.platformPath
                    ?? vscode.workspace.getConfiguration('1cMetadataTree').get<string>('platformPath');

                if (!platformPath) {
                    return {
                        success: false,
                        error: 'platformPath не задан (ни в параметрах, ни в настройках 1cMetadataTree.platformPath)',
                    };
                }

                const ctx = FormsContext.get();
                const result = await startIbsrv(
                    {
                        platformPath,
                        dbPath: params.dbPath,
                        readyTimeoutMs: params.readyTimeoutMs,
                    },
                    this.deps.outputChannel,
                );

                ctx.setIbsrv(result.proc, result.port, params.dbPath, result.dataDir);
                targetUrl = result.url;
                ibsrvSpawned = true;
            } else {
                return { success: false, error: 'Необходимо указать url или dbPath' };
            }

            // Убедимся что chromium установлен
            await ensureChromiumInstalled(this.deps.extensionPath);

            // run.mjs start вешает HTTP-сервер и НЕ завершается сам — ждём ready-маркер в stdout
            // и оставляем процесс жить (detachOnReady → unref).
            const scriptResult = await runFormsScript({
                extensionPath: this.deps.extensionPath,
                command: 'start',
                args: [targetUrl],
                timeoutMs: params.readyTimeoutMs ?? 60_000,
                detachOnReady: (stdout) => /"message":\s*"Browser ready"/.test(stdout),
            });

            if (scriptResult.exitCode !== 0) {
                return {
                    success: false,
                    error: `run.mjs start завершился с кодом ${scriptResult.exitCode}. stderr: ${scriptResult.stderr}`,
                };
            }

            // Сохраняем proc в FormsContext чтобы formsStop мог его потом убить
            if (scriptResult.detachedProc) {
                FormsContext.get().setBrowserProc(scriptResult.detachedProc);
            }

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
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    // ─── formsExec ────────────────────────────────────────────────────────────

    /**
     * Выполняет BSL-скрипт в активной сессии браузера форм 1С.
     * Скрипт передаётся через stdin (run.mjs exec -).
     */
    async formsExec(params: FormsExecParams): Promise<AgentResult<FormsExecResult>> {
        try {
            if (!params.script) {
                return { success: false, error: 'параметр script обязателен' };
            }

            const result = await runFormsScript({
                extensionPath: this.deps.extensionPath,
                command: 'exec',
                args: ['-'],
                stdin: params.script,
                timeoutMs: params.timeoutMs,
            });

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
    }

    // ─── formsStop ────────────────────────────────────────────────────────────

    /**
     * Останавливает браузерную сессию и ibsrv (если был запущен нами).
     */
    async formsStop(_params: FormsStopParams): Promise<AgentResult<FormsStopResult>> {
        try {
            // Сначала закрываем браузер через run.mjs stop
            await runFormsScript({
                extensionPath: this.deps.extensionPath,
                command: 'stop',
                args: [],
            });

            // Затем останавливаем ibsrv если был запущен нами
            const ctx = FormsContext.get();
            if (ctx.ibsrvProc) {
                await stopIbsrv(ctx.ibsrvProc);
                ctx.clearIbsrv();
            }

            return { success: true, data: {} };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    // ─── formsShot ────────────────────────────────────────────────────────────

    /**
     * Делает скриншот активной формы 1С и сохраняет в PNG.
     */
    async formsShot(params: FormsShotParams): Promise<AgentResult<FormsShotResult>> {
        try {
            const file = params.file ?? path.join(
                os.tmpdir(),
                `forms-shot-${Date.now()}.png`,
            );

            const result = await runFormsScript({
                extensionPath: this.deps.extensionPath,
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
    }

    // ─── formsStatus ──────────────────────────────────────────────────────────

    /**
     * Проверяет статус браузерной сессии и ibsrv.
     */
    async formsStatus(_params: FormsStatusParams): Promise<AgentResult<FormsStatusResult>> {
        try {
            const ctx = FormsContext.get();
            const ibsrvAlive = ctx.isIbsrvAlive();
            const ibsrvPid = ibsrvAlive ? (ctx.ibsrvProc?.pid ?? undefined) : undefined;

            // Спрашиваем run.mjs о состоянии браузера
            const result = await runFormsScript({
                extensionPath: this.deps.extensionPath,
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
    }
}
