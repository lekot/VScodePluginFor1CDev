let vscode: any;
try {
  vscode = require('vscode');
} catch {
  vscode = null;
}

/** Minimum level to output. In production use 'info' or higher so debug is not written. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const MAX_BUFFER_LINES = 10000;

/**
 * Logger utility for the extension
 */
export class Logger {
  private static outputChannel: { appendLine: (s: string) => void; show: () => void } | null = null;
  private static minLevel: LogLevel = 'info';
  private static buffer: string[] = [];

  static setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  static initialize(): void {
    try {
      if (vscode && vscode.window) {
        this.outputChannel = vscode.window.createOutputChannel('1C Metadata Tree');
      }
      this.buffer = [];
    } catch {
      // vscode not available (e.g., in tests)
      this.outputChannel = null;
    }
  }

  /**
   * Returns buffered log content for export (e.g. to file).
   */
  static getBufferedContent(): string {
    return this.buffer.length > 0 ? this.buffer.join('\n') : '';
  }

  static info(message: string, ...args: unknown[]): void {
    this.log('INFO', message, args);
  }

  static warn(message: string, ...args: unknown[]): void {
    this.log('WARN', message, args);
  }

  static error(message: string, error?: Error | unknown): void {
    const errorStr = error instanceof Error ? error.message : String(error);
    this.log('ERROR', message, [errorStr]);
  }

  static debug(message: string, ...args: unknown[]): void {
    this.log('DEBUG', message, args);
  }

  private static log(level: string, message: string, args: unknown[]): void {
    const levelOrder = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
    const minOrder = levelOrder[this.minLevel.toUpperCase() as keyof typeof levelOrder] ?? 1;
    const currentOrder = levelOrder[level as keyof typeof levelOrder] ?? 1;
    if (currentOrder < minOrder) {
      return;
    }

    const timestamp = new Date().toISOString();
    const argsStr = args.length > 0 ? ` ${JSON.stringify(args)}` : '';
    const logMessage = `[${timestamp}] [${level}] ${message}${argsStr}`;

    if (this.outputChannel) {
      this.outputChannel.appendLine(logMessage);
    }
    if (this.buffer.length >= 0) {
      this.buffer.push(logMessage);
      if (this.buffer.length > MAX_BUFFER_LINES) {
        this.buffer.shift();
      }
    }

    if (level === 'ERROR') {
      console.error(logMessage);
    } else {
      console.log(logMessage);
    }
  }

  static show(): void {
    if (this.outputChannel) {
      this.outputChannel.show();
    }
  }
}
