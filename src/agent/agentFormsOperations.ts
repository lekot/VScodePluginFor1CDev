// Agent Forms API — operations for an already-running native 1C TestClient.

import * as os from 'os';
import * as path from 'path';
import type { CancellationToken } from 'vscode';
import type { AgentResult } from './types';
import type {
    FormsStartParams,
    FormsStartResult,
    FormsStartInDoubtResult,
    FormsOperationInDoubtResult,
    FormsStopParams,
    FormsStopResult,
    FormsShotParams,
    FormsShotResult,
    FormsStatusParams,
    FormsStatusResult,
    NativeFormsAction,
    NativeFormsActionResult,
    NativeFormsCommandParams,
} from './agentFormsTypes';
import { FormsContext } from '../services/forms/FormsContext';
import type { NativeFormsConnector } from '../services/forms/nativeFormsSession';
import { connectNativeTestClient } from '../services/forms/nativeTestClient';
import { captureNativeTestClientScreenshot } from '../services/forms/nativeScreenshot';

const START_ALLOWED_KEYS = new Set(['driver', 'port', 'host', 'platformVersion', 'background']);
const NATIVE_CONNECT_TIMEOUT_MS = 15_000;

/** Dependencies for FormsOperations; seams keep native lifecycle behavior testable. */
export interface FormsOperationsDeps {
    context?: FormsContext;
    connectNativeClient?: NativeFormsConnector;
    captureNativeScreenshot?: typeof captureNativeTestClientScreenshot;
}

export class FormsOperations {
    constructor(private readonly deps: FormsOperationsDeps = {}) {}

    private get context(): FormsContext {
        return this.deps.context ?? FormsContext.get();
    }

    async formsStart(
        params: FormsStartParams,
        token?: CancellationToken,
        reportStage?: (message: string) => void,
    ): Promise<AgentResult<FormsStartResult | FormsStartInDoubtResult>> {
        if (!params || typeof params !== 'object' || Array.isArray(params)) {
            return { success: false, error: 'Параметры forms.start должны быть объектом.' };
        }
        const unsupportedKeys = Object.keys(params).filter((key) => !START_ALLOWED_KEYS.has(key));
        if (unsupportedKeys.length > 0) {
            return {
                success: false,
                error: `Неизвестные параметры forms.start: ${unsupportedKeys.join(', ')}. Поддерживается только подключение к native TestClient.`,
            };
        }
        if (params.driver !== undefined && params.driver !== 'native') {
            return { success: false, error: 'Поддерживается только driver="native".' };
        }
        if (!Number.isInteger(params.port) || params.port < 1 || params.port > 65535) {
            return { success: false, error: 'Для forms.start требуется port от 1 до 65535.' };
        }
        if (params.host !== undefined && typeof params.host !== 'string') {
            return { success: false, error: 'host должен быть строкой.' };
        }
        if (params.platformVersion !== undefined && typeof params.platformVersion !== 'string') {
            return { success: false, error: 'platformVersion должен быть строкой.' };
        }
        if (params.background !== undefined && typeof params.background !== 'boolean') {
            return { success: false, error: 'background должен быть логическим значением.' };
        }
        if (token?.isCancellationRequested) {
            return cancelledBeforeStart();
        }

        const host = params.host?.trim() || '127.0.0.1';
        const connector = this.deps.connectNativeClient ?? connectNativeTestClient;
        const controller = token ? new AbortController() : undefined;
        const cancellation = controller && token
            ? token.onCancellationRequested(() => controller.abort())
            : undefined;

        return this.context.runExclusive(async () => {
            let session: Awaited<ReturnType<NativeFormsConnector>> | undefined;
            try {
                const cleanup = await this.context.stop();
                if (cleanup.errors.length > 0) {
                    return { success: false, error: `Не удалось закрыть предыдущую сессию: ${cleanup.errors.join('; ')}` };
                }
                if (token?.isCancellationRequested) {
                    return cancelledBeforeStart();
                }

                reportStage?.(`Подключение к native TestClient ${host}:${params.port}.`);
                session = await connector({
                    host,
                    port: params.port,
                    platformVersion: params.platformVersion,
                    timeoutMs: NATIVE_CONNECT_TIMEOUT_MS,
                }, controller?.signal);

                if (token?.isCancellationRequested) {
                    await session.close();
                    if (session.connected) {
                        return startInDoubt('Подключение отменено, но сокет TestClient остался открыт.');
                    }
                    return cancelledBeforeStart('Подключение к TestClient отменено; сокет закрыт.');
                }

                this.context.setNativeSession(session);
                return {
                    success: true,
                    data: {
                        driver: 'native',
                        host: session.host,
                        port: session.port,
                        uiAccessHint: 'Используйте forms.native для чтения формы, команд, таблиц, снимков состояния и UI log. forms.shot снимает окно локального TestClient на Windows.',
                    },
                };
            } catch (err) {
                let cleanupError: unknown;
                if (session) {
                    try {
                        await session.close();
                    } catch (closeError) {
                        cleanupError = closeError;
                    }
                }
                const error = err instanceof Error ? err.message : String(err);
                const cleanupSuffix = cleanupError
                    ? ` Ошибка закрытия сокета: ${toErrorMessage(cleanupError)}`
                    : '';
                if (token?.isCancellationRequested) {
                    return startInDoubt(`Отмена подключения к TestClient не подтверждена: ${error}${cleanupSuffix}`);
                }
                return { success: false, error: `${error}${cleanupSuffix}` };
            } finally {
                cancellation?.dispose();
            }
        });
    }

    async formsStop(_params: FormsStopParams): Promise<AgentResult<FormsStopResult>> {
        return this.context.runExclusive(async () => {
            const outcome = await this.context.stop();
            return outcome.errors.length === 0
                ? { success: true, data: {} }
                : { success: false, error: outcome.errors.join('; ') };
        });
    }

    async formsShot(
        params: FormsShotParams,
        token?: CancellationToken,
        reportStage?: (message: string) => void,
    ): Promise<AgentResult<FormsShotResult | FormsOperationInDoubtResult>> {
        if (token?.isCancellationRequested) {
            return cancelledBeforeStart();
        }
        return this.context.runExclusive(async () => {
            const session = this.context.nativeSession;
            if (!session?.connected) {
                return { success: false, error: 'Нет активной native TestClient сессии; сначала вызовите forms.start с port.' };
            }
            if (token?.isCancellationRequested) {
                return cancelledBeforeStart();
            }

            const file = params.file ?? path.join(os.tmpdir(), `forms-shot-${Date.now()}.png`);
            const controller = new AbortController();
            const cancellation = token?.onCancellationRequested(() => controller.abort());
            try {
                reportStage?.('Сохранение скриншота окна TestClient.');
                const result = await (this.deps.captureNativeScreenshot ?? captureNativeTestClientScreenshot)({
                    host: session.host,
                    port: session.port,
                    file,
                    timeoutMs: params.timeoutMs,
                    signal: controller.signal,
                });
                return { success: true, data: { file: result.file } };
            } catch (err) {
                const failure = err as Error & { code?: string };
                if (token?.isCancellationRequested || failure.code === 'NATIVE_SCREENSHOT_CANCELLED') {
                    return cancelledBeforeStart('Снятие скриншота TestClient отменено.');
                }
                return { success: false, error: failure.message ?? String(err) };
            } finally {
                cancellation?.dispose();
            }
        });
    }

    async formsStatus(_params: FormsStatusParams): Promise<AgentResult<FormsStatusResult>> {
        return this.context.runExclusive(async () => {
            const session = this.context.nativeSession;
            return {
                success: true,
                data: session
                    ? {
                        driver: 'native',
                        nativeConnected: session.connected,
                        host: session.host,
                        port: session.port,
                    }
                    : { nativeConnected: false },
            };
        });
    }

    async formsNative(
        params: NativeFormsCommandParams,
        token?: CancellationToken,
        reportStage?: (message: string) => void,
    ): Promise<AgentResult<NativeFormsActionResult | FormsOperationInDoubtResult>> {
        if (token?.isCancellationRequested) {
            return cancelledBeforeStart();
        }
        const { timeoutMs, background, ...action } = params;
        void background;
        if (action.action === 'find' && !action.name && !action.className && !action.text) {
            return { success: false, error: 'forms.native find требует name, className или text.' };
        }

        const controller = token ? new AbortController() : undefined;
        const cancellation = controller && token
            ? token.onCancellationRequested(() => controller.abort())
            : undefined;
        return this.context.runExclusive(async () => {
            try {
                const session = this.context.nativeSession;
                if (!session) {
                    return { success: false, error: 'Нет native TestClient сессии; сначала вызовите forms.start с port.' };
                }
                if (!session.connected) {
                    return { success: false, error: 'Сокет TestClient отключён; подключитесь повторно через forms.start.' };
                }
                reportStage?.(`Выполнение native forms.${action.action}.`);
                const result = await session.execute(action as NativeFormsAction, {
                    timeoutMs: timeoutMs ?? 30_000,
                    signal: controller?.signal,
                });
                return { success: true, data: result };
            } catch (err) {
                const failure = err as Error & { code?: string; effectPossible?: boolean };
                if (failure.code === 'FORMS_OPERATION_IN_DOUBT') {
                    return {
                        success: false,
                        code: 'FORMS_OPERATION_IN_DOUBT',
                        data: { status: 'inDoubt', effectPossible: true },
                        error: failure.message,
                    };
                }
                return { success: false, error: failure.message ?? String(err) };
            } finally {
                cancellation?.dispose();
            }
        });
    }
}

function cancelledBeforeStart(message = 'Операция отменена до подключения к TestClient.'): AgentResult<never> {
    return { success: false, code: 'REQUEST_CANCELLED', error: message };
}

function startInDoubt(error: string): AgentResult<FormsStartInDoubtResult> {
    return {
        success: false,
        code: 'FORMS_START_IN_DOUBT',
        data: { status: 'inDoubt', effectPossible: true },
        error,
    };
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
