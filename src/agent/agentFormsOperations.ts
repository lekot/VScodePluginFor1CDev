// Agent Forms API — operations for an already-running native 1C TestClient.

import * as os from 'os';
import * as path from 'path';
import type { CancellationToken } from 'vscode';
import type { AgentResult } from './types';
import type {
    FormsDiscoverParams,
    FormsDiscoverResult,
    FormsLaunchFailureResult,
    FormsLaunchParams,
    FormsLaunchResult,
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
import type { InfobaseStorageService } from '../infobases/infobaseStorageService';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';
import {
    NativeTestClientLaunchError,
    NativeTestClientLifecycleService,
    type NativeTestClientLaunchHandle,
} from '../services/forms/nativeTestClientLifecycle';

const START_ALLOWED_KEYS = new Set(['driver', 'port', 'host', 'platformVersion', 'background']);
const NATIVE_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 90_000;
const MAX_LAUNCH_TIMEOUT_MS = 120_000;
const NATIVE_CONNECT_RETRY_MS = 500;

/** Dependencies for FormsOperations; seams keep native lifecycle behavior testable. */
export interface FormsOperationsDeps {
    context?: FormsContext;
    connectNativeClient?: NativeFormsConnector;
    captureNativeScreenshot?: typeof captureNativeTestClientScreenshot;
    infobaseStorage?: Pick<InfobaseStorageService, 'getById' | 'readPasswordSecret'> | null;
    getConfiguredPlatformPath?: () => string;
    testClientLifecycle?: Pick<NativeTestClientLifecycleService, 'discover' | 'start' | 'stop'>;
    now?: () => number;
    delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export class FormsOperations {
    constructor(private readonly deps: FormsOperationsDeps = {}) {}

    private get context(): FormsContext {
        return this.deps.context ?? FormsContext.get();
    }

    private get testClientLifecycle(): Pick<NativeTestClientLifecycleService, 'discover' | 'start' | 'stop'> {
        return this.deps.testClientLifecycle ?? new NativeTestClientLifecycleService({
            getConfiguredPlatformPath: this.deps.getConfiguredPlatformPath,
        });
    }

    async formsDiscover(
        params: FormsDiscoverParams = {},
        token?: CancellationToken,
    ): Promise<AgentResult<FormsDiscoverResult>> {
        if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length > 0) {
            return { success: false, code: 'INVALID_ARGUMENTS', error: 'forms.discover не принимает параметры.' };
        }
        if (token?.isCancellationRequested) {
            return { success: false, code: 'REQUEST_CANCELLED', error: 'Поиск TestClient отменён до запуска.' };
        }
        const controller = new AbortController();
        const cancellation = token?.onCancellationRequested(() => controller.abort());
        try {
            const clients = await this.testClientLifecycle.discover(controller.signal);
            return { success: true, data: { clients } };
        } catch (error) {
            const failure = error instanceof NativeTestClientLaunchError ? error : undefined;
            return {
                success: false,
                code: failure?.code ?? 'TESTCLIENT_DISCOVERY_FAILED',
                error: failure?.message ?? (error instanceof Error ? error.message : String(error)),
            };
        } finally {
            cancellation?.dispose();
        }
    }

    async formsLaunch(
        params: FormsLaunchParams,
        token?: CancellationToken,
        reportStage?: (message: string) => void,
    ): Promise<AgentResult<FormsLaunchResult | FormsLaunchFailureResult>> {
        const validationError = validateFormsLaunchParams(params);
        if (validationError) {
            return { success: false, code: 'INVALID_ARGUMENTS', error: validationError };
        }
        if (token?.isCancellationRequested) {
            return { success: false, code: 'REQUEST_CANCELLED', error: 'Запуск TestClient отменён до старта.' };
        }

        let entry: InfobaseEntry;
        let user: string | undefined;
        let password: string | undefined;
        if (params.infobaseId) {
            const storage = this.deps.infobaseStorage;
            if (!storage) {
                return { success: false, code: 'INFOBASE_STORAGE_UNAVAILABLE', error: 'Каталог информационных баз не инициализирован.' };
            }
            try {
                const found = await storage.getById(params.infobaseId.trim());
                if (!found) {
                    return { success: false, code: 'INFOBASE_NOT_FOUND', error: `Информационная база «${params.infobaseId}» не найдена в каталоге.` };
                }
                if (found.type === 'web') {
                    return { success: false, code: 'INFOBASE_TYPE_UNSUPPORTED', error: 'Для forms.launch поддерживаются только файловые и серверные информационные базы.' };
                }
                entry = found;
                if (found.type === 'server' && found.user?.trim()) {
                    user = found.user.trim();
                    if (found.hasStoredPassword) {
                        password = await storage.readPasswordSecret(found.id);
                    }
                }
            } catch (error) {
                return { success: false, code: 'INFOBASE_READ_FAILED', error: `Не удалось прочитать запись базы: ${toErrorMessage(error)}` };
            }
        } else {
            entry = {
                id: 'mcp-explicit-file-path',
                name: 'Explicit file infobase',
                type: 'file',
                filePath: params.dbPath!.trim(),
                hasStoredPassword: false,
                createdAt: new Date().toISOString(),
            };
        }

        const controller = new AbortController();
        const cancellation = token?.onCancellationRequested(() => controller.abort());
        try {
            return await this.context.runExclusive(async () => {
                const cleanup = await this.context.stop();
                if (cleanup.errors.length > 0) {
                    return { success: false, code: 'FORMS_SESSION_CLEANUP_FAILED', error: cleanup.errors.join('; ') };
                }
                if (token?.isCancellationRequested) {
                    return { success: false, code: 'REQUEST_CANCELLED', error: 'Запуск TestClient отменён до старта.' };
                }

                let handle: NativeTestClientLaunchHandle | undefined;
                let session: Awaited<ReturnType<NativeFormsConnector>> | undefined;
                const lifecycle = this.testClientLifecycle;
                try {
                    const waitTimeoutMs = params.waitTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
                    const now = this.deps.now ?? Date.now;
                    const deadline = now() + waitTimeoutMs;
                    handle = await lifecycle.start({
                        entry,
                        user,
                        password,
                        platformPath: params.platformPath,
                        port: params.port,
                        waitTimeoutMs,
                    }, controller.signal, reportStage);
                    if (token?.isCancellationRequested) {
                        return launchCleanupFailure(
                            lifecycle,
                            handle,
                            undefined,
                            'Запуск TestClient отменён после старта.',
                            'REQUEST_CANCELLED',
                        );
                    }

                    session = await connectNativeUntilReady(
                        this.deps.connectNativeClient ?? connectNativeTestClient,
                        {
                            host: '127.0.0.1',
                            port: handle.port,
                            platformVersion: handle.platformVersion,
                            timeoutMs: NATIVE_CONNECT_TIMEOUT_MS,
                        },
                        controller.signal,
                        deadline,
                        waitTimeoutMs,
                        now,
                        this.deps.delay ?? delay,
                        reportStage,
                    );
                    if (token?.isCancellationRequested) {
                        return launchCleanupFailure(
                            lifecycle,
                            handle,
                            session,
                            'Подключение к TestClient отменено после старта процесса.',
                            'REQUEST_CANCELLED',
                        );
                    }

                    this.context.setNativeSession(session);
                    return {
                        success: true,
                        data: {
                            pid: handle.pid,
                            port: handle.port,
                            host: session.host,
                            driver: 'native',
                            platformVersion: handle.platformVersion,
                            connection: 'connected',
                            uiAccessHint: 'Используйте forms.native для чтения формы, команд, таблиц, снимков состояния и UI log. forms.shot снимает окно локального TestClient на Windows.',
                        },
                    };
                } catch (error) {
                    const reason = token?.isCancellationRequested
                        ? 'Запуск TestClient отменён.'
                        : toErrorMessage(error);
                    if (!handle) {
                        const failure = error instanceof NativeTestClientLaunchError ? error : undefined;
                        return {
                            success: false,
                            ...(failure?.code ? { code: failure.code } : { code: 'TESTCLIENT_LAUNCH_FAILED' }),
                            ...(failure?.pid || failure?.port ? {
                                data: {
                                    status: failure.processStatus === 'unknown' ? 'inDoubt' as const : 'failed' as const,
                                    effectPossible: failure.processStatus === 'unknown',
                                    ...(failure.pid ? { pid: failure.pid } : {}),
                                    ...(failure.port ? { port: failure.port } : {}),
                                    ...(failure.processStatus ? { processStatus: failure.processStatus } : {}),
                                },
                            } : {}),
                            error: `${reason}${failure?.message && failure.message !== reason ? ` ${failure.message}` : ''}`,
                        };
                    }
                    return launchCleanupFailure(
                        lifecycle,
                        handle,
                        session,
                        reason,
                        token?.isCancellationRequested ? 'REQUEST_CANCELLED' : 'FORMS_LAUNCH_FAILED',
                    );
                }
            });
        } finally {
            cancellation?.dispose();
        }
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

function validateFormsLaunchParams(value: unknown): string | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return 'Параметры forms.launch должны быть объектом.';
    }
    const params = value as Record<string, unknown>;
    const allowedKeys = new Set(['dbPath', 'infobaseId', 'platformPath', 'port', 'waitTimeoutMs', 'background']);
    const unsupported = Object.keys(params).filter((key) => !allowedKeys.has(key));
    if (unsupported.length > 0) {
        return `Неизвестные параметры forms.launch: ${unsupported.join(', ')}.`;
    }
    const hasDbPath = typeof params.dbPath === 'string' && params.dbPath.trim().length > 0;
    const hasInfobaseId = typeof params.infobaseId === 'string' && params.infobaseId.trim().length > 0;
    if (Number(hasDbPath) + Number(hasInfobaseId) !== 1) {
        return 'Укажите ровно один источник: dbPath файловой базы или infobaseId базы из каталога.';
    }
    for (const field of ['dbPath', 'infobaseId', 'platformPath'] as const) {
        if (params[field] !== undefined && (typeof params[field] !== 'string' || params[field].trim().length === 0)) {
            return `${field} должен быть непустой строкой.`;
        }
    }
    if (params.port !== undefined && (!Number.isInteger(params.port) || (params.port as number) < 1 || (params.port as number) > 65535)) {
        return 'port должен быть целым числом от 1 до 65535.';
    }
    if (params.waitTimeoutMs !== undefined && (
        !Number.isInteger(params.waitTimeoutMs)
        || (params.waitTimeoutMs as number) < 1_000
        || (params.waitTimeoutMs as number) > MAX_LAUNCH_TIMEOUT_MS
    )) {
        return `waitTimeoutMs должен быть целым числом от 1000 до ${MAX_LAUNCH_TIMEOUT_MS} мс.`;
    }
    if (params.background !== undefined && typeof params.background !== 'boolean') {
        return 'background должен быть логическим значением.';
    }
    return undefined;
}

async function connectNativeUntilReady(
    connect: NativeFormsConnector,
    options: Parameters<NativeFormsConnector>[0],
    signal: AbortSignal,
    deadline: number,
    waitTimeoutMs: number,
    now: () => number,
    wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
    reportStage?: (message: string) => void,
): Promise<Awaited<ReturnType<NativeFormsConnector>>> {
    let attempts = 0;
    let lastError: unknown;
    reportStage?.(`Ожидание готовности native TestClient на порту ${options.port}; подтвердите возможные диалоги 1С.`);

    while (now() < deadline) {
        if (signal.aborted) {
            throw new NativeTestClientLaunchError('Подключение к TestClient отменено.', 'REQUEST_CANCELLED');
        }
        const remainingMs = deadline - now();
        attempts += 1;
        try {
            return await connect({
                ...options,
                timeoutMs: Math.max(1, Math.min(NATIVE_CONNECT_TIMEOUT_MS, remainingMs)),
            }, signal);
        } catch (error) {
            if (signal.aborted) {throw error;}
            lastError = error;
            const retryDelay = Math.min(NATIVE_CONNECT_RETRY_MS, deadline - now());
            if (retryDelay <= 0) {break;}
            await wait(retryDelay, signal);
        }
    }

    const lastErrorMessage = lastError ? ` Последняя ошибка подключения: ${toErrorMessage(lastError)}.` : '';
    throw new Error(
        `TestClient на порту ${options.port} не принял native-подключение за ${waitTimeoutMs} мс (${attempts} попыток). `
        + `Клиент мог ожидать подтверждения в окне 1С, входа пользователя или завершения запуска.${lastErrorMessage}`,
    );
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(new NativeTestClientLaunchError('Подключение к TestClient отменено.', 'REQUEST_CANCELLED'));
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', cancel);
            resolve();
        }, milliseconds);
        const cancel = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
            reject(new NativeTestClientLaunchError('Подключение к TestClient отменено.', 'REQUEST_CANCELLED'));
        };
        signal?.addEventListener('abort', cancel, { once: true });
    });
}

async function launchCleanupFailure(
    lifecycle: Pick<NativeTestClientLifecycleService, 'stop'>,
    handle: NativeTestClientLaunchHandle,
    session: Awaited<ReturnType<NativeFormsConnector>> | undefined,
    error: string,
    requestedCode: string,
): Promise<AgentResult<FormsLaunchFailureResult>> {
    let socketMayRemain = false;
    let closeError: string | undefined;
    if (session) {
        try {
            await session.close();
            socketMayRemain = session.connected;
        } catch (failure) {
            closeError = toErrorMessage(failure);
            socketMayRemain = true;
        }
    }
    let processStatus: 'stopped' | 'unknown';
    try {
        processStatus = await lifecycle.stop(handle);
    } catch {
        processStatus = 'unknown';
    }
    const effectPossible = processStatus === 'unknown' || socketMayRemain;
    const code = effectPossible && requestedCode !== 'REQUEST_CANCELLED'
        ? 'FORMS_LAUNCH_IN_DOUBT'
        : requestedCode;
    const status = effectPossible ? 'inDoubt' : 'failed';
    const suffix = processStatus === 'stopped'
        ? `Запущенный процесс ${handle.pid} остановлен.`
        : `Процесс может оставаться запущенным; PID ${handle.pid}, порт ${handle.port}.`;
    const socketSuffix = closeError
        ? ` Не удалось закрыть подключение TestClient: ${closeError}.`
        : socketMayRemain ? ' Состояние подключения TestClient не подтверждено.' : '';
    return {
        success: false,
        code,
        data: {
            status,
            effectPossible,
            pid: handle.pid,
            port: handle.port,
            processStatus,
        },
        error: `${error} ${suffix}${socketSuffix}`,
    };
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
