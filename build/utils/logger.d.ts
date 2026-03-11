/**
 * Logger utility for the extension
 */
export declare class Logger {
    private static outputChannel;
    static initialize(): void;
    static info(message: string, ...args: unknown[]): void;
    static warn(message: string, ...args: unknown[]): void;
    static error(message: string, error?: Error | unknown): void;
    static debug(message: string, ...args: unknown[]): void;
    private static log;
    static show(): void;
}
//# sourceMappingURL=logger.d.ts.map