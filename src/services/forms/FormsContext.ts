// Extension-scoped owner for the active native TestClient connection.

import type { NativeFormsSession } from './nativeFormsSession';

export interface FormsStopOutcome {
    errors: string[];
}

export class FormsContext {
    private static _instance: FormsContext | undefined;

    static get(): FormsContext {
        if (!FormsContext._instance) {
            FormsContext._instance = new FormsContext();
        }
        return FormsContext._instance;
    }

    private lifecycleQueue: Promise<void> = Promise.resolve();
    nativeSession?: NativeFormsSession;

    runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.lifecycleQueue.then(operation, operation);
        this.lifecycleQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    setNativeSession(session: NativeFormsSession): void {
        if (this.nativeSession?.connected) {
            throw new Error('A native TestClient session is already owned by this context.');
        }
        this.nativeSession = session;
    }

    clearNativeSession(): void {
        this.nativeSession = undefined;
    }

    async stop(): Promise<FormsStopOutcome> {
        const session = this.nativeSession;
        if (!session) {
            return { errors: [] };
        }

        try {
            await session.close();
        } catch (error) {
            if (!session.connected) {
                this.clearNativeSession();
            }
            return { errors: [`native TestClient connection: ${toErrorMessage(error)}`] };
        }

        if (session.connected) {
            return { errors: ['native TestClient socket remained connected after close'] };
        }
        this.clearNativeSession();
        return { errors: [] };
    }

    async dispose(): Promise<void> {
        const outcome = await this.runExclusive(() => this.stop());
        if (outcome.errors.length > 0) {
            throw new Error(`Forms cleanup failed: ${outcome.errors.join('; ')}`);
        }
    }
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
